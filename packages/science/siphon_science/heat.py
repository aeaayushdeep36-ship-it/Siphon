"""Constant-material heat diagnostics with explicitly supplied physical weights.

No mesh, thickness, boundary flux, units or accuracy target is inferred here.
"""

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .numeric_inputs import NumericInputError


@dataclass(frozen=True)
class HeatBalance:
    energy_change_j: NDArray[np.float64]
    integrated_net_input_j: NDArray[np.float64]
    residual_j: NDArray[np.float64]
    time_quadrature: str = "piecewise_linear_trapezoidal"


def _policy(*limits: int) -> None:
    if any(type(limit) is not int or limit < 1 for limit in limits):
        raise ValueError("Invalid heat resource policy")


def _array(value: NDArray) -> None:
    if not isinstance(value, np.ndarray) or value.dtype != np.dtype("float64"):
        raise NumericInputError("invalid_heat_dtype")


def thermal_energy_change_si(
    temperature_k: NDArray[np.float64],
    volume_weights_m3: NDArray[np.float64],
    *,
    density_kg_m3: float,
    heat_capacity_j_kg_k: float,
    maximum_samples: int,
    maximum_grid_values: int,
) -> NDArray[np.float64]:
    """Delta energy from first sample: rho*c*sum(weights*(T(t)-T(0))).

    Temperatures: (sample, x) or (sample, x, y), already in Kelvin.
    Weights match spatial shape and contain physical volume or reviewed nodal
    quadrature weights including cross-section/thickness. Positive weights only;
    remove ghost/duplicated periodic nodes through a verified mapping first.
    """
    _policy(maximum_samples, maximum_grid_values)
    _array(temperature_k)
    _array(volume_weights_m3)
    if temperature_k.ndim not in (2, 3) or temperature_k.shape[1:] != volume_weights_m3.shape:
        raise NumericInputError("invalid_heat_shape")
    if (
        not 1 <= temperature_k.shape[0] <= maximum_samples
        or not 1 <= volume_weights_m3.size <= maximum_grid_values
    ):
        raise NumericInputError("heat_dimension_limit")
    for parameter in (density_kg_m3, heat_capacity_j_kg_k):
        if (
            isinstance(parameter, bool)
            or not isinstance(parameter, (int, float))
            or not math.isfinite(parameter)
            or parameter <= 0
        ):
            raise NumericInputError("invalid_heat_material")
    if (
        not np.isfinite(temperature_k).all()
        or not np.isfinite(volume_weights_m3).all()
        or np.any(volume_weights_m3 <= 0)
    ):
        raise NumericInputError("invalid_heat_values")
    # Negative modeled temperatures are retained as observations, not hidden by
    # parser rejection. Their interpretation requires context and separate checks.
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise", under="raise"):
            capacities = volume_weights_m3 * density_kg_m3 * heat_capacity_j_kg_k
            # One spatial slice at a time bounds temporary memory and avoids
            # subtracting two separately summed large absolute energies.
            change = np.array(
                [
                    math.fsum(((sample - temperature_k[0]) * capacities).flat)
                    for sample in temperature_k
                ],
                dtype=np.float64,
            )
            if not np.isfinite(change).all():
                raise NumericInputError("unrepresentable_heat_result")
            change.setflags(write=False)
            return change
    except (FloatingPointError, OverflowError):
        raise NumericInputError("unrepresentable_heat_result") from None


def heat_balance_si(
    times_s: NDArray[np.float64],
    energy_change_j: NDArray[np.float64],
    source_power_w: NDArray[np.float64],
    outward_power_w: NDArray[np.float64],
    *,
    maximum_samples: int,
) -> HeatBalance:
    """Residual = observed delta energy - integral(source - outward power).

    Source power is already volume-integrated; outward power is already
    surface-integrated with outward-positive sign. Both must be independently
    extracted, not reconstructed from energy changes being checked. Sampling
    quadrature uncertainty is unresolved here; no pass/fail is returned.
    """
    _policy(maximum_samples)
    for value in (times_s, energy_change_j, source_power_w, outward_power_w):
        _array(value)
        if value.ndim != 1 or value.shape != times_s.shape:
            raise NumericInputError("invalid_heat_balance_shape")
    if not 2 <= times_s.size <= maximum_samples:
        raise NumericInputError("heat_balance_sample_limit")
    if any(
        not np.isfinite(value).all()
        for value in (times_s, energy_change_j, source_power_w, outward_power_w)
    ):
        raise NumericInputError("invalid_heat_values")
    if np.any(times_s[1:] <= times_s[:-1]):
        raise NumericInputError("non_increasing_time")
    if energy_change_j[0] != 0:
        raise NumericInputError("heat_energy_reference_mismatch")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise", under="raise"):
            net = source_power_w - outward_power_w
            increments = (times_s[1:] - times_s[:-1]) * (0.5 * net[:-1] + 0.5 * net[1:])
            integrated = np.zeros(times_s.size, dtype=np.float64)
            total = np.float64(0)
            compensation = np.float64(0)
            for index, increment in enumerate(increments, start=1):
                adjusted = increment - compensation
                updated = total + adjusted
                compensation = (updated - total) - adjusted
                total = updated
                integrated[index] = total
            observed = energy_change_j.copy()
            residual = observed - integrated
            for result in (observed, integrated, residual):
                if not np.isfinite(result).all():
                    raise NumericInputError("unrepresentable_heat_result")
                result.setflags(write=False)
            return HeatBalance(observed, integrated, residual)
    except (FloatingPointError, OverflowError):
        raise NumericInputError("unrepresentable_heat_result") from None
