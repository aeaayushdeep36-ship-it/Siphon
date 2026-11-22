"""Analytic closed-form reference solutions and error norm evaluators for heat diffusion.

Provides:
- Exact 2D Fourier mode reference evaluator with continuous and cell-averaged representations.
- Rigorous L^2 discrete volume-weighted error norm, L^infinity max norm, and relative error calculations.
"""

from typing import Any

import numpy as np
from numpy.typing import NDArray


def evaluate_fourier_analytic_mode(
    times: NDArray[np.float64] | float,
    x_coords: NDArray[np.float64],
    y_coords: NDArray[np.float64],
    *,
    dx: float,
    dy: float,
    alpha: float,
    t0: float = 300.0,
    amplitude: float = 10.0,
    kx: float | None = None,
    ky: float | None = None,
    lx: float = 0.1,
    ly: float = 0.1,
    mode_x: int = 1,
    mode_y: int = 1,
    cell_averaged: bool = True,
) -> NDArray[np.float64]:
    """Evaluate exact 2D Fourier mode analytical solution.

    For initial condition T(x, y, 0) = T0 + A * cos(kx * x) * cos(ky * y) on a periodic domain,
    the continuous PDE solution is:
        T(x, y, t) = T0 + A * cos(kx * x) * cos(ky * y) * exp(-lambda * t)
    where lambda = alpha * (kx^2 + ky^2).

    When cell_averaged is True, the cell average over [x - dx/2, x + dx/2] x [y - dy/2, y + dy/2]
    incorporates exact sinc factors:
        Sx = sin(kx * dx / 2) / (kx * dx / 2)
        Sy = sin(ky * dy / 2) / (ky * dy / 2)
    eliminating O(dx^2) representation error when comparing with finite-volume cell averages.
    """
    times_arr = np.atleast_1d(np.asarray(times, dtype=np.float64))
    x_arr = np.asarray(x_coords, dtype=np.float64)
    y_arr = np.asarray(y_coords, dtype=np.float64)

    # Determine 2D grid coordinates
    if x_arr.ndim == 1 and y_arr.ndim == 1:
        grid_x, grid_y = np.meshgrid(x_arr, y_arr, indexing="ij")
    elif x_arr.ndim == 2 and y_arr.ndim == 2:
        grid_x, grid_y = x_arr, y_arr
    else:
        raise ValueError("x_coords and y_coords must both be 1D or both be 2D arrays")

    # Wavenumbers
    actual_kx = kx if kx is not None else (2.0 * np.pi * mode_x / lx)
    actual_ky = ky if ky is not None else (2.0 * np.pi * mode_y / ly)
    lam = alpha * (actual_kx**2 + actual_ky**2)

    # Sinc correction for finite-volume cell averages
    if cell_averaged:
        sx = (
            np.sin(actual_kx * dx / 2.0) / (actual_kx * dx / 2.0)
            if (dx > 0 and actual_kx != 0)
            else 1.0
        )
        sy = (
            np.sin(actual_ky * dy / 2.0) / (actual_ky * dy / 2.0)
            if (dy > 0 and actual_ky != 0)
            else 1.0
        )
    else:
        sx, sy = 1.0, 1.0

    spatial_pattern = (
        amplitude * np.cos(actual_kx * grid_x) * np.cos(actual_ky * grid_y) * (sx * sy)
    )

    # Broadcast over times: shape (N_times, Nx, Ny)
    t_decay = np.exp(-lam * times_arr)[:, np.newaxis, np.newaxis]
    result = t0 + spatial_pattern[np.newaxis, :, :] * t_decay

    if np.ndim(times) == 0:
        return result[0]
    return result


def compute_heat_error_norms(
    numerical: NDArray[np.float64],
    exact: NDArray[np.float64],
    weights: NDArray[np.float64],
    *,
    t0: float = 300.0,
) -> dict[str, Any]:
    """Compute discrete L^2 volume-weighted norm, L^infinity norm, and relative errors.

    Parameters:
    - numerical: NDArray of shape (N_samples, Nx, Ny) or (Nx, Ny)
    - exact: NDArray of matching shape
    - weights: NDArray of cell volume weights of shape (Nx, Ny)
    - t0: base reference temperature for relative error scaling
    """
    num = np.asarray(numerical, dtype=np.float64)
    exa = np.asarray(exact, dtype=np.float64)
    w = np.asarray(weights, dtype=np.float64)

    if num.shape != exa.shape:
        raise ValueError(f"Shape mismatch: numerical {num.shape} vs exact {exa.shape}")

    total_vol = float(np.sum(w))
    if total_vol <= 0.0:
        raise ValueError(f"Total physical volume weight must be positive: {total_vol}")

    # Single snapshot case
    if num.ndim == 2:
        diff = num - exa
        l2 = float(np.sqrt(np.sum(w * (diff**2)) / total_vol))
        linf = float(np.max(np.abs(diff)))
        ref_norm = float(np.sqrt(np.sum(w * ((exa - t0) ** 2)) / total_vol))
        rel_l2 = float(l2 / ref_norm) if ref_norm > 1e-14 else 0.0
        return {
            "l2_error_final": l2,
            "l2_error_max": l2,
            "linf_error_final": linf,
            "linf_error_max": linf,
            "relative_l2_final": rel_l2,
            "relative_l2_max": rel_l2,
            "l2_series": np.array([l2], dtype=np.float64),
            "linf_series": np.array([linf], dtype=np.float64),
        }

    # Time series case: shape (N_samples, Nx, Ny)
    diff = num - exa
    # Weighted mean squared error at each time sample
    # diff**2 shape is (N_samples, Nx, Ny), w shape is (Nx, Ny)
    mse_series = np.sum(w[np.newaxis, :, :] * (diff**2), axis=(1, 2)) / total_vol
    l2_series = np.sqrt(mse_series)
    linf_series = np.max(np.abs(diff), axis=(1, 2))

    ref_mse = np.sum(w[np.newaxis, :, :] * ((exa - t0) ** 2), axis=(1, 2)) / total_vol
    ref_norm_series = np.sqrt(ref_mse)
    rel_l2_series = np.where(ref_norm_series > 1e-14, l2_series / ref_norm_series, 0.0)

    return {
        "l2_error_final": float(l2_series[-1]),
        "l2_error_max": float(np.max(l2_series)),
        "linf_error_final": float(linf_series[-1]),
        "linf_error_max": float(np.max(linf_series)),
        "relative_l2_final": float(rel_l2_series[-1]),
        "relative_l2_max": float(np.max(rel_l2_series)),
        "l2_series": l2_series,
        "linf_series": linf_series,
    }
