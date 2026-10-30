"""Source-sandbox runner. NEVER call with real uploads on a development host.

Production must invoke only inside a fresh, resource-limited, network-denied E2B
source VM. The runner is not a security boundary. Its entire output is untrusted
and must be rehashed/redecoded outside the source VM before scientific use.
"""

import base64
import hashlib
import json
import math
import os
import re
import runpy
import sys
import unicodedata
from pathlib import Path

import numpy as np

from .adapter import extract_observations, validate_mapping_metadata
from .inspection_job import DIGEST, UUID, _unique_object
from .reference_extraction import extract_reference


class SourceJobError(ValueError):
    pass


def _fields(value, expected):
    if type(value) is not dict or set(value) != set(expected):
        raise SourceJobError("invalid_source_job")


def _path(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 240
        or value != unicodedata.normalize("NFC", value)
    ):
        raise SourceJobError("invalid_input_path")
    parts = value.split("/")
    if (
        any(ord(c) < 32 or ord(c) == 127 for c in value)
        or "\\" in value
        or ":" in value
        or not value.endswith((".py", ".csv", ".npy"))
        or any(
            not part
            or part in (".", "..")
            or part[0] == " "
            or part[-1] in ". "
            or re.fullmatch(r"(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?", part, re.I)
            for part in parts
        )
    ):
        raise SourceJobError("invalid_input_path")
    return value


