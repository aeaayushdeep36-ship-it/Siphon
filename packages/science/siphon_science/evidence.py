"""Decisions from a nonnegative diagnostic with an explicit absolute error bound.

This module supplies no default target or uncertainty estimate. The caller must
justify their applicability and units and retain the supporting provenance.
"""

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from .numeric_inputs import NumericInputError


@dataclass(frozen=True)
class EvidenceDecision:
    status: Literal["passed_within_tolerance", "flagged", "inconclusive"]
    metric: float
    target: float | None
    absolute_uncertainty_bound: float | None
    lower_bound: float | None
    upper_bound: float | None
    reason: str


def _nonnegative(value: float) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise NumericInputError("invalid_evidence_magnitude")


def decide_absolute_metric(
    metric: float,
    *,
    target: float | None,
    absolute_uncertainty_bound: float | None,
) -> EvidenceDecision:
    """Evaluate |true_metric - metric| <= uncertainty against true_metric <= target.

    The metric is nonnegative. Bounds are rounded outward by one representable
    step when uncertainty is nonzero; this avoids a rounded boundary causing a
    false pass/flag. Unknown uncertainty is not zero uncertainty. A zero bound
    must itself be justified; callers must not use zero to bypass uncertainty.
    """
    _nonnegative(metric)
    if target is not None:
        _nonnegative(target)
    if absolute_uncertainty_bound is not None:
        _nonnegative(absolute_uncertainty_bound)
    if target is None or absolute_uncertainty_bound is None:
        return EvidenceDecision(
            "inconclusive",
            metric,
            target,
            absolute_uncertainty_bound,
            None,
            None,
            "missing_target" if target is None else "missing_uncertainty_bound",
        )
    error = absolute_uncertainty_bound
    if error == 0:
        lower = upper = metric
    else:
        lower = max(0.0, math.nextafter(metric - error, -math.inf))
        upper = math.nextafter(metric + error, math.inf)
    if not math.isfinite(upper):
        return EvidenceDecision(
            "inconclusive", metric, target, error, None, None, "unrepresentable_interval"
        )
    if upper <= target:
        status, reason = "passed_within_tolerance", "whole_interval_within_target"
    elif lower > target:
        status, reason = "flagged", "whole_interval_exceeds_target"
    else:
        status, reason = "inconclusive", "interval_overlaps_target"
    return EvidenceDecision(status, metric, target, error, lower, upper, reason)


def maximum_absolute_drift(values: NDArray[np.float64], *, maximum_samples: int) -> float:
    """max |q(t)-q(0)|, with Euclidean norm for a vector quantity.

    Requires at least two samples. Never divides by an initial invariant, which
    may be zero. Returned units are the original scalar/vector component units.
    Timestamp correspondence/physical interpretation is validated separately.
    """
    if type(maximum_samples) is not int or maximum_samples < 2:
        raise ValueError("Invalid drift sample policy")
    if not isinstance(values, np.ndarray) or values.dtype != np.dtype("float64"):
        raise NumericInputError("invalid_drift_dtype")
    if values.ndim not in (1, 2) or (values.ndim == 2 and values.shape[1] not in (2, 3)):
        raise NumericInputError("invalid_drift_shape")
    if not 2 <= values.shape[0] <= maximum_samples:
        raise NumericInputError("insufficient_or_excess_drift_samples")
    if not np.isfinite(values).all():
        raise NumericInputError("non_finite_drift")
    try:
        with np.errstate(over="raise", invalid="raise", under="raise"):
            difference = values - values[0]
            magnitudes = (
                np.abs(difference) if values.ndim == 1 else np.hypot.reduce(difference, axis=1)
            )
            result = float(np.max(magnitudes))
            if not math.isfinite(result):
                raise NumericInputError("unrepresentable_drift")
            return result
    except FloatingPointError:
        raise NumericInputError("unrepresentable_drift") from None
