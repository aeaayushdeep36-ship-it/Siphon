import base64
import hashlib
import json
import subprocess
import sys
import unittest
import uuid
from pathlib import Path

from siphon_science.inspection_job import inspect_job


def request_for(*sources):
    return {
        "schemaVersion": "1.0",
        "operationId": str(uuid.uuid4()),
        "inputDigest": "a" * 64,
        "maximumSourceBytes": 131072,
        "sources": [
            {
                "artifactId": str(uuid.uuid4()),
                "sourceDigest": hashlib.sha256(raw).hexdigest(),
                "sourceBase64": base64.b64encode(raw).decode("ascii"),
            }
            for raw in sources
        ],
    }


class InspectionJobTests(unittest.TestCase):
    def test_parses_multiple_sources_without_importing_or_running(self):
        request = request_for(
            b"raise RuntimeError('must never run')\n", b"import nonexistent_siphon_fixture_module\n"
        )
        result = inspect_job(request)
        self.assertEqual(result["operationId"], request["operationId"])
        self.assertTrue(all(s["inspection"]["parsed"] for s in result["sources"]))

    def test_hash_mismatch_and_duplicate_artifact(self):
        request = request_for(b"x = 1")
        request["sources"][0]["sourceDigest"] = "b" * 64
        with self.assertRaises(ValueError):
            inspect_job(request)
        request = request_for(b"x = 1")
        request["sources"].append(request["sources"][0])
        with self.assertRaises(ValueError):
            inspect_job(request)

    def test_combined_size_not_just_each_source(self):
        request = request_for(b"x = 1", b"y = 2")
        request["maximumSourceBytes"] = 6
        with self.assertRaises(ValueError):
            inspect_job(request)

    def test_boolean_limit_and_extra_fields_are_rejected(self):
        request = request_for(b"")
        request["maximumSourceBytes"] = True
        with self.assertRaises(ValueError):
            inspect_job(request)
        request = request_for(b"")
        request["path"] = "not accepted"
        with self.assertRaises(ValueError):
            inspect_job(request)

    def test_noncanonical_base64_is_rejected(self):
        request = request_for(b"f")
        request["sources"][0]["sourceBase64"] = "Zh=="
        with self.assertRaises(ValueError):
            inspect_job(request)

    def test_cli_returns_json_and_parse_failure_is_not_a_protocol_failure(self):
        result = subprocess.run(
            [sys.executable, "-m", "siphon_science.inspection_job"],
            cwd=Path(__file__).resolve().parents[1],
            input=json.dumps(request_for(b"def broken(:")).encode(),
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertFalse(json.loads(result.stdout)["sources"][0]["inspection"]["parsed"])

    def test_cli_rejects_duplicate_json_keys_without_echoing_input(self):
        result = subprocess.run(
            [sys.executable, "-m", "siphon_science.inspection_job"],
            cwd=Path(__file__).resolve().parents[1],
            input=b'{"secret":"private-text","secret":1}',
            capture_output=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"private-text", result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "invalid_inspection_job")


if __name__ == "__main__":
    unittest.main()
