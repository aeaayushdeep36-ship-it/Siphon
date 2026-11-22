"""Spatial and temporal convergence rate verification for heat diffusion solvers.

Verifies:
- Spatial order of convergence p ~= 2.00 under diffusive CFL scaling (r = alpha * dt / dx^2 = const).
- Temporal order of convergence q ~= 1.00 under time-step refinement on a fine spatial mesh.
"""

from typing import Any

import numpy as np

from .heat_reference import compute_heat_error_norms, evaluate_fourier_analytic_mode


def _run_ftcs_diffusion_2d(
    nx: int,
    ny: int,
    steps: int,
    dt: float,
    *,
    lx: float,
    ly: float,
    alpha: float,
    t0: float,
    amplitude: float,
    kx: float,
    ky: float,
    cell_averaged: bool = True,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, float]:
    """Single-run 2D FTCS diffusion solver with periodic boundaries."""
    dx = lx / nx
    dy = ly / ny
    x = (np.arange(nx, dtype=np.float64) + 0.5) * dx
    y = (np.arange(ny, dtype=np.float64) + 0.5) * dy
    grid_x, grid_y = np.meshgrid(x, y, indexing="ij")

    # Initial condition using reference evaluator at t=0
    temp = evaluate_fourier_analytic_mode(
        0.0,
        grid_x,
        grid_y,
        dx=dx,
        dy=dy,
        alpha=alpha,
        t0=t0,
        amplitude=amplitude,
        kx=kx,
        ky=ky,
        cell_averaged=cell_averaged,
    )

    for _ in range(steps):
        lap_x = (np.roll(temp, 1, axis=0) - 2.0 * temp + np.roll(temp, -1, axis=0)) / (dx**2)
        lap_y = (np.roll(temp, 1, axis=1) - 2.0 * temp + np.roll(temp, -1, axis=1)) / (dy**2)
        temp = temp + alpha * dt * (lap_x + lap_y)

    return temp, grid_x, grid_y, dx, dy


def verify_spatial_convergence(
    grid_sizes: tuple[int, ...] = (16, 32, 64),
    *,
    lx: float = 0.1,
    ly: float = 0.1,
    lz: float = 0.01,
    rho: float = 8960.0,
    cp: float = 385.0,
    k_cond: float = 400.0,
    r_cfl: float = 0.1,
    t_target: float = 0.5,
    t0: float = 300.0,
    amplitude: float = 10.0,
) -> dict[str, Any]:
    """Verify spatial convergence order p ~= 2.00 under diffusive CFL scaling.

    When halving dx, dt is scaled proportional to dx^2 so that the diffusive Fourier number
    r = alpha * dt / dx^2 remains constant. Under this scaling, the temporal truncation error
    O(dt) = O(dx^2), allowing the O(dx^2) spatial discretization error to dominate and be measured.
    """
    alpha = k_cond / (rho * cp)
    kx = 2.0 * np.pi / lx
    ky = 2.0 * np.pi / ly

    errors = []
    actual_t_ends = []

    for nx in grid_sizes:
        ny = nx
        dx = lx / nx
        dy = ly / ny
        dt = r_cfl * (dx**2) / (2.0 * alpha)
        steps = int(round(t_target / dt))
        t_end = steps * dt
        actual_t_ends.append(t_end)

        temp, grid_x, grid_y, _, _ = _run_ftcs_diffusion_2d(
            nx,
            ny,
            steps,
            dt,
            lx=lx,
            ly=ly,
            alpha=alpha,
            t0=t0,
            amplitude=amplitude,
            kx=kx,
            ky=ky,
            cell_averaged=True,
        )

        exact = evaluate_fourier_analytic_mode(
            t_end,
            grid_x,
            grid_y,
            dx=dx,
            dy=dy,
            alpha=alpha,
            t0=t0,
            amplitude=amplitude,
            kx=kx,
            ky=ky,
            cell_averaged=True,
        )

        weights = np.full((nx, ny), dx * dy * lz, dtype=np.float64)
        norms = compute_heat_error_norms(temp, exact, weights, t0=t0)
        errors.append(norms["l2_error_final"])

    # Compute observed order of convergence between successive grid levels
    orders = [float(np.log2(errors[i] / errors[i + 1])) for i in range(len(errors) - 1)]

    return {
        "grid_sizes": list(grid_sizes),
        "l2_errors": errors,
        "orders": orders,
        "mean_order": float(np.mean(orders)),
        "actual_t_ends": actual_t_ends,
    }


def verify_temporal_convergence(
    refinement_factors: tuple[int, ...] = (1, 2, 4),
    *,
    nx: int = 64,
    dt_base: float = 4.0e-3,
    lx: float = 0.1,
    ly: float = 0.1,
    lz: float = 0.01,
    rho: float = 8960.0,
    cp: float = 385.0,
    k_cond: float = 400.0,
    t_target: float = 0.2,
    t0: float = 300.0,
    amplitude: float = 10.0,
) -> dict[str, Any]:
    """Verify temporal convergence order q ~= 1.00 on a fine spatial mesh.

    On a fine spatial mesh (e.g. Nx=64), spatial error is fixed and small.
    By testing successive time steps dt, dt/2, dt/4, the Cauchy differences
    d1 = ||T_dt - T_dt/2||_2 and d2 = ||T_dt/2 - T_dt/4||_2 reveal the temporal
    convergence rate q = log2(d1 / d2) ~= 1.00 for the first-order Forward Euler scheme.
    """
    alpha = k_cond / (rho * cp)
    kx = 2.0 * np.pi / lx
    ky = 2.0 * np.pi / ly
    dx = lx / nx
    dy = ly / nx
    weights = np.full((nx, nx), dx * dy * lz, dtype=np.float64)
    total_vol = float(np.sum(weights))

    solutions = []
    dt_values = []

    for factor in refinement_factors:
        dt = dt_base / factor
        dt_values.append(dt)
        steps = int(round(t_target / dt))

        temp, _, _, _, _ = _run_ftcs_diffusion_2d(
            nx,
            nx,
            steps,
            dt,
            lx=lx,
            ly=ly,
            alpha=alpha,
            t0=t0,
            amplitude=amplitude,
            kx=kx,
            ky=ky,
            cell_averaged=True,
        )
        solutions.append(temp)

    cauchy_diffs = []
    for i in range(len(solutions) - 1):
        diff = solutions[i] - solutions[i + 1]
        l2_diff = float(np.sqrt(np.sum(weights * (diff**2)) / total_vol))
        cauchy_diffs.append(l2_diff)

    orders = [
        float(np.log2(cauchy_diffs[i] / cauchy_diffs[i + 1])) for i in range(len(cauchy_diffs) - 1)
    ]

    return {
        "dt_values": dt_values,
        "cauchy_diffs": cauchy_diffs,
        "orders": orders,
        "temporal_order": orders[0] if orders else None,
    }
