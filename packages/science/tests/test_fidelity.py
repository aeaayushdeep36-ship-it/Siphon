import unittest

import numpy as np

from siphon_science.adapter import extract_observations
from siphon_science.fidelity import compare_baselines
from siphon_science.numeric_inputs import NumericInputError


class FidelityTests(unittest.TestCase):
    def test_matching_repeated_wrong_mapping_does_not_prove_semantic_fidelity(self):
        mapping = [
            {
                "key": "temperature",
                "root": "wrong_field",
                "steps": [],
                "expectedShape": [2],
                "axisOrder": [0],
                "declaredUnit": "K",
            }
        ]
        namespace = {
            "wrong_field": np.array([1.0, 2.0]),
            "actual_temperature": np.array([300.0, 310.0]),
        }
        first = extract_observations(namespace, mapping, maximum_bytes=100, maximum_elements=10)
        second = extract_observations(namespace, mapping, maximum_bytes=100, maximum_elements=10)
        result = compare_baselines(
            first, second, required_keys=("temperature",), maximum_total_elements=10
        )
        self.assertEqual(result["status"], "matched")
        self.assertFalse(np.array_equal(first["temperature"], namespace["actual_temperature"]))

    def compare(self, left, right, keys=("time", "temperature")):
        return compare_baselines(left, right, required_keys=keys, maximum_total_elements=100)

    def baseline(self):
        return {
            "time": np.array([0.0, 1.0]),
            "temperature": np.array([[300.0, 301.0], [302.0, 303.0]]),
        }

    def test_exact_values_match_independent_of_memory_order(self):
        left = self.baseline()
        right = {key: np.asfortranarray(value) for key, value in left.items()}
        result = self.compare(left, right)
        self.assertEqual(result["status"], "matched")
        self.assertEqual(result["comparedElements"], 6)

    def test_one_ulp_change_is_not_hidden_by_allclose(self):
        left, right = self.baseline(), self.baseline()
        right["temperature"][0, 0] = np.nextafter(300.0, np.inf)
        self.assertTrue(np.allclose(left["temperature"], right["temperature"]))
        result = self.compare(left, right)
        self.assertEqual(result["status"], "mismatched")
        self.assertEqual(result["observations"][1]["reason"], "value_mismatch")

    def test_time_and_axis_changes_are_not_automatically_repaired(self):
        left, right = self.baseline(), self.baseline()
        right["time"] = right["time"][::-1]
        right["temperature"] = right["temperature"].T
        self.assertTrue(
            all(
                item["status"] == "mismatched" for item in self.compare(left, right)["observations"]
            )
        )
        right["temperature"] = right["temperature"].reshape(4)
        self.assertEqual(self.compare(left, right)["observations"][1]["reason"], "shape_mismatch")

    def test_missing_arrays_never_match(self):
        left, right = self.baseline(), self.baseline()
        del left["time"]
        del right["temperature"]
        result = self.compare(left, right)
        self.assertEqual(
            [item["reason"] for item in result["observations"]],
            ["missing_original", "missing_adapted"],
        )
        self.assertEqual(self.compare({}, {})["status"], "mismatched")

    def test_nonfinite_empty_and_wrong_dtype_rejected(self):
        for value in (
            np.array([np.nan]),
            np.array([np.inf]),
            np.array([]),
            np.array([1], dtype=np.int64),
        ):
            with self.assertRaises(NumericInputError):
                self.compare({"time": value}, {"time": value}, ("time",))

    def test_key_and_combined_element_caps(self):
        with self.assertRaises(NumericInputError):
            self.compare({"unknown": np.array([1.0])}, {})
        with self.assertRaises(ValueError):
            self.compare({}, {}, ())
        with self.assertRaises(ValueError):
            self.compare({}, {}, ("time", "time"))
        with self.assertRaisesRegex(NumericInputError, "baseline_element_limit"):
            compare_baselines(
                self.baseline(),
                self.baseline(),
                required_keys=("time", "temperature"),
                maximum_total_elements=11,
            )

    def test_signed_zero_has_numeric_equality_and_output_omits_data(self):
        result = self.compare({"time": np.array([0.0])}, {"time": np.array([-0.0])}, ("time",))
        self.assertEqual(result["status"], "matched")
        self.assertEqual(set(result["observations"][0]), {"key", "status", "reason"})


if __name__ == "__main__":
    unittest.main()
