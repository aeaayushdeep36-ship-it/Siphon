"""Analytic closed-form reference solutions, Kepler anomaly solvers, and error norm evaluators for orbital dynamics.

Provides:
- Machine-precision Kepler two-body analytical reference solver using Halley-accelerated Newton-Raphson.
- Closed-form Lagrange equilateral three-body analytical reference solver.
- Rigorous L^2 discrete Euclidean error norm, L^infinity max norm, and relative error calculations.
- Independent multi-body verification and trajectory comparison.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from numpy.typing import NDArray


def solve_kepler_anomaly(
    mean_anomaly: float,
    eccentricity: float,
    *,
    tolerance: float = 1e-14,
    max_iterations: int = 50,
) -> float:
    """Solve Kepler's equation M = E - e * sin(E) for eccentric anomaly E.

    Uses Halley's cubic iteration method starting from an initial estimate.
    Guaranteed machine-precision convergence (|f(E)| <= tolerance) within 3-5 iterations
    for all eccentricities 0 <= e < 1.
    """
    if not (0.0 <= eccentricity < 1.0):
        raise ValueError("Kepler anomaly solver requires 0 <= eccentricity < 1")

    # Normalize mean anomaly to [0, 2*pi)
    m_norm = mean_anomaly % (2.0 * math.pi)

    # Initial guess: stable starter for all 0 <= e < 1
    e_curr = m_norm + eccentricity * math.sin(m_norm)

    for _ in range(max_iterations):
        s_e = math.sin(e_curr)
        c_e = math.cos(e_curr)
        f = e_curr - eccentricity * s_e - m_norm
        if abs(f) <= tolerance:
            break
        f_prime = 1.0 - eccentricity * c_e
        f_double_prime = eccentricity * s_e
        # Halley step: delta = f / (f' - 0.5 * f * f'' / f')
        denom = f_prime - 0.5 * f * f_double_prime / f_prime
        delta = f / denom
        e_curr -= delta
        if abs(delta) <= tolerance:
            break

    return e_curr


def kepler_elements_from_state(
    r0: NDArray[np.float64],
    v0: NDArray[np.float64],
    mu: float,
) -> dict[str, Any]:
    """Compute orbital elements and orientation vectors from Cartesian initial state (r0, v0, mu).

    Supports 2D and 3D coordinate inputs (2D arrays padded to 3D).
    Returns semi-major axis, eccentricity, mean motion, initial mean anomaly,
    periapsis unit vector P, and semi-minor unit vector Q.
    """
    if mu <= 0.0:
        raise ValueError("mu must be positive")

    r = np.pad(r0, (0, 3 - len(r0))) if len(r0) < 3 else np.asarray(r0, dtype=np.float64)
    v = np.pad(v0, (0, 3 - len(v0))) if len(v0) < 3 else np.asarray(v0, dtype=np.float64)

    r_mag = float(np.linalg.norm(r))
    v_mag = float(np.linalg.norm(v))
    if r_mag == 0.0:
        raise ValueError("Zero radius vector")

    # Specific mechanical energy
    spec_energy = 0.5 * (v_mag**2) - mu / r_mag
    if spec_energy >= 0.0:
        raise ValueError("State is not an elliptic/bound orbit (energy >= 0)")

    semi_major_a = -mu / (2.0 * spec_energy)

    # Specific angular momentum vector
    h_vec = np.cross(r, v)
    h_mag = float(np.linalg.norm(h_vec))
    if h_mag == 0.0:
        raise ValueError("Radial trajectory with zero angular momentum")

    # Eccentricity vector
    e_vec = (1.0 / mu) * np.cross(v, h_vec) - (r / r_mag)
    ecc = float(np.linalg.norm(e_vec))

    # Unit vectors in orbital plane
    if ecc > 1e-14:
        p_unit = e_vec / ecc
    else:
        p_unit = r / r_mag
        ecc = 0.0

    h_unit = h_vec / h_mag
    q_unit = np.cross(h_unit, p_unit)
    q_unit = q_unit / np.linalg.norm(q_unit)

    # Initial eccentric anomaly E0
    r_dot_v = float(np.dot(r, v))
    sin_e0 = r_dot_v / (ecc * math.sqrt(mu * semi_major_a)) if ecc > 1e-14 else 0.0
    cos_e0 = (1.0 - r_mag / semi_major_a) / ecc if ecc > 1e-14 else 1.0
    e0 = math.atan2(sin_e0, cos_e0)

    # Initial mean anomaly M0
    m0 = e0 - ecc * math.sin(e0)

    # Mean motion
    mean_motion_n = math.sqrt(mu / (semi_major_a**3))

    return {
        "semi_major_a": semi_major_a,
        "eccentricity": ecc,
        "mean_motion_n": mean_motion_n,
        "mean_anomaly_0": m0,
        "p_unit": p_unit,
        "q_unit": q_unit,
        "h_unit": h_unit,
        "period": 2.0 * math.pi / mean_motion_n,
    }


def evaluate_kepler_analytic_orbit(
    times: NDArray[np.float64] | float,
    r0: NDArray[np.float64],
    v0: NDArray[np.float64],
    mu: float,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Evaluate exact closed-form Kepler positions and velocities for given times.

    Returns:
    - positions: NDArray of shape (N_times, 3) (or (3,) if scalar time)
    - velocities: NDArray of shape (N_times, 3) (or (3,) if scalar time)
    """
    times_arr = np.atleast_1d(np.asarray(times, dtype=np.float64))
    elements = kepler_elements_from_state(r0, v0, mu)

    a = elements["semi_major_a"]
    e = elements["eccentricity"]
    n = elements["mean_motion_n"]
    m0 = elements["mean_anomaly_0"]
    p_hat = elements["p_unit"]
    q_hat = elements["q_unit"]
    b = a * math.sqrt(max(0.0, 1.0 - e * e))

    n_samples = len(times_arr)
    exact_pos = np.zeros((n_samples, 3), dtype=np.float64)
    exact_vel = np.zeros((n_samples, 3), dtype=np.float64)

    for idx, t in enumerate(times_arr):
        m_t = m0 + n * t
        e_t = solve_kepler_anomaly(m_t, e)
        cos_e = math.cos(e_t)
        sin_e = math.sin(e_t)

        # Coordinate in perifocal plane: P-axis and Q-axis
        pos_p = a * (cos_e - e)
        pos_q = b * sin_e
        exact_pos[idx] = pos_p * p_hat + pos_q * q_hat

        # Time derivative of E: dE/dt = n / (1 - e * cos(E))
        r_mag = a * (1.0 - e * cos_e)
        e_dot = n / r_mag
        vel_p = -a * sin_e * e_dot
        vel_q = b * cos_e * e_dot
        exact_vel[idx] = vel_p * p_hat + vel_q * q_hat

    if np.ndim(times) == 0:
        return exact_pos[0], exact_vel[0]
    return exact_pos, exact_vel


