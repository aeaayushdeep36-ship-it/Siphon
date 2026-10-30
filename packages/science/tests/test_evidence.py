import math
import unittest

import numpy as np

from siphon_science.evidence import decide_absolute_metric, maximum_absolute_drift
from siphon_science.numeric_inputs import NumericInputError


class EvidenceTests(unittest.TestCase):
    def test_interval_fully_below_above_and_crossing_target(self):
        for metric, expected in [
            (0.5, "passed_within_tolerance"),
            (2.0, "flagged"),
            (1.0, "inconclusive"),
        ]:
            result = decide_absolute_metric(metric, target=1.0, absolute_uncertainty_bound=0.1)
            self.assertEqual(result.status, expected)

    def test_unknown_accuracy_is_not_a_pass_or_failure(self):
        self.assertEqual(
            decide_absolute_metric(0.0, target=1.0, absolute_uncertainty_bound=None).status,
            "inconclusive",
        )
        self.assertEqual(
            decide_absolute_metric(100.0, target=None, absolute_uncertainty_bound=0.0).status,
            "inconclusive",
        )

    def test_zero_bound_and_outward_rounding_at_boundary(self):
        self.assertEqual(
            decide_absolute_metric(1.0, target=1.0, absolute_uncertainty_bound=0.0).status,
            "passed_within_tolerance",
        )
        result = decide_absolute_metric(0.5, target=1.0, absolute_uncertainty_bound=0.5)
        self.assertGreater(result.upper_bound, 1.0)
        self.assertEqual(result.status, "inconclusive")
        self.assertEqual(result.lower_bound, 0.0)

    def test_invalid_numbers_and_overflow_never_pass(self):
        for bad in (math.nan, math.inf, -1.0, True):
            with self.assertRaises(NumericInputError):
                decide_absolute_metric(bad, target=1.0, absolute_uncertainty_bound=0.0)
        self.assertEqual(
            decide_absolute_metric(1e308, target=1e308, absolute_uncertainty_bound=1e308).reason,
            "unrepresentable_interval",
        )

    def test_scalar_zero_invariant_and_vector_direction_change(self):
        self.assertEqual(
            maximum_absolute_drift(np.array([0.0, -2.0, 1.0]), maximum_samples=10), 2.0
        )
        # Equal vector lengths alone would hide this direction reversal.
        self.assertEqual(
            maximum_absolute_drift(
                np.array([[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]]), maximum_samples=10
            ),
            2.0,
        )
        self.assertEqual(
            maximum_absolute_drift(np.array([[0.0, 0.0], [3.0, 4.0]]), maximum_samples=10), 5.0
        )

    def test_drift_rejects_insufficient_nonfinite_and_overflow(self):
        for values in (
            np.array([1.0]),
            np.array([1.0, np.nan]),
            np.array([-1e308, 1e308]),
            np.ones((2, 4)),
        ):
            with self.assertRaises(NumericInputError):
                maximum_absolute_drift(values, maximum_samples=10)


if __name__ == "__main__":
    unittest.main()
