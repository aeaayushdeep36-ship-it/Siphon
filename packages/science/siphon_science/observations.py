"""Structural checks on decoded observations; no physical meaning is inferred."""

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .numeric_inputs import NumericInput, NumericInputError


@dataclass(frozen=True)
class Observations:
    times: NDArray[np.float64]
    values: NDArray[np.float64]


def validate_observations(
    times: NumericInput,
    values: NumericInput,
    *,
    sample_shape: tuple[int, ...],
    maximum_samples: int,
    maximum_sample_elements: int,
) -> Observations:
    """Require explicit canonical axes: (time, *sample_shape).

    Callers must supply a reviewed domain-specific shape and server-owned limits.
    Units, frames, axis mappings and provenance require separate verification.
    A single sample is structurally valid but cannot establish temporal behavior.
    """
    for limit in (maximum_samples, maximum_sample_elements):
        if type(limit) is not int or limit < 1:
            raise ValueError("Invalid observation policy")
    if (
        not isinstance(sample_shape, tuple)
        or not sample_shape
        or any(type(size) is not int or size < 1 for size in sample_shape)
    ):
        raise ValueError("Invalid declared sample shape")
    # Python integer arithmetic avoids overflow from an untrusted declared shape.
    elements = 1
    for size in sample_shape:
        elements *= size
        if elements > maximum_sample_elements:
            raise NumericInputError("observation_sample_limit")
    for data in (times.values, values.values):
        if not isinstance(data, np.ndarray) or data.dtype != np.dtype("float64"):
            raise NumericInputError("invalid_observation_dtype")
    if times.values.ndim != 1 or times.values.size == 0:
        raise NumericInputError("invalid_time_shape")
    count = times.values.size
    if count > maximum_samples:
        raise NumericInputError("observation_sample_count_limit")
    if values.values.shape != (count, *sample_shape):
        raise NumericInputError("observation_shape_mismatch")
    for data in (times.values, values.values):
        if not np.isfinite(data).all():
            raise NumericInputError("non_finite_observation")
    # Compare directly: subtraction can overflow for finite extreme timestamps.
    if np.any(times.values[1:] <= times.values[:-1]):
        raise NumericInputError("non_increasing_time")
    # Own a snapshot so later caller mutations cannot change validated evidence.
    time_snapshot = times.values.copy()
    value_snapshot = values.values.copy()
    time_snapshot.setflags(write=False)
    value_snapshot.setflags(write=False)
    return Observations(time_snapshot, value_snapshot)
