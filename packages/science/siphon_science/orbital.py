"""Newtonian invariant diagnostics in explicitly converted SI coordinates.

These routines do not verify a model's force law or select verdict tolerances.
The caller must establish eligibility, frame, units and artifact provenance.
"""

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from .numeric_inputs import NumericInputError


@dataclass(frozen=True)
class IsolatedInvariants:
    energy_j: NDArray[np.float64]
    angular_momentum_kg_m2_s: NDArray[np.float64]
    momentum_kg_m_s: NDArray[np.float64]
    center_of_mass_m: NDArray[np.float64]


@dataclass(frozen=True)
class CentralInvariants:
    specific_energy_m2_s2: NDArray[np.float64]
    specific_angular_momentum_m2_s: NDArray[np.float64]


def _limit(value: int) -> None:
    if type(value) is not int or value < 1:
        raise ValueError("Invalid orbital resource policy")


def _positive(value: float) -> None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise NumericInputError("invalid_gravity_parameter")


def _array(value: NDArray) -> None:
    if not isinstance(value, np.ndarray) or value.dtype != np.dtype("float64"):
        raise NumericInputError("invalid_orbital_dtype")


def _readonly(*arrays: NDArray) -> None:
    for array in arrays:
        if not np.isfinite(array).all():
            raise NumericInputError("unrepresentable_orbital_result")
        array.setflags(write=False)


def _sum_rows(values: NDArray[np.float64]) -> NDArray[np.float64]:
    return np.array([math.fsum(row) for row in values], dtype=np.float64)


def _pad(values: NDArray[np.float64]) -> NDArray[np.float64]:
    if values.shape[-1] == 3:
        return values
    return np.concatenate((values, np.zeros((*values.shape[:-1], 1))), axis=-1)


def isolated_invariants_si(
    positions_m: NDArray[np.float64],
    velocities_m_s: NDArray[np.float64],
    masses_kg: NDArray[np.float64],
    *,
    gravitational_constant: float,
    maximum_samples: int,
    maximum_bodies: int,
) -> IsolatedInvariants:
    """Arrays (sample, body, 2|3), fixed positive masses (body,).

    Full mutually interacting isolated point-mass model, inertial frame and fixed
    origin only. Massless test particles need a separate profile. No softening.
    Angular momentum is a 3-vector (planar data have zero x/y components).
    """
    _limit(maximum_samples)
    _limit(maximum_bodies)
    _positive(gravitational_constant)
    for value in (positions_m, velocities_m_s, masses_kg):
        _array(value)
    if positions_m.ndim != 3 or positions_m.shape[-1] not in (2, 3):
        raise NumericInputError("invalid_orbital_shape")
    samples, bodies, _ = positions_m.shape
    if not 1 <= samples <= maximum_samples or not 2 <= bodies <= maximum_bodies:
        raise NumericInputError("orbital_dimension_limit")
    if velocities_m_s.shape != positions_m.shape or masses_kg.shape != (bodies,):
        raise NumericInputError("invalid_orbital_shape")
    if any(
        not np.isfinite(value).all() for value in (positions_m, velocities_m_s, masses_kg)
    ) or np.any(masses_kg <= 0):
        raise NumericInputError("invalid_orbital_values")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise", under="raise"):
            r, v = _pad(positions_m), _pad(velocities_m_s)
            kinetic = _sum_rows(0.5 * masses_kg * np.sum(v * v, axis=-1))
            potential = np.zeros(samples, dtype=np.float64)
            compensation = np.zeros(samples, dtype=np.float64)
            for i in range(bodies):
                for j in range(i + 1, bodies):
                    distance = np.hypot.reduce(r[:, i] - r[:, j], axis=-1)
                    if np.any(distance == 0):
                        raise NumericInputError("point_mass_collision")
                    term = -gravitational_constant * masses_kg[i] * masses_kg[j] / distance
                    adjusted = term - compensation
                    updated = potential + adjusted
                    compensation = (updated - potential) - adjusted
                    potential = updated
            energy = kinetic + potential
            weighted_velocity = v * masses_kg[None, :, None]
            momentum = np.stack(
                [_sum_rows(weighted_velocity[:, :, axis]) for axis in range(3)], axis=1
            )
            cross = np.cross(r, weighted_velocity)
            angular = np.stack([_sum_rows(cross[:, :, axis]) for axis in range(3)], axis=1)
            total_mass = math.fsum(masses_kg)
            center = np.stack(
                [_sum_rows(r[:, :, axis] * (masses_kg / total_mass)) for axis in range(3)], axis=1
            )
            _readonly(energy, angular, momentum, center)
            return IsolatedInvariants(energy, angular, momentum, center)
    except (FloatingPointError, OverflowError):
        raise NumericInputError("unrepresentable_orbital_result") from None


def central_invariants_si(
    relative_positions_m: NDArray[np.float64],
    relative_velocities_m_s: NDArray[np.float64],
    *,
    central_mu_m3_s2: float,
    maximum_samples: int,
) -> CentralInvariants:
    """One test trajectory (sample, 2|3) relative to a fixed central source.

    mu=G*M is explicitly supplied. Energy/angular momentum are per unit test
    mass. No isolated-system total momentum is returned for this profile.
    """
    _limit(maximum_samples)
    _positive(central_mu_m3_s2)
    for value in (relative_positions_m, relative_velocities_m_s):
        _array(value)
    r, v = relative_positions_m, relative_velocities_m_s
    if r.ndim != 2 or r.shape[-1] not in (2, 3) or v.shape != r.shape:
        raise NumericInputError("invalid_orbital_shape")
    if not 1 <= r.shape[0] <= maximum_samples:
        raise NumericInputError("orbital_dimension_limit")
    if not np.isfinite(r).all() or not np.isfinite(v).all():
        raise NumericInputError("invalid_orbital_values")
    try:
        with np.errstate(over="raise", invalid="raise", divide="raise", under="raise"):
            distance = np.hypot.reduce(r, axis=-1)
            if np.any(distance == 0):
                raise NumericInputError("point_mass_collision")
            energy = 0.5 * np.sum(v * v, axis=-1) - central_mu_m3_s2 / distance
            angular = np.cross(_pad(r), _pad(v))
            _readonly(energy, angular)
            return CentralInvariants(energy, angular)
    except (FloatingPointError, OverflowError):
        raise NumericInputError("unrepresentable_orbital_result") from None
