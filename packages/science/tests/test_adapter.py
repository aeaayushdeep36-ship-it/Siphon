import unittest

import numpy as np

from siphon_science.adapter import AdapterError, extract_observations
from siphon_science.reference_extraction import extract_reference


def mapping(key="temperature", root="data", shape=None, order=None, steps=None):
    return {
        "key": key,
        "root": root,
        "steps": steps or [],
        "expectedShape": [2, 3] if shape is None else shape,
        "axisOrder": [0, 1] if order is None else order,
        "declaredUnit": "K",
    }


class AdapterTests(unittest.TestCase):
    def test_independent_reference_matches_axis_permutations_and_detects_differences(self):
        import itertools

        values = np.arange(24, dtype=np.float64).reshape(2, 3, 4)
        for order in itertools.permutations(range(3)):
            spec = mapping(shape=[values.shape[i] for i in order], order=list(order))
            reference = extract_reference(
                {"data": values}, [spec], maximum_bytes=1024, maximum_elements=100
            )
            observed = self.extract({"data": values}, [spec])
            np.testing.assert_array_equal(reference["temperature"], observed["temperature"])
            if order != (0, 1, 2):
                self.assertFalse(np.array_equal(reference["temperature"].shape, values.shape))

    def extract(self, namespace, mappings, maximum_bytes=1024, maximum_elements=100):
        return extract_observations(
            namespace, mappings, maximum_bytes=maximum_bytes, maximum_elements=maximum_elements
        )

    def test_copies_nested_existing_arrays_without_mutating_them(self):
        values = np.arange(6, dtype=np.float64).reshape(2, 3)
        result = self.extract(
            {"data": {"samples": [values]}},
            [mapping(steps=[{"kind": "key", "key": "samples"}, {"kind": "index", "index": 0}])],
        )
        np.testing.assert_array_equal(result["temperature"], values)
        values[0, 0] = 100
        self.assertEqual(result["temperature"][0, 0], 0)
        self.assertFalse(result["temperature"].flags.writeable)

    def test_only_explicit_axis_permutation_changes_layout(self):
        values = np.arange(6, dtype=np.float64).reshape(3, 2)
        with self.assertRaises(AdapterError):
            self.extract({"data": values}, [mapping()])
        result = self.extract({"data": values}, [mapping(order=[1, 0])])
        np.testing.assert_array_equal(result["temperature"], values.T)

    def test_never_coerces_integer_arrays_or_nonfinite_values(self):
        for values in (np.ones((2, 3), dtype=np.int64), np.full((2, 3), np.nan)):
            with self.assertRaises(AdapterError):
                self.extract({"data": values}, [mapping()])

    def test_cumulative_caps_include_duplicate_array_storage(self):
        values = np.ones((2, 3), dtype=np.float64)
        mappings = [mapping(), mapping(key="thermal_weights")]
        with self.assertRaises(AdapterError):
            self.extract({"data": values}, mappings, maximum_bytes=95)
        with self.assertRaises(AdapterError):
            self.extract({"data": values}, mappings, maximum_elements=11)
        self.assertEqual(len(self.extract({"data": values}, mappings, maximum_bytes=96)), 2)

    def test_rejects_expressions_callables_properties_and_implicit_array_conversion(self):
        class Trap:
            @property
            def samples(self):
                raise AssertionError("property must not run")

            def __array__(self):
                raise AssertionError("conversion must not run")

        for spec in (
            mapping(root="data.samples"),
            mapping(root="__builtins__"),
            mapping(steps=[{"kind": "attribute", "name": "samples"}]),
            mapping(steps=[{"kind": "key", "key": "samples"}]),
            mapping(),
        ):
            with self.assertRaises(AdapterError):
                self.extract({"data": Trap()}, [spec])

    def test_rejects_invalid_indices_duplicate_keys_and_axes(self):
        values = np.ones((2, 3), dtype=np.float64)
        for specs in (
            [mapping(), mapping()],
            [mapping(order=[0, 0])],
            [mapping(key="invented")],
            [mapping(steps=[{"kind": "index", "index": -1}])],
            [mapping(shape=[True, 3])],
        ):
            with self.assertRaises(AdapterError):
                self.extract({"data": values}, specs)

    def test_scalar_parameter_is_preserved_as_a_zero_dimensional_array(self):
        value = np.array(3.986004418e14)
        result = self.extract(
            {"mu": value}, [mapping(key="central_mu", root="mu", shape=[], order=[])]
        )
        self.assertEqual(result["central_mu"].shape, ())
        self.assertEqual(result["central_mu"].item(), value.item())


if __name__ == "__main__":
    unittest.main()
