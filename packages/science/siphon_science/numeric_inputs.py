"""Bounded numeric decoding for isolated inspection and trusted data-only jobs.

No units or axis meanings are inferred. These are format checks, not physics checks.
"""

import csv
import io
import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray


class NumericInputError(ValueError):
    """Stable code only; never echo private numeric contents in exceptions."""


@dataclass(frozen=True)
class NumericInput:
    values: NDArray[np.float64]
    original_dtype: str
    conversion: str


def _validate_limits(payload: bytes, maximum_bytes: int, maximum_elements: int) -> None:
    if type(maximum_bytes) is not int or maximum_bytes < 1:
        raise ValueError("Invalid byte policy")
    if type(maximum_elements) is not int or maximum_elements < 1:
        raise ValueError("Invalid element policy")
    if not isinstance(payload, bytes):
        raise TypeError("Expected bytes")
    if len(payload) > maximum_bytes:
        raise NumericInputError("numeric_byte_limit")


def _as_float64(values: NDArray) -> NumericInput:
    dtype = values.dtype
    if dtype.fields is not None or dtype.subdtype is not None or dtype.kind not in "iuf":
        raise NumericInputError("unsupported_numeric_dtype")
    if dtype.kind == "f" and dtype.itemsize > 8:
        raise NumericInputError("unsupported_numeric_precision")
    converted = values.astype(np.float64, copy=True)
    if not np.isfinite(converted).all():
        raise NumericInputError("non_finite_numeric_data")
    if dtype.kind in "iu":
        # A float64 round trip back through NumPy int64 can overflow. Compare Python ints.
        if any(int(old) != int(new) for old, new in zip(values.flat, converted.flat)):
            raise NumericInputError("lossy_integer_conversion")
    converted.setflags(write=False)
    return NumericInput(
        converted, dtype.str, "none" if dtype == np.dtype("float64") else "exact_to_float64"
    )


def read_npy(
    payload: bytes,
    *,
    maximum_bytes: int,
    maximum_elements: int,
    maximum_dimensions: int = 4,
    allow_scalar: bool = False,
    require_float64: bool = False,
) -> NumericInput:
    _validate_limits(payload, maximum_bytes, maximum_elements)
    if type(maximum_dimensions) is not int or maximum_dimensions < 1:
        raise ValueError("Invalid dimension policy")
    if type(allow_scalar) is not bool or type(require_float64) is not bool:
        raise ValueError("Invalid numeric representation policy")
    stream = io.BytesIO(payload)
    try:
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            shape, fortran_order, dtype = np.lib.format.read_array_header_1_0(
                stream, max_header_size=10000
            )
        elif version == (2, 0):
            shape, fortran_order, dtype = np.lib.format.read_array_header_2_0(
                stream, max_header_size=10000
            )
        else:
            raise NumericInputError("unsupported_npy_version")
        if dtype.hasobject or dtype.fields is not None or dtype.kind not in "iuf":
            raise NumericInputError("unsupported_numeric_dtype")
        if require_float64 and (dtype.kind != "f" or dtype.itemsize != 8):
            raise NumericInputError("observation_requires_float64")
        if (
            (not shape and not allow_scalar)
            or len(shape) > maximum_dimensions
            or any(type(n) is not int or n <= 0 for n in shape)
        ):
            raise NumericInputError("unsupported_numeric_shape")
        elements = math.prod(shape)
        if elements > maximum_elements:
            raise NumericInputError("numeric_element_limit")
        required = elements * dtype.itemsize
        if required != len(payload) - stream.tell():
            raise NumericInputError("npy_payload_length_mismatch")
        # Header/shape/dtype and exact payload length are checked before materializing arrays.
        values = np.frombuffer(payload, dtype=dtype, count=elements, offset=stream.tell())
        values = values.reshape(shape, order="F" if fortran_order else "C")
        return _as_float64(values)
    except NumericInputError:
        raise
    except (ValueError, TypeError, EOFError, OverflowError, MemoryError):
        raise NumericInputError("invalid_npy") from None


def read_csv(
    payload: bytes, *, maximum_bytes: int, maximum_elements: int, has_header: bool
) -> NumericInput:
    _validate_limits(payload, maximum_bytes, maximum_elements)
    if type(has_header) is not bool:
        raise ValueError("CSV header presence must be declared")
    try:
        text = payload.decode("utf-8-sig", errors="strict")
        if "\x00" in text:
            raise NumericInputError("invalid_csv")
        reader = csv.reader(io.StringIO(text, newline=""), strict=True)
        header = next(reader, None) if has_header else None
        if has_header and (not header or any(not cell.strip() for cell in header)):
            raise NumericInputError("invalid_csv_header")
        columns = len(header) if header else None
        rows: list[list[float]] = []
        elements = 0
        for row in reader:
            if not row or any(not cell.strip() for cell in row):
                raise NumericInputError("missing_csv_value")
            columns = len(row) if columns is None else columns
            if len(row) != columns:
                raise NumericInputError("ragged_csv")
            elements += len(row)
            if elements > maximum_elements:
                raise NumericInputError("numeric_element_limit")
            rows.append([float(cell) for cell in row])
        if not rows:
            raise NumericInputError("empty_numeric_data")
        result = _as_float64(np.asarray(rows, dtype=np.float64))
        return NumericInput(result.values, "csv_decimal_text", "decimal_text_to_float64")
    except NumericInputError:
        raise
    except (UnicodeError, csv.Error, ValueError, OverflowError, MemoryError):
        raise NumericInputError("invalid_csv") from None
