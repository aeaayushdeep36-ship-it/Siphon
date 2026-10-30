"""Exact comparison of already decoded original/adapted baseline observations.

Matching is necessary but not sufficient for adapter verification: source/run
provenance, extraction semantics and identical baseline controls remain separate.
"""

import math
import re
from typing import Literal, TypedDict

import numpy as np
from numpy.typing import NDArray

from .numeric_inputs import NumericInputError
from .validation_job import _validate_request, validate_observation_job


class ObservationComparison(TypedDict):
    key: str
    status: Literal["matched", "mismatched"]
    reason: str | None


class BaselineComparison(TypedDict):
    schemaVersion: str
    status: Literal["matched", "mismatched"]
    comparedElements: int
    observations: list[ObservationComparison]


def compare_validated_baseline_jobs(
    original_request,
    original_payloads,
    adapted_request,
    adapted_payloads,
    *,
    maximum_total_bytes,
    maximum_total_elements,
):
    """Revalidate both data-only exports before exact comparison.

    Caller must separately authorize both runs, evaluator, and provenance. A
    match does not by itself certify the meaning of the selected mappings.
    """
    if type(maximum_total_bytes) is not int or maximum_total_bytes < 1:
        raise ValueError("Invalid baseline byte policy")
    if type(maximum_total_elements) is not int or maximum_total_elements < 1:
        raise ValueError("Invalid baseline element policy")
    left, right = _validate_request(original_request), _validate_request(adapted_request)
    if (
        left["sourceOperationId"] == right["sourceOperationId"]
        or left["evaluationOperationId"] == right["evaluationOperationId"]
        or left["inputDigest"] != right["inputDigest"]
        or left["adapterDigest"] != right["adapterDigest"]
        or left["mappings"] != right["mappings"]
    ):
        raise NumericInputError("baseline_snapshot_mismatch")
    descriptors = left["manifest"]["observations"] + right["manifest"]["observations"]
    if (
        sum(item["bytes"] for item in descriptors) > maximum_total_bytes
        or sum(math.prod(item["shape"]) for item in descriptors) > maximum_total_elements
    ):
        raise NumericInputError("baseline_resource_limit")
    _, original = validate_observation_job(left, original_payloads)
    _, adapted = validate_observation_job(right, adapted_payloads)
    return compare_baselines(
        {key: item.values for key, item in original.items()},
        {key: item.values for key, item in adapted.items()},
        required_keys=tuple(item["key"] for item in left["mappings"]),
        maximum_total_elements=maximum_total_elements,
    )


def compare_baselines(
    original: dict[str, NDArray[np.float64]],
    adapted: dict[str, NDArray[np.float64]],
    *,
    required_keys: tuple[str, ...],
    maximum_total_elements: int,
) -> BaselineComparison:
    """No alignment, interpolation, sorting, axis repair or relaxed tolerance.

    Keys are generated observation identifiers, never paths or expressions.
    The combined input element cap includes both runs and mismatching arrays.
    Numeric equality treats positive/negative zero as equal. NaN never matches.
    """
    if type(maximum_total_elements) is not int or maximum_total_elements < 1:
        raise ValueError("Invalid fidelity resource policy")
    if not isinstance(required_keys, tuple) or not 1 <= len(required_keys) <= 64:
        raise ValueError("Invalid required observation set")
    if any(
        not isinstance(key, str) or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key) is None
        for key in required_keys
    ):
        raise ValueError("Invalid observation identifier")
    if len(set(required_keys)) != len(required_keys):
        raise ValueError("Duplicate observation identifier")
    if not isinstance(original, dict) or not isinstance(adapted, dict):
        raise NumericInputError("invalid_baseline_collection")
    total = 0
    for collection in (original, adapted):
        if set(collection) - set(required_keys):
            raise NumericInputError("unexpected_baseline_observation")
        for values in collection.values():
            if not isinstance(values, np.ndarray) or values.dtype != np.dtype("float64"):
                raise NumericInputError("invalid_baseline_dtype")
            if values.size == 0 or values.ndim > 4:
                raise NumericInputError("invalid_baseline_shape")
            total += values.size
            if total > maximum_total_elements:
                raise NumericInputError("baseline_element_limit")
    # Validate complete inputs before calculating any match results.
    for collection in (original, adapted):
        for values in collection.values():
            if not np.isfinite(values).all():
                raise NumericInputError("non_finite_baseline")
    observations: list[ObservationComparison] = []
    compared = 0
    for key in required_keys:
        left, right = original.get(key), adapted.get(key)
        reason = None
        if left is None and right is None:
            reason = "missing_both"
        elif left is None:
            reason = "missing_original"
        elif right is None:
            reason = "missing_adapted"
        elif left.shape != right.shape:
            reason = "shape_mismatch"
        else:
            compared += left.size
            if not np.array_equal(left, right):
                reason = "value_mismatch"
        observations.append(
            {"key": key, "status": "matched" if reason is None else "mismatched", "reason": reason}
        )
    return {
        "schemaVersion": "1.0",
        "status": "matched"
        if all(item["status"] == "matched" for item in observations)
        else "mismatched",
        "comparedElements": compared,
        "observations": observations,
    }
