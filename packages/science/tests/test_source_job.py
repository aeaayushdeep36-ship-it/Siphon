import base64
import hashlib
import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np

from siphon_science.observation_exports import validate_observation_exports
from siphon_science.source_job import SourceJobError, execute_source_job, run_cli


def request_for(source, supporting=None):
    files = []
    for name, raw in [("model.py", source.encode()), *(supporting or [])]:
        files.append(
            {
                "schemaVersion": "1.0",
                "artifactId": str(uuid.uuid4()),
                "path": name,
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "dataBase64": base64.b64encode(raw).decode(),
            }
        )
    return {
        "schemaVersion": "1.0",
        "operationId": str(uuid.uuid4()),
        "inputDigest": "a" * 64,
        "adapterDigest": "b" * 64,
        "entryArtifactId": files[0]["artifactId"],
        "files": files,
        "maximumOutputBytes": 4096,
        "maximumElements": 100,
        "mappings": [
            {
                "key": "times",
                "root": "t",
                "steps": [],
                "expectedShape": [2],
                "axisOrder": [0],
                "declaredUnit": "s",
            },
            {
                "key": "temperature",
                "root": "T",
                "steps": [],
                "expectedShape": [2, 1],
                "axisOrder": [0, 1],
                "declaredUnit": "K",
            },
        ],
    }


SOURCE = "import numpy as np\nt = np.array([0., 1.])\nT = np.array([[3.], [5.]])\n"


class SourceJobTests(unittest.TestCase):
    def test_fixed_launcher_writes_bounded_manifest_instead_of_printing_a_trace(self):
        request = request_for(SOURCE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "job"
            result_path = Path(temporary) / "result.json"
            code = run_cli(
                io.BytesIO(json.dumps(request).encode()), root=root, result_path=result_path
            )
            self.assertEqual(code, 0)
            self.assertEqual(
                json.loads(result_path.read_bytes())["operationId"], request["operationId"]
            )
            self.assertLessEqual(result_path.stat().st_size, 32768)

    def test_source_errors_and_system_exit_are_redacted_nonzero_failures(self):
        for source in ('raise RuntimeError("private-contents")', "raise SystemExit(0)"):
            with tempfile.TemporaryDirectory() as temporary:
                result_path = Path(temporary) / "result.json"
                self.assertEqual(
                    run_cli(
                        io.BytesIO(json.dumps(request_for(source)).encode()),
                        root=Path(temporary) / "job",
                        result_path=result_path,
                    ),
                    2,
                )
                self.assertEqual(
                    json.loads(result_path.read_bytes()),
                    {"schemaVersion": "1.0", "error": "source_job_failed"},
                )

    def test_duplicate_json_keys_and_oversize_request_cannot_execute_source(self):
        for payload in (b'{"secret":1,"secret":2}', b"x" * (8 * 1024**2 + 1)):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "job"
                self.assertEqual(
                    run_cli(
                        io.BytesIO(payload), root=root, result_path=Path(temporary) / "result.json"
                    ),
                    2,
                )
                self.assertFalse(root.exists())

    # All scripts here are small authored fixtures, never actual user uploads.
    def test_reference_launcher_exports_same_authored_arrays_via_separate_extractor(self):
        request = request_for(SOURCE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = execute_source_job(request, root / "original", extraction_kind="reference")
            adapted = execute_source_job(request, root / "adapted", extraction_kind="adapter")
            self.assertEqual(original, adapted)
            for observation in original["observations"]:
                name = observation["filename"]
                np.testing.assert_array_equal(
                    np.load(root / "original" / "observations" / name, allow_pickle=False),
                    np.load(root / "adapted" / "observations" / name, allow_pickle=False),
                )
            with self.assertRaises(SourceJobError):
                execute_source_job(request, root / "invalid", extraction_kind="unknown")

    def test_executes_authored_script_and_exports_hashed_numeric_npy_only(self):
        request = request_for(SOURCE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "job"
            result = execute_source_job(request, root)
            self.assertEqual(result["executionProfile"], "runpy_main_root_v1")
            self.assertEqual(result["adapterDigest"], request["adapterDigest"])
            for observation in result["observations"]:
                path = root / "observations" / observation["filename"]
                self.assertEqual(
                    hashlib.sha256(path.read_bytes()).hexdigest(), observation["sha256"]
                )
                array = np.load(path, allow_pickle=False)
                self.assertEqual(array.dtype, np.dtype("float64"))
                self.assertEqual(list(array.shape), observation["shape"])
            np.testing.assert_array_equal(
                np.load(root / "observations/obs_temperature.npy"), [[3.0], [5.0]]
            )
            payloads = {
                item["filename"]: (root / "observations" / item["filename"]).read_bytes()
                for item in result["observations"]
            }
            validated = validate_observation_exports(
                result,
                payloads,
                operation_id=request["operationId"],
                input_digest=request["inputDigest"],
                adapter_digest=request["adapterDigest"],
                mappings=request["mappings"],
                maximum_bytes=4096,
                maximum_elements=100,
            )
            np.testing.assert_array_equal(validated["temperature"].values, [[3.0], [5.0]])

    def test_preserves_input_bytes_and_supports_relative_numeric_assets(self):
        source = 'import numpy as np\nt = np.array([0., 1.])\nT = np.loadtxt("samples.csv", delimiter=",").reshape(2,1)\n'
        request = request_for(source, [("samples.csv", b"3\n5\n")])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "job"
            execute_source_job(request, root)
            self.assertEqual((root / "input/model.py").read_bytes(), source.encode())
            np.testing.assert_array_equal(
                np.load(root / "observations/obs_temperature.npy"), [[3.0], [5.0]]
            )

    def test_rejects_bad_hash_paths_and_case_collisions_before_creating_workspace(self):
        for kind in ("hash", "path", "case"):
            request = request_for(SOURCE)
            if kind == "hash":
                request["files"][0]["sha256"] = "c" * 64
            if kind == "path":
                request["files"][0]["path"] = "../model.py"
            if kind == "case":
                duplicate = dict(request["files"][0], artifactId=str(uuid.uuid4()), path="MODEL.py")
                request["files"].append(duplicate)
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "job"
                with self.assertRaises(ValueError):
                    execute_source_job(request, root)
                self.assertFalse(root.exists())

    def test_rejects_bad_mapping_before_executing_authored_side_effect(self):
        request = request_for('raise AssertionError("source should not execute")\n')
        request["mappings"][0]["root"] = "t()"
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                execute_source_job(request, Path(temporary) / "job")

    def test_never_reuses_existing_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(FileExistsError):
                execute_source_job(request_for(SOURCE), temporary)

    def test_serialized_budget_includes_npy_headers(self):
        request = request_for(SOURCE)
        request["maximumOutputBytes"] = 40  # Data fit; complete NPY artifacts do not.
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "job"
            with self.assertRaises(SourceJobError):
                execute_source_job(request, root)
            self.assertLessEqual(
                sum(p.stat().st_size for p in (root / "observations").iterdir()), 40
            )

    def test_restores_host_fixture_execution_context_on_source_error(self):
        cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(RuntimeError):
                execute_source_job(
                    request_for('raise RuntimeError("authored failure")'), Path(temporary) / "job"
                )
        self.assertEqual(Path.cwd(), cwd)


if __name__ == "__main__":
    unittest.main()
