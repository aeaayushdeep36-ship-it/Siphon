"""Trusted evaluation operation: data and approved metadata only; no source IO."""

import json
import math
import os
import stat
import sys
from pathlib import Path

from .inspection_job import _unique_object
from .models import ObservationValidationRequest, validate_observation_validation_result
from .numeric_inputs import NumericInputError
from .observation_exports import validate_observation_exports


def _validate_request(request):
    try:
        return ObservationValidationRequest.model_validate(request).model_dump(by_alias=True)
    except ValueError as error:
        # Keep the numeric boundary's stable exception family and redact inputs.
        raise NumericInputError("invalid_validation_job") from error


def validate_observation_job(request, payloads):
    request = _validate_request(request)
    values = validate_observation_exports(
        request["manifest"],
        payloads,
        operation_id=request["sourceOperationId"],
        input_digest=request["inputDigest"],
        adapter_digest=request["adapterDigest"],
        mappings=request["mappings"],
        maximum_bytes=request["maximumBytes"],
        maximum_elements=request["maximumElements"],
    )
    observations = []
    for descriptor in request["manifest"]["observations"]:
        decoded = values[descriptor["key"]]
        observations.append(
            {
                "key": descriptor["key"],
                "sha256": descriptor["sha256"],
                "bytes": descriptor["bytes"],
                "shape": list(decoded.values.shape),
                "dtype": "float64",
                "originalDtype": decoded.original_dtype,
                "conversion": decoded.conversion,
                "declaredUnit": descriptor["declaredUnit"],
                "elements": decoded.values.size,
            }
        )
    report = {
        "schemaVersion": "1.0",
        "evaluationOperationId": request["evaluationOperationId"],
        "sourceOperationId": request["sourceOperationId"],
        "inputDigest": request["inputDigest"],
        "adapterDigest": request["adapterDigest"],
        "validation": "validated_numeric_structure",
        "observations": observations,
        "totalBytes": sum(item["bytes"] for item in observations),
        "totalElements": sum(math.prod(item["shape"]) for item in observations),
    }
    checked = validate_observation_validation_result(
        report, ObservationValidationRequest.model_validate(request)
    )
    return checked.model_dump(by_alias=True), values


def load_numeric_payloads(request, input_directory):
    """Bounded generated-name-only files shared by trusted numeric launchers."""
    request = _validate_request(request)
    descriptors = request["manifest"]["observations"]
    if type(descriptors) is not list or len(descriptors) != len(request["mappings"]):
        raise NumericInputError("invalid_observation_descriptor")
    allowed_keys = {mapping["key"] for mapping in request["mappings"]}
    filenames, total, planned = set(), 0, []
    for descriptor in descriptors:
        if (
            type(descriptor) is not dict
            or type(descriptor.get("key")) is not str
            or descriptor["key"] not in allowed_keys
        ):
            raise NumericInputError("invalid_observation_descriptor")
        filename = "obs_" + descriptor["key"] + ".npy"
        size = descriptor.get("bytes")
        if (
            descriptor.get("filename") != filename
            or filename in filenames
            or type(size) is not int
            or size < 1
        ):
            raise NumericInputError("invalid_observation_descriptor")
        filenames.add(filename)
        total += size
        if total > request["maximumBytes"]:
            raise NumericInputError("observation_export_resource_limit")
        planned.append((filename, size))
    directory = Path(input_directory)
    if (
        directory.is_symlink()
        or not directory.is_dir()
        or {path.name for path in directory.iterdir()} != filenames
    ):
        raise NumericInputError("unexpected_validation_input_files")
    payloads = {}
    for filename, size in planned:
        path = directory / filename
        if not stat.S_ISREG(path.lstat().st_mode):
            raise NumericInputError("invalid_validation_input_file")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise NumericInputError("invalid_validation_input_file")
            payloads[filename] = handle.read(size + 1)
        if len(payloads[filename]) != size:
            raise NumericInputError("observation_export_length_mismatch")
    return payloads


def run_validation_cli(input_stream, *, input_directory, result_path):
    """Fixed numeric-only launcher. Production paths are launcher-owned constants."""
    exit_code = 0
    try:
        raw = input_stream.read(65537)
        if len(raw) > 65536:
            raise NumericInputError("validation_request_byte_limit")
        request = _validate_request(json.loads(raw, object_pairs_hook=_unique_object))
        payloads = load_numeric_payloads(request, input_directory)
        report, _arrays = validate_observation_job(request, payloads)
        encoded = json.dumps(report, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > 32768:
            raise NumericInputError("validation_result_byte_limit")
    except Exception:
        # No uploaded code executes here; redact decoder/OS errors and paths.
        encoded = b'{"schemaVersion":"1.0","error":"numeric_validation_failed"}'
        exit_code = 2
    try:
        with Path(result_path).open("xb") as handle:
            handle.write(encoded)
    except Exception:
        return 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(
        run_validation_cli(
            sys.stdin.buffer,
            input_directory="/tmp/siphon-validation-data",
            result_path="/tmp/siphon-validation-result.json",
        )
    )
