import io
import unittest

import numpy as np

from siphon_science.numeric_inputs import NumericInputError, read_csv, read_npy


def npy(values):
    buffer = io.BytesIO()
    np.save(buffer, values, allow_pickle=False)
    return buffer.getvalue()


class NumericInputsTests(unittest.TestCase):
    def load(self, payload, **kwargs):
        return read_npy(payload, maximum_bytes=10000, maximum_elements=100, **kwargs)

    def csv(self, payload, header=False):
        return read_csv(payload, maximum_bytes=10000, maximum_elements=100, has_header=header)

    def test_npy_endianness_and_fortran_axes_preserved(self):
        original = np.asfortranarray(np.array([[1, 2, 3], [4, 5, 6]], dtype=">f8"))
        result = self.load(npy(original))
        np.testing.assert_array_equal(result.values, original)
        self.assertEqual(result.values.dtype, np.float64)
        self.assertFalse(result.values.flags.writeable)

    def test_rejects_object_header_without_unpickling(self):
        buffer = io.BytesIO()
        np.lib.format.write_array_header_1_0(
            buffer, {"descr": "|O", "fortran_order": False, "shape": (1,)}
        )
        with self.assertRaisesRegex(NumericInputError, "unsupported_numeric_dtype"):
            self.load(buffer.getvalue())

    def test_npy_version_two_and_malformed_headers(self):
        buffer = io.BytesIO()
        np.lib.format.write_array_header_2_0(
            buffer,
            {
                "descr": "<f8",
                "fortran_order": False,
                "shape": (2,),
            },
        )
        buffer.write(np.array([1.5, -2.5], dtype="<f8").tobytes())
        np.testing.assert_array_equal(self.load(buffer.getvalue()).values, [1.5, -2.5])
        for payload in (b"not numpy", b"\x93NUMPY\x01\x00", b"\x93NUMPY\x03\x00"):
            with self.assertRaises(NumericInputError):
                self.load(payload)

    def test_rejects_nonfinite_complex_structured_and_lossy_integer(self):
        for values in [
            np.array([np.nan]),
            np.array([np.inf]),
            np.array([1j]),
            np.array([(1,)], dtype=[("a", "i4")]),
            np.array([2**53 + 1], dtype=np.int64),
        ]:
            with self.assertRaises(NumericInputError):
                self.load(npy(values))
        self.assertEqual(self.load(npy(np.array([2**53], dtype=np.int64))).values[0], 2**53)

    def test_checks_claimed_shape_before_allocation_and_exact_payload(self):
        buffer = io.BytesIO()
        np.lib.format.write_array_header_1_0(
            buffer, {"descr": "<f8", "fortran_order": False, "shape": (10**12,)}
        )
        with self.assertRaisesRegex(NumericInputError, "numeric_element_limit"):
            self.load(buffer.getvalue())
        payload = npy(np.array([1.0]))
        for bad in (payload[:-1], payload + b"junk"):
            with self.assertRaisesRegex(NumericInputError, "npy_payload_length_mismatch"):
                self.load(bad)

    def test_csv_header_explicit_and_no_units_inferred(self):
        result = self.csv(b"time,position\n0,1\n1,2\n", header=True)
        np.testing.assert_array_equal(result.values, [[0, 1], [1, 2]])
        self.assertEqual(result.conversion, "decimal_text_to_float64")
        with self.assertRaises(NumericInputError):
            self.csv(b"time,position\n0,1", header=False)

    def test_csv_rejects_missing_ragged_nonfinite_and_expression(self):
        for payload in (b"1,\n", b"1,2\n3\n", b"nan,2", b"1e999,2", b"=1+2,3", b""):
            with self.assertRaises(NumericInputError):
                self.csv(payload)

    def test_byte_element_and_dimension_limits(self):
        with self.assertRaisesRegex(NumericInputError, "numeric_byte_limit"):
            read_csv(b"1,2", maximum_bytes=2, maximum_elements=10, has_header=False)
        with self.assertRaisesRegex(NumericInputError, "numeric_element_limit"):
            read_csv(b"1,2", maximum_bytes=10, maximum_elements=1, has_header=False)
        with self.assertRaisesRegex(NumericInputError, "unsupported_numeric_shape"):
            self.load(npy(np.ones((1, 1, 1))), maximum_dimensions=2)


if __name__ == "__main__":
    unittest.main()
