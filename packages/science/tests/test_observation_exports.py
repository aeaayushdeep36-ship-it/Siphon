import copy
import hashlib
import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np

from siphon_science.fidelity import compare_validated_baseline_jobs
from siphon_science.fidelity_job import run_fidelity_cli
from siphon_science.numeric_inputs import NumericInputError, read_npy
from siphon_science.observation_exports import validate_observation_exports
from siphon_science.validation_job import run_validation_cli, validate_observation_job


def bundle(arrays=None):
    arrays = arrays or {"times": np.array([0.0, 1.0]), "temperature": np.array([[3.0], [5.0]])}
    payloads, mappings, descriptors = {}, [], []
    for key, array in arrays.items():
        buffer = io.BytesIO()
        np.save(buffer, array, allow_pickle=True)  # Authored adversarial object fixtures only.
        payload = buffer.getvalue()
        unit = "s" if key == "times" else "K"
        filename = "obs_" + key + ".npy"
        payloads[filename] = payload
        mappings.append(
            {
                "key": key,
                "root": "fixture",
                "steps": [],
                "expectedShape": list(array.shape),
                "axisOrder": list(range(array.ndim)),
                "declaredUnit": unit,
            }
        )
        descriptors.append(
            {
                "key": key,
                "filename": filename,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload),
                "shape": list(array.shape),
                "dtype": "float64",
                "declaredUnit": unit,
            }
        )
    manifest = {
        "schemaVersion": "1.0",
        "operationId": "authored-operation",
        "inputDigest": "a" * 64,
        "adapterDigest": "b" * 64,
        "executionProfile": "runpy_main_root_v1",
        "observations": descriptors,
    }
    return manifest, payloads, mappings


