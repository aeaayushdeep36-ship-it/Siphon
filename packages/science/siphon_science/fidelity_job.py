"""Fixed, data-only baseline comparison launcher; no source files are loaded."""

import json
import math
import sys
from pathlib import Path

from .fidelity import compare_validated_baseline_jobs
from .inspection_job import _unique_object
from .numeric_inputs import NumericInputError
from .validation_job import _validate_request, load_numeric_payloads

MAX_BYTES = 50 * 1024**2
MAX_ELEMENTS = MAX_BYTES // 8


def run_fidelity_cli(input_stream, *, original_directory, adapted_directory, result_path):
    """The caller must authorize snapshots and the fresh evaluator separately."""
    exit_code = 0
    try:
        raw = input_stream.read(131073)
        if len(raw) > 131072:
            raise NumericInputError("fidelity_request_byte_limit")
        body = json.loads(raw, object_pairs_hook=_unique_object)
        if type(body) is not dict or set(body) != {"schemaVersion", "original", "adapted"}:
            raise NumericInputError("invalid_fidelity_job")
        if body["schemaVersion"] != "1.0":
            raise NumericInputError("invalid_fidelity_job")
        left, right = _validate_request(body["original"]), _validate_request(body["adapted"])
        descriptors = left["manifest"]["observations"] + right["manifest"]["observations"]
        if (
            sum(item["bytes"] for item in descriptors) > MAX_BYTES
            or sum(math.prod(item["shape"]) for item in descriptors) > MAX_ELEMENTS
        ):
            raise NumericInputError("baseline_resource_limit")
        result = compare_validated_baseline_jobs(
            left,
            load_numeric_payloads(left, original_directory),
            right,
            load_numeric_payloads(right, adapted_directory),
            maximum_total_bytes=MAX_BYTES,
            maximum_total_elements=MAX_ELEMENTS,
        )
        encoded = json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > 32768:
            raise NumericInputError("fidelity_result_byte_limit")
    except Exception:
        encoded = b'{"schemaVersion":"1.0","error":"baseline_comparison_failed"}'
        exit_code = 2
    try:
        with Path(result_path).open("xb") as handle:
            handle.write(encoded)
    except Exception:
        return 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(
        run_fidelity_cli(
            sys.stdin.buffer,
            original_directory="/tmp/siphon-fidelity-original",
            adapted_directory="/tmp/siphon-fidelity-adapted",
            result_path="/tmp/siphon-fidelity-result.json",
        )
    )
