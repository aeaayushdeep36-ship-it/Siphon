"""Temporal convergence rate verification for orbital dynamics integrators.

Verifies:
- 2nd-order convergence (p ~= 2.00) for symplectic Velocity-Verlet under step refinement.
- 4th-order convergence (p ~= 4.00) for classical Runge-Kutta (RK4) under step refinement.
- Compares numerical trajectories directly against the exact analytical Kepler reference.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from numpy.typing import NDArray

from .orbital_reference import compute_orbital_error_norms, evaluate_kepler_analytic_orbit


def _run_verlet_kepler(
    r0: NDArray[np.float64],
    v0: NDArray[np.float64],
    mu: float,
    dt: float,
    steps: int,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Integrate two-body central problem using symplectic Velocity-Verlet."""
    r = np.array(r0, dtype=np.float64)
    v = np.array(v0, dtype=np.float64)

    def grav_acc(pos: NDArray[np.float64]) -> NDArray[np.float64]:
        r_mag = float(np.linalg.norm(pos))
        return -mu * pos / (r_mag**3)

    acc = grav_acc(r)
    for _ in range(steps):
        # Position half-kick and drift
        v_half = v + 0.5 * dt * acc
        r = r + dt * v_half
        # Recompute acceleration and finish velocity kick
        acc = grav_acc(r)
        v = v_half + 0.5 * dt * acc

    return r, v


def _run_rk4_kepler(
    r0: NDArray[np.float64],
    v0: NDArray[np.float64],
    mu: float,
    dt: float,
    steps: int,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Integrate two-body central problem using classical 4th-order Runge-Kutta."""
    state = np.concatenate([r0, v0])

    def deriv(s: NDArray[np.float64]) -> NDArray[np.float64]:
        r_curr = s[:3]
        v_curr = s[3:]
        r_mag = float(np.linalg.norm(r_curr))
        a_curr = -mu * r_curr / (r_mag**3)
        return np.concatenate([v_curr, a_curr])

    for _ in range(steps):
        k1 = deriv(state)
        k2 = deriv(state + 0.5 * dt * k1)
        k3 = deriv(state + 0.5 * dt * k2)
        k4 = deriv(state + dt * k3)
        state = state + (dt / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4)

    return state[:3], state[3:]


def verify_orbital_convergence(
    step_multipliers: tuple[int, ...] = (1, 2, 4),
    *,
    base_steps: int = 200,
    r0: NDArray[np.float64] | None = None,
    v0: NDArray[np.float64] | None = None,
    mu: float = 3.986004418e14,
    orbit_fraction: float = 0.5,
    method: str = "verlet",
) -> dict[str, Any]:
    """Verify empirical convergence rate of numerical orbit integrator against exact Kepler solution.

    Parameters:
    - step_multipliers: grid refinement levels (e.g., (1, 2, 4))
    - base_steps: number of steps for coarsest level
    - r0, v0: initial position (m) and velocity (m/s) in 3D
    - mu: central gravitational parameter (m^3/s^2)
    - orbit_fraction: fraction of orbital period to integrate
    - method: 'verlet' (2nd-order) or 'rk4' (4th-order)

    Returns:
    - errors: list of position L^2 errors for each refinement level
    - orders: empirical convergence orders between consecutive levels
    - mean_order: average observed convergence order
    """
    if len(step_multipliers) < 2:
        raise ValueError("At least 2 refinement levels are required to determine convergence order")

    # Default: Low Earth Orbit (perigee 7000 km, e=0.1)
    if r0 is None:
        r0 = np.array([7.0e6, 0.0, 0.0], dtype=np.float64)
    if v0 is None:
        # Perigee velocity for a=7.777e6 m, e=0.1
        vp = math.sqrt(mu * 1.1 / 7.0e6)
        v0 = np.array([0.0, vp, 0.0], dtype=np.float64)

    period = 2.0 * math.pi * math.sqrt((7.0e6 / 0.9) ** 3 / mu)
    t_target = period * orbit_fraction

    exact_pos, exact_vel = evaluate_kepler_analytic_orbit(t_target, r0, v0, mu)

    errors = []
    dts = []

    for mult in step_multipliers:
        total_steps = base_steps * mult
        dt = t_target / total_steps
        dts.append(dt)

        if method == "verlet":
            sim_r, sim_v = _run_verlet_kepler(r0, v0, mu, dt, total_steps)
        elif method == "rk4":
            sim_r, sim_v = _run_rk4_kepler(r0, v0, mu, dt, total_steps)
        else:
            raise ValueError(f"Unknown integration method: {method}")

        norms = compute_orbital_error_norms(
            sim_r, exact_pos, sim_velocities=sim_v, ref_velocities=exact_vel
        )
        errors.append(norms["pos_l2_error"])

    orders = []
    for i in range(len(errors) - 1):
        err_ratio = errors[i] / max(errors[i + 1], 1e-18)
        step_ratio = dts[i] / dts[i + 1]
        p = math.log(err_ratio) / math.log(step_ratio)
        orders.append(p)

    return {
        "step_multipliers": list(step_multipliers),
        "dts": dts,
        "errors": errors,
        "orders": orders,
        "mean_order": float(np.mean(orders)),
        "method": method,
    }