class ObservationExportTests(unittest.TestCase):
    def test_baseline_comparison_revalidates_both_numeric_exports_and_snapshot(self):
        def request(arrays):
            manifest, payloads, mappings = bundle(arrays)
            manifest["operationId"] = str(uuid.uuid4())
            return (
                {
                    "schemaVersion": "1.0",
                    "evaluationOperationId": str(uuid.uuid4()),
                    "sourceOperationId": manifest["operationId"],
                    "inputDigest": manifest["inputDigest"],
                    "adapterDigest": manifest["adapterDigest"],
                    "manifest": manifest,
                    "mappings": mappings,
                    "maximumBytes": 10000,
                    "maximumElements": 100,
                },
                payloads,
            )

        left, left_bytes = request({"times": np.array([0.0, 1.0])})
        right, right_bytes = request({"times": np.array([0.0, 1.0])})

        def compare(a=left, b=right, x=left_bytes, y=right_bytes, **limits):
            return compare_validated_baseline_jobs(
                a,
                x,
                b,
                y,
                maximum_total_bytes=limits.get("bytes", 10000),
                maximum_total_elements=limits.get("elements", 100),
            )

        self.assertEqual(compare()["status"], "matched")
        changed, changed_bytes = request({"times": np.array([0.0, 2.0])})
        self.assertEqual(
            compare(b=changed, y=changed_bytes)["observations"][0]["reason"], "value_mismatch"
        )
        with self.assertRaises(NumericInputError):
            compare(b=left)
        with self.assertRaises(NumericInputError):
            compare(y={"obs_times.npy": b"tampered"})
        with self.assertRaises(NumericInputError):
            compare(elements=3)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, data in (("original", left_bytes), ("adapted", right_bytes)):
                (root / name).mkdir()
                for filename, payload in data.items():
                    (root / name / filename).write_bytes(payload)
            body = {"schemaVersion": "1.0", "original": left, "adapted": right}
            result_path = root / "result.json"
            code = run_fidelity_cli(
                io.BytesIO(json.dumps(body).encode()),
                original_directory=root / "original",
                adapted_directory=root / "adapted",
                result_path=result_path,
            )
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(result_path.read_bytes())["status"], "matched")
            (root / "adapted" / "untrusted.py").write_text("must never be executed")
            bad_path = root / "bad.json"
            code = run_fidelity_cli(
                io.BytesIO(json.dumps(body).encode()),
                original_directory=root / "original",
                adapted_directory=root / "adapted",
                result_path=bad_path,
            )
            self.assertEqual(code, 2)
            self.assertEqual(
                json.loads(bad_path.read_bytes())["error"], "baseline_comparison_failed"
            )

    def test_trusted_cli_reads_only_generated_numeric_files_and_rejects_extra_source(self):
        manifest, payloads, mappings = bundle()
        manifest["operationId"] = str(uuid.uuid4())
        request = {
            "schemaVersion": "1.0",
            "evaluationOperationId": str(uuid.uuid4()),
            "sourceOperationId": manifest["operationId"],
            "inputDigest": manifest["inputDigest"],
            "adapterDigest": manifest["adapterDigest"],
            "manifest": manifest,
            "mappings": mappings,
            "maximumBytes": 10000,
            "maximumElements": 100,
        }
        for extra in (False, True):
            with tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary) / "data"
                directory.mkdir()
                for name, raw in payloads.items():
                    (directory / name).write_bytes(raw)
                if extra:
                    (directory / "source.py").write_text('raise AssertionError("must not run")')
                result_path = Path(temporary) / "result.json"
                code = run_validation_cli(
                    io.BytesIO(json.dumps(request).encode()),
                    input_directory=directory,
                    result_path=result_path,
                )
                self.assertEqual(code, 2 if extra else 0)
                result = json.loads(result_path.read_bytes())
                if extra:
                    self.assertEqual(
                        result, {"schemaVersion": "1.0", "error": "numeric_validation_failed"}
                    )
                else:
                    self.assertEqual(result["totalElements"], 4)

    def test_data_only_validation_job_reports_real_shapes_counts_and_conversion_metadata(self):
        manifest, payloads, mappings = bundle()
        manifest["operationId"] = str(uuid.uuid4())
        request = {
            "schemaVersion": "1.0",
            "evaluationOperationId": str(uuid.uuid4()),
            "sourceOperationId": manifest["operationId"],
            "inputDigest": manifest["inputDigest"],
            "adapterDigest": manifest["adapterDigest"],
            "manifest": manifest,
            "mappings": mappings,
            "maximumBytes": 10000,
            "maximumElements": 100,
        }
        report, arrays = validate_observation_job(request, payloads)
        self.assertEqual(report["validation"], "validated_numeric_structure")
        self.assertEqual(report["totalElements"], 4)
        self.assertEqual(report["totalBytes"], sum(map(len, payloads.values())))
        self.assertEqual(report["observations"][0]["conversion"], "none")
        self.assertFalse(arrays["times"].values.flags.writeable)
        json.dumps(report, allow_nan=False)
        with self.assertRaises(NumericInputError):
            validate_observation_job(dict(request, sourceText="never accepted"), payloads)
        with self.assertRaises(NumericInputError):
            validate_observation_job(
                dict(request, evaluationOperationId=manifest["operationId"]), payloads
            )

    def validate(self, manifest, payloads, mappings, **limits):
        return validate_observation_exports(
            manifest,
            payloads,
            mappings=mappings,
            operation_id="authored-operation",
            input_digest="a" * 64,
            adapter_digest="b" * 64,
            maximum_bytes=limits.get("maximum_bytes", 10000),
            maximum_elements=limits.get("maximum_elements", 100),
        )

    def test_decodes_readonly_arrays_with_exact_values(self):
        result = self.validate(*bundle())
        np.testing.assert_array_equal(result["temperature"].values, [[3.0], [5.0]])
        self.assertFalse(result["times"].values.flags.writeable)

    def test_hash_and_length_are_recomputed_instead_of_trusting_metadata(self):
        for kind in ("hash", "length"):
            manifest, payloads, mappings = bundle()
            if kind == "hash":
                raw = payloads["obs_temperature.npy"]
                payloads["obs_temperature.npy"] = raw[:-1] + bytes([raw[-1] ^ 1])
            else:
                manifest["observations"][0]["bytes"] += 1
            with self.assertRaises(NumericInputError):
                self.validate(manifest, payloads, mappings)

    def test_identity_paths_units_and_observation_sets_must_match(self):
        original, payloads, mappings = bundle()
        for kind in ("identity", "path", "unit", "duplicate", "missing"):
            manifest = copy.deepcopy(original)
            if kind == "identity":
                manifest["adapterDigest"] = "c" * 64
            if kind == "path":
                manifest["observations"][0]["filename"] = "../obs_times.npy"
            if kind == "unit":
                manifest["observations"][0]["declaredUnit"] = "year"
            if kind == "duplicate":
                manifest["observations"][1] = manifest["observations"][0]
            if kind == "missing":
                manifest["observations"].pop()
            with self.assertRaises(NumericInputError):
                self.validate(manifest, payloads, mappings)

    def test_cumulative_file_and_element_limits_include_all_observations(self):
        manifest, payloads, mappings = bundle()
        size = sum(map(len, payloads.values()))
        self.validate(manifest, payloads, mappings, maximum_bytes=size, maximum_elements=4)
        for limits in ({"maximum_bytes": size - 1}, {"maximum_elements": 3}):
            with self.assertRaises(NumericInputError):
                self.validate(manifest, payloads, mappings, **limits)

    def test_pickle_integer_and_float32_are_rejected_even_with_matching_hashes(self):
        for array in (
            np.array([object()], dtype=object),
            np.array([1], dtype=np.int64),
            np.array([1], dtype=np.float32),
        ):
            with self.assertRaises(NumericInputError):
                self.validate(*bundle({"times": array}))

    def test_decoded_npy_shape_is_checked_independently_of_descriptor(self):
        manifest, payloads, mappings = bundle()
        # Keep the claimed canonical shape while the actual NPY shape is different.
        buffer = io.BytesIO()
        np.save(buffer, np.array([3.0, 5.0]))
        raw = buffer.getvalue()
        payloads["obs_temperature.npy"] = raw
        descriptor = manifest["observations"][1]
        descriptor["bytes"] = len(raw)
        descriptor["sha256"] = hashlib.sha256(raw).hexdigest()
        with self.assertRaisesRegex(NumericInputError, "shape_mismatch"):
            self.validate(manifest, payloads, mappings)

    def test_nonfinite_and_nonincreasing_times_never_reach_physics_checks(self):
        for array in (np.array([0.0, np.inf]), np.array([1.0, 0.0]), np.array([0.0, 0.0])):
            with self.assertRaises(NumericInputError):
                self.validate(*bundle({"times": array}))

    def test_zero_dimensional_gravity_parameter_is_allowed_only_on_explicit_observation_path(self):
        manifest, payloads, mappings = bundle({"central_mu": np.array(3.986004418e14)})
        result = self.validate(manifest, payloads, mappings)
        self.assertEqual(result["central_mu"].values.shape, ())
        with self.assertRaises(NumericInputError):
            read_npy(payloads["obs_central_mu.npy"], maximum_bytes=10000, maximum_elements=1)

    def test_extra_unrequested_payload_is_rejected(self):
        manifest, payloads, mappings = bundle()
        payloads["unexpected.py"] = b"never imported"
        with self.assertRaises(NumericInputError):
            self.validate(manifest, payloads, mappings)


if __name__ == "__main__":
    unittest.main()
