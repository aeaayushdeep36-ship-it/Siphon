import copy
import hashlib
import io
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import numpy as np

from siphon_science.diagnostics_job import run_diagnostics_cli, run_diagnostics_job
from siphon_science.numeric_inputs import NumericInputError

UNITS = {
    "times": "s",
    "temperature": "K",
    "thermal_weights": "m^3",
    "source_power": "W",
    "outward_power": "W",
    "positions": "m",
    "velocities": "m/s",
    "masses": "kg",
    "central_mu": "m^3/s^2",
    "gravity_constant": "m^3/(kg*s^2)",
}


def job(arrays, profile):
    payloads, mappings, descriptors = {}, [], []
    for key, values in arrays.items():
        array = np.array(values, dtype=np.float64)
        buffer = io.BytesIO()
        np.save(buffer, array, allow_pickle=False)
        raw, filename = buffer.getvalue(), "obs_" + key + ".npy"
        payloads[filename] = raw
        mappings.append(
            {
                "key": key,
                "root": "fixture",
                "steps": [],
                "expectedShape": list(array.shape),
                "axisOrder": list(range(array.ndim)),
                "declaredUnit": UNITS[key],
            }
        )
        descriptors.append(
            {
                "key": key,
                "filename": filename,
                "bytes": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "shape": list(array.shape),
                "dtype": "float64",
                "declaredUnit": UNITS[key],
            }
        )
    source = str(uuid.uuid4())
    validation = {
        "schemaVersion": "1.0",
        "evaluationOperationId": str(uuid.uuid4()),
        "sourceOperationId": source,
        "inputDigest": "a" * 64,
        "adapterDigest": "b" * 64,
        "maximumBytes": 100000,
        "maximumElements": 10000,
        "manifest": {
            "schemaVersion": "1.0",
            "operationId": source,
            "inputDigest": "a" * 64,
            "adapterDigest": "b" * 64,
            "executionProfile": "runpy_main_root_v1",
            "observations": descriptors,
        },
        "mappings": mappings,
    }
    request = {
        "schemaVersion": "1.0",
        "auditId": str(uuid.uuid4()),
        "revisionId": str(uuid.uuid4()),
        "operationId": str(uuid.uuid4()),
        "contextDigest": "c" * 64,
        "validation": validation,
        "profile": profile,
    }
    return request, payloads


def central():
    return job(
        {
            "times": [0.0, 1.0],
            "positions": [[[1.0, 0.0]], [[0.0, 1.0]]],
            "velocities": [[[0.0, 1.0]], [[-1.0, 0.0]]],
            "central_mu": 1.0,
        },
        {"kind": "central_orbit_si"},
    )