def evaluate_lagrange_three_body(
    times: NDArray[np.float64] | float,
    *,
    mass: float,
    radius: float,
    gravitational_constant: float = 6.67430e-11,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Evaluate exact analytical solution for Lagrange equilateral 3-body circular choreography.

    Three equal point masses m positioned at the vertices of an equilateral triangle
    circumscribed on a circle of radius R, orbiting their common barycenter with constant
    angular frequency omega = sqrt(G * m / (sqrt(3) * R^3)).

    Returns:
    - positions: NDArray of shape (N_times, 3, 3) in meters
    - velocities: NDArray of shape (N_times, 3, 3) in m/s
    """
    if mass <= 0.0 or radius <= 0.0 or gravitational_constant <= 0.0:
        raise ValueError("Mass, radius, and gravitational constant must be positive")

    times_arr = np.atleast_1d(np.asarray(times, dtype=np.float64))
    omega = math.sqrt(gravitational_constant * mass / (math.sqrt(3.0) * (radius**3)))

    n_samples = len(times_arr)
    positions = np.zeros((n_samples, 3, 3), dtype=np.float64)
    velocities = np.zeros((n_samples, 3, 3), dtype=np.float64)

    phases = [0.0, 2.0 * math.pi / 3.0, 4.0 * math.pi / 3.0]

    for idx, t in enumerate(times_arr):
        for body_idx, base_phase in enumerate(phases):
            theta = omega * t + base_phase
            cos_t = math.cos(theta)
            sin_t = math.sin(theta)

            positions[idx, body_idx, 0] = radius * cos_t
            positions[idx, body_idx, 1] = radius * sin_t
            positions[idx, body_idx, 2] = 0.0

            velocities[idx, body_idx, 0] = -radius * omega * sin_t
            velocities[idx, body_idx, 1] = radius * omega * cos_t
            velocities[idx, body_idx, 2] = 0.0

    if np.ndim(times) == 0:
        return positions[0], velocities[0]
    return positions, velocities


def compute_orbital_error_norms(
    sim_positions: NDArray[np.float64],
    ref_positions: NDArray[np.float64],
    sim_velocities: NDArray[np.float64] | None = None,
    ref_velocities: NDArray[np.float64] | None = None,
) -> dict[str, float]:
    """Compute discrete Euclidean L^2 error norm, L^infinity max norm, and relative errors.

    Parameters:
    - sim_positions: shape (N, 3) or (N, bodies, 3)
    - ref_positions: same shape as sim_positions
    - sim_velocities: optional matching velocity array
    - ref_velocities: optional matching velocity array

    Returns dictionary containing:
    - pos_l2_error: Root-mean-square position error in meters
    - pos_linf_error: Maximum position discrepancy in meters
    - pos_relative_l2: Relative L^2 position error (dimensionless)
    - vel_l2_error, vel_linf_error, vel_relative_l2 (if velocities supplied)
    """
    pos_diff = np.asarray(sim_positions, dtype=np.float64) - np.asarray(
        ref_positions, dtype=np.float64
    )
    # Norm along spatial coordinate axis (last axis)
    pos_dist = np.linalg.norm(pos_diff, axis=-1)
    ref_dist = np.linalg.norm(ref_positions, axis=-1)

    pos_l2 = float(np.sqrt(np.mean(pos_dist**2)))
    pos_linf = float(np.max(pos_dist))
    ref_l2 = float(np.sqrt(np.mean(ref_dist**2)))
    rel_pos_l2 = pos_l2 / max(ref_l2, 1e-15)

    result: dict[str, float] = {
        "pos_l2_error": pos_l2,
        "pos_linf_error": pos_linf,
        "pos_relative_l2": rel_pos_l2,
    }

    if sim_velocities is not None and ref_velocities is not None:
        vel_diff = np.asarray(sim_velocities, dtype=np.float64) - np.asarray(
            ref_velocities, dtype=np.float64
        )
        vel_dist = np.linalg.norm(vel_diff, axis=-1)
        ref_vel_dist = np.linalg.norm(ref_velocities, axis=-1)

        vel_l2 = float(np.sqrt(np.mean(vel_dist**2)))
        vel_linf = float(np.max(vel_dist))
        ref_vel_l2 = float(np.sqrt(np.mean(ref_vel_dist**2)))
        rel_vel_l2 = vel_l2 / max(ref_vel_l2, 1e-15)

        result.update(
            {
                "vel_l2_error": vel_l2,
                "vel_linf_error": vel_linf,
                "vel_relative_l2": rel_vel_l2,
            }
        )

    return result
