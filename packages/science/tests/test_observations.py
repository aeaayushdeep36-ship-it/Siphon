import unittest

import numpy as np

from siphon_science.numeric_inputs import NumericInput, NumericInputError
from siphon_science.observations import validate_observations


def numeric(values):
    return NumericInput(np.asarray(values, dtype=np.float64), "<f8", "none")


class ObservationTests(unittest.TestCase):
    def validate(self, times, values, shape=(2,)):
        return validate_observations(
            numeric(times),
            numeric(values),
            sample_shape=shape,
            maximum_samples=4,
            maximum_sample_elements=6,
        )

    def test_retains_irregular_sampling_without_inferring_timestep(self):
        result = self.validate([-1, 0, 3], [[1, 2], [3, 4], [5, 6]])
        np.testing.assert_array_equal(result.times, [-1, 0, 3])
        self.assertFalse(result.values.flags.writeable)

    def test_duplicate_decreasing_and_nonfinite_times_rejected(self):
        for times in ([1, 1], [2, 1], [0, np.nan], [0, np.inf]):
            with self.assertRaises(NumericInputError):
                self.validate(times, [[1, 2], [3, 4]])

    def test_shape_and_observation_finiteness_checked(self):
        for times, values in [
            ([], []),
            ([[0]], [[1, 2]]),
            ([0, 1], [[1, 2]]),
            ([0], [[1, np.inf]]),
            ([0], [[1, 2, 3]]),
        ]:
            with self.assertRaises(NumericInputError):
                self.validate(times, values)
        result = self.validate([0], [[[1, 2, 3], [4, 5, 6]]], (2, 3))
        self.assertEqual(result.values.shape, (1, 2, 3))

    def test_caps_reject_large_shapes_and_sample_counts(self):
        with self.assertRaisesRegex(NumericInputError, "observation_sample_limit"):
            self.validate([0], [[1, 2]], (10**20, 10**20))
        with self.assertRaisesRegex(NumericInputError, "observation_sample_count_limit"):
            self.validate(list(range(5)), [[1, 2]] * 5)

    def test_validated_snapshot_does_not_alias_input(self):
        times = numeric([0, 1])
        values = numeric([[1, 2], [3, 4]])
        result = validate_observations(
            times, values, sample_shape=(2,), maximum_samples=4, maximum_sample_elements=6
        )
        times.values[0] = 100
        values.values[0, 0] = 100
        self.assertEqual(result.times[0], 0)
        self.assertEqual(result.values[0, 0], 1)


if __name__ == "__main__":
    unittest.main()