def execute_source_job(request, root, *, extraction_kind="adapter"):
    """Run under declared __main__/root-cwd/entry-only-argv execution semantics.

    No numerical parameter overrides or simulation repairs are performed. This
    profile may differ from a user's customary invocation and requires review.
    root must be a fresh directory chosen by the trusted job launcher.
    """
    if extraction_kind not in ("adapter", "reference"):
        raise SourceJobError("invalid_extraction_kind")
    _fields(
        request,
        (
            "schemaVersion",
            "operationId",
            "inputDigest",
            "adapterDigest",
            "entryArtifactId",
            "files",
            "mappings",
            "maximumOutputBytes",
            "maximumElements",
        ),
    )
    if request["schemaVersion"] != "1.0":
        raise SourceJobError("invalid_source_job")
    validate_mapping_metadata(request["mappings"])
    for key in ("operationId", "entryArtifactId"):
        if not isinstance(request[key], str) or not UUID.fullmatch(request[key]):
            raise SourceJobError("invalid_source_job")
    for key in ("inputDigest", "adapterDigest"):
        if not isinstance(request[key], str) or not DIGEST.fullmatch(request[key]):
            raise SourceJobError("invalid_source_job")
    max_bytes, max_elements = request["maximumOutputBytes"], request["maximumElements"]
    if (
        type(max_bytes) is not int
        or not 1 <= max_bytes <= 50 * 1024**2 - 32768
        or type(max_elements) is not int
        or not 1 <= max_elements <= (50 * 1024**2) // 8
    ):
        raise SourceJobError("invalid_output_budget")
    expected_elements = sum(math.prod(mapping["expectedShape"]) for mapping in request["mappings"])
    if expected_elements > max_elements or expected_elements * 8 > max_bytes:
        raise SourceJobError("expected_observations_exceed_budget")
    files = request["files"]
    if type(files) is not list or not 1 <= len(files) <= 10:
        raise SourceJobError("invalid_source_job")
    decoded, paths, identities = [], set(), set()
    total, source_bytes = 0, 0
    entry = None
    for file in files:
        _fields(file, ("schemaVersion", "artifactId", "path", "bytes", "sha256", "dataBase64"))
        path = _path(file["path"])
        artifact_id = file["artifactId"]
        if (
            file["schemaVersion"] != "1.0"
            or not isinstance(artifact_id, str)
            or not UUID.fullmatch(artifact_id)
            or artifact_id in identities
            or path.casefold() in paths
        ):
            raise SourceJobError("duplicate_or_invalid_input")
        identities.add(artifact_id)
        paths.add(path.casefold())
        size = file["bytes"]
        if (
            type(size) is not int
            or size < 0
            or size > 5 * 1024**2
            or not isinstance(file["dataBase64"], str)
            or len(file["dataBase64"]) > ((size + 2) // 3) * 4
        ):
            raise SourceJobError("input_byte_limit")
        raw = base64.b64decode(file["dataBase64"], validate=True)
        if (
            len(raw) != size
            or base64.b64encode(raw).decode("ascii") != file["dataBase64"]
            or hashlib.sha256(raw).hexdigest() != file["sha256"]
        ):
            raise SourceJobError("input_integrity_failure")
        total += size
        source_bytes += size if path.endswith(".py") else 0
        if total > 5 * 1024**2 or source_bytes > 131072:
            raise SourceJobError("input_byte_limit")
        if artifact_id == request["entryArtifactId"]:
            if not path.endswith(".py"):
                raise SourceJobError("entry_must_be_python")
            entry = path
        decoded.append((path, raw))
    if entry is None:
        raise SourceJobError("entry_missing")
    root = Path(root).absolute()
    root.mkdir(parents=False, exist_ok=False)
    workspace, output = root / "input", root / "observations"
    workspace.mkdir()
    output.mkdir()
    for path, raw in decoded:
        destination = workspace / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as handle:
            handle.write(raw)
    old_cwd, old_argv, old_path = Path.cwd(), sys.argv[:], sys.path[:]
    try:
        os.chdir(workspace)
        sys.argv = [str(workspace / entry)]
        sys.path.insert(0, str((workspace / entry).parent))
        namespace = runpy.run_path(str(workspace / entry), run_name="__main__")
        extractor = extract_reference if extraction_kind == "reference" else extract_observations
        observations = extractor(
            namespace, request["mappings"], maximum_bytes=max_bytes, maximum_elements=max_elements
        )
    finally:
        os.chdir(old_cwd)
        sys.argv, sys.path = old_argv, old_path
    descriptors, retained = [], [0]
    units = {mapping["key"]: mapping["declaredUnit"] for mapping in request["mappings"]}
    for key, values in observations.items():
        filename = "obs_" + key + ".npy"
        target = output / filename
        with target.open("xb") as handle:

            class BoundedWriter:
                def write(self, data):
                    if len(data) > max_bytes - retained[0]:
                        raise SourceJobError("serialized_observation_budget_exceeded")
                    written = handle.write(data)
                    retained[0] += written
                    return written

                def flush(self):
                    handle.flush()

            np.save(BoundedWriter(), values, allow_pickle=False)
        size = target.stat().st_size
        digest = hashlib.sha256()
        with target.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                digest.update(chunk)
        descriptors.append(
            {
                "key": key,
                "filename": filename,
                "sha256": digest.hexdigest(),
                "bytes": size,
                "shape": list(values.shape),
                "dtype": "float64",
                "declaredUnit": units[key],
            }
        )
    return {
        "schemaVersion": "1.0",
        "operationId": request["operationId"],
        "inputDigest": request["inputDigest"],
        "adapterDigest": request["adapterDigest"],
        "executionProfile": "runpy_main_root_v1",
        "observations": descriptors,
    }


def run_cli(input_stream, *, root, result_path, extraction_kind="adapter"):
    """Trusted launcher chooses paths; these are never read from request fields.

    The fixed E2B command redirects all process stdout/stderr to /dev/null.
    Process/resource limits and credential isolation remain provider duties.
    """
    exit_code = 0
    try:
        raw = input_stream.read(8 * 1024**2 + 1)
        if len(raw) > 8 * 1024**2:
            raise SourceJobError("request_byte_limit")
        request = json.loads(raw, object_pairs_hook=_unique_object)
        result = execute_source_job(request, root, extraction_kind=extraction_kind)
        encoded = json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > 32768:
            raise SourceJobError("result_byte_limit")
    except BaseException:
        # Includes SystemExit from uploaded scripts. Never echo a private trace.
        encoded = b'{"schemaVersion":"1.0","error":"source_job_failed"}'
        exit_code = 2
    try:
        with Path(result_path).open("xb") as handle:
            handle.write(encoded)
    except BaseException:
        return 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(
        run_cli(
            sys.stdin.buffer,
            root="/tmp/siphon-source-job",
            result_path="/tmp/siphon-source-result.json",
        )
    )
