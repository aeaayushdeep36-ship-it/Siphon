"""Bounded static-inspection job protocol. Production runs in a fresh E2B image.

No uploaded path is opened and source is never imported/executed. Request bytes
arrive on stdin; stdout contains only the bounded JSON result. Local callers
must use authored fixtures, not real uploads.
"""

import base64
import hashlib
import json
import re
import sys

from .inspection import inspect_source
from .models import InspectionJobRequest, validate_inspection_job_result

# Version 1 protocol ceilings mirror the canonical policy; lower limits travel
# in each request. Shared parity tests guard against accidental divergence.
MAX_REQUEST_BYTES = 200000
MAX_OUTPUT_BYTES = 1000000
UUID = re.compile(
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
    re.I,
)
DIGEST = re.compile(r"^[0-9a-f]{64}$")


def inspect_job(request):
    validated = InspectionJobRequest.model_validate(request)
    request = validated.model_dump(by_alias=True)
    limit = validated.maximum_source_bytes
    sources = request["sources"]
    decoded = []
    # Validate the entire manifest before parsing any source.
    for source in sources:
        encoded = source["sourceBase64"]
        raw = base64.b64decode(encoded, validate=True)
        if hashlib.sha256(raw).hexdigest() != source["sourceDigest"]:
            raise ValueError("source_digest_mismatch")
        decoded.append((source["artifactId"], raw))
    result = {
        "schemaVersion": "1.0",
        "operationId": request["operationId"],
        "inputDigest": request["inputDigest"],
        "sources": [
            {"artifactId": artifact_id, "inspection": inspect_source(raw, maximum_bytes=limit)}
            for artifact_id, raw in decoded
        ],
    }
    return validate_inspection_job_result(result, validated).model_dump(by_alias=True)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def main():
    try:
        payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(payload) > MAX_REQUEST_BYTES:
            raise ValueError("request_limit")
        request = json.loads(payload, object_pairs_hook=_unique_object)
        output = json.dumps(inspect_job(request), separators=(",", ":"), allow_nan=False)
        if len(output.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise ValueError("output_limit")
        sys.stdout.write(output)
        return 0
    except (ValueError, TypeError, RecursionError, MemoryError, OverflowError):
        # Never echo source text, file paths or raw exception messages.
        sys.stdout.write('{"schemaVersion":"1.0","error":"invalid_inspection_job"}')
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