class DiagnosticsJobTests(unittest.TestCase):
    def test_cli_uses_only_declared_numeric_files_and_redacts_source_or_protocol_errors(self):
        request, payloads = central()
        for kind in ("valid", "extra_source", "corrupt", "duplicate_key", "oversize"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                directory = root / "numeric"
                directory.mkdir()
                for name, raw in payloads.items():
                    (directory / name).write_bytes(raw)
                if kind == "extra_source":
                    (directory / "secret.py").write_text(
                        'raise RuntimeError("private-source-marker")'
                    )
                if kind == "corrupt":
                    (directory / "obs_positions.npy").write_bytes(b"private-source-marker")
                raw = json.dumps(request).encode()
                if kind == "duplicate_key":
                    raw = b'{"schemaVersion":"1.0","schemaVersion":"1.0"}'
                if kind == "oversize":
                    raw = b" " * 65537
                result_path = root / "result.json"
                code = run_diagnostics_cli(
                    io.BytesIO(raw), input_directory=directory, result_path=result_path
                )
                result = json.loads(result_path.read_bytes())
                self.assertEqual(code, 0 if kind == "valid" else 2)
                if kind == "valid":
                    self.assertEqual(result["metrics"][0]["value"], 0.0)
                else:
                    self.assertEqual(
                        result, {"schemaVersion": "1.0", "error": "numeric_diagnostics_failed"}
                    )

    def test_central_circular_states_measure_zero_drift_without_claiming_pass_or_total_momentum(
        self,
    ):
        request, payloads = central()
        result = run_diagnostics_job(request, payloads)
        self.assertEqual([item["value"] for item in result["metrics"]], [0.0, 0.0])
        self.assertEqual([item["unit"] for item in result["metrics"]], ["m^2/s^2", "m^2/s"])
        self.assertTrue(all(item["status"] == "inconclusive" for item in result["metrics"]))
        self.assertEqual(result["timeRangeSeconds"], [0.0, 1.0])
        self.assertEqual(result["operationId"], request["operationId"])
        self.assertEqual(result["sourceOperationId"], request["validation"]["sourceOperationId"])
        json.dumps(result, allow_nan=False)

    def test_central_speed_defect_is_measured_as_a_dimensional_drift(self):
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[1.0, 0.0]], [[0.0, 1.0]]],
                "velocities": [[[0.0, 1.0]], [[-1.1, 0.0]]],
                "central_mu": 1.0,
            },
            {"kind": "central_orbit_si"},
        )
        metrics = run_diagnostics_job(request, payloads)["metrics"]
        # Delta(v^2/2)=0.105 and delta(r cross v)=0.1; no normalized denominator.
        self.assertAlmostEqual(metrics[0]["value"], 0.105)
        self.assertAlmostEqual(metrics[1]["value"], 0.1)

    def test_isolated_direction_reversal_is_visible_even_when_energy_and_momentum_drift_are_zero(
        self,
    ):
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[-1.0, 0.0], [1.0, 0.0]]] * 2,
                "velocities": [[[0.0, -0.5], [0.0, 0.5]], [[0.0, 0.5], [0.0, -0.5]]],
                "masses": [1.0, 1.0],
                "gravity_constant": 1.0,
            },
            {"kind": "isolated_orbits_si"},
        )
        metrics = run_diagnostics_job(request, payloads)["metrics"]
        self.assertEqual([item["value"] for item in metrics], [0.0, 2.0, 0.0])
        self.assertEqual([item["unit"] for item in metrics], ["J", "kg*m^2/s", "kg*m/s"])

    def test_heat_uses_physical_weights_and_material_parameters(self):
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "temperature": [[300.0, 300.0], [299.0, 301.0]],
                "thermal_weights": [1.0, 2.0],
            },
            {"kind": "heat_energy_si", "densityKgM3": 2.0, "heatCapacityJKgK": 3.0},
        )
        self.assertEqual(run_diagnostics_job(request, payloads)["metrics"][0]["value"], 6.0)
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "temperature": [[[300.0, 300.0], [300.0, 300.0]], [[302.0, 302.0], [302.0, 302.0]]],
                "thermal_weights": [[1.0, 1.0], [1.0, 1.0]],
            },
            {"kind": "heat_energy_si", "densityKgM3": 2.0, "heatCapacityJKgK": 3.0},
        )
        self.assertEqual(run_diagnostics_job(request, payloads)["metrics"][0]["value"], 48.0)

    def test_heat_balance_observes_outward_sign_and_exposes_quadrature_limitations(self):
        arrays = {
            "times": [0.0, 1.0, 3.0],
            "temperature": [[10.0], [8.0], [4.0]],
            "thermal_weights": [1.0],
            "source_power": [0.0, 0.0, 0.0],
            "outward_power": [2.0, 2.0, 2.0],
        }
        profile = {"kind": "heat_balance_si", "densityKgM3": 1.0, "heatCapacityJKgK": 1.0}
        result = run_diagnostics_job(*job(arrays, profile))
        self.assertEqual(result["metrics"][0]["value"], 0.0)
        self.assertTrue(any("quadrature uncertainty" in item for item in result["limitations"]))
        arrays["outward_power"] = [-2.0, -2.0, -2.0]
        self.assertEqual(run_diagnostics_job(*job(arrays, profile))["metrics"][0]["value"], 12.0)

    def test_invalid_metadata_is_rejected_before_any_payload_decode(self):
        for kind in (
            "source",
            "same_operation",
            "unit",
            "shape",
            "missing",
            "profile",
            "tolerance",
        ):
            with self.subTest(kind=kind):
                request, _payloads = central()
                if kind == "source":
                    request["sourceCode"] = "must never execute"
                if kind == "same_operation":
                    request["operationId"] = request["validation"]["sourceOperationId"]
                if kind == "unit":
                    request["validation"]["mappings"][1]["declaredUnit"] = "km"
                if kind == "shape":
                    request["validation"]["mappings"][1]["expectedShape"] = [2, 2, 2]
                if kind == "missing":
                    request["validation"]["mappings"].pop()
                if kind == "profile":
                    request["profile"]["kind"] = "drag_orbit"
                if kind == "tolerance":
                    request["profile"]["tolerance"] = 0.001
                with self.assertRaises(NumericInputError):
                    run_diagnostics_job(request, {})

    def test_rehashes_npy_and_refuses_nonfinite_data_instead_of_returning_a_measurement(self):
        request, payloads = central()
        corrupt = dict(payloads)
        corrupt["obs_positions.npy"] = payloads["obs_positions.npy"][:-1] + b"\xff"
        with self.assertRaisesRegex(NumericInputError, "hash_mismatch"):
            run_diagnostics_job(request, corrupt)
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[1.0, 0.0]], [[0.0, 1.0]]],
                "velocities": [[[0.0, 1.0]], [[np.nan, 0.0]]],
                "central_mu": 1.0,
            },
            {"kind": "central_orbit_si"},
        )
        with self.assertRaises(NumericInputError):
            run_diagnostics_job(request, payloads)

    def test_constant_mu_positive_mass_and_no_collision_are_enforced(self):
        for mu in (0.0, -1.0):
            request, payloads = job(
                {
                    "times": [0.0, 1.0],
                    "positions": [[[1.0, 0.0]]] * 2,
                    "velocities": [[[0.0, 1.0]]] * 2,
                    "central_mu": mu,
                },
                {"kind": "central_orbit_si"},
            )
            with self.assertRaisesRegex(NumericInputError, "invalid_gravity_parameter"):
                run_diagnostics_job(request, payloads)
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[1.0, 0.0], [1.0, 0.0]]] * 2,
                "velocities": [[[0.0, 0.5], [0.0, -0.5]]] * 2,
                "masses": [1.0, 1.0],
                "gravity_constant": 1.0,
            },
            {"kind": "isolated_orbits_si"},
        )
        with self.assertRaisesRegex(NumericInputError, "point_mass_collision"):
            run_diagnostics_job(request, payloads)

    def test_unknown_material_and_nonmonotonic_times_do_not_become_zero_error(self):
        request, payloads = job(
            {"times": [0.0, 1.0], "temperature": [[300.0], [301.0]], "thermal_weights": [1.0]},
            {"kind": "heat_energy_si", "densityKgM3": 2.0, "heatCapacityJKgK": 3.0},
        )
        for value in (None, True, 0.0, -1.0, float("inf")):
            changed = copy.deepcopy(request)
            changed["profile"]["densityKgM3"] = value
            with self.assertRaises(NumericInputError):
                run_diagnostics_job(changed, payloads)
        request, payloads = job(
            {"times": [1.0, 0.0], "temperature": [[300.0], [301.0]], "thermal_weights": [1.0]},
            {"kind": "heat_energy_si", "densityKgM3": 2.0, "heatCapacityJKgK": 3.0},
        )
        with self.assertRaisesRegex(NumericInputError, "time_axis"):
            run_diagnostics_job(request, payloads)


if __name__ == "__main__":
    unittest.main()
