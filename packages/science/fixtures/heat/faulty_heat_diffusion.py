"""Faulty Heat Diffusion PDE Simulation Fixture with Seeded Unrecorded Flux Leak.

2D Cartesian diffusion setup with pure copper physical parameters:
- Density: rho = 8960.0 kg/m^3
- Specific heat capacity: c_p = 385.0 J/(kg*K)
- Thermal conductivity: k = 400.0 W/(m*K)
- Thermal diffusivity: alpha = k / (rho * c_p) ~= 1.159555e-4 m^2/s

Domain:
- Lx = 0.1 m, Ly = 0.1 m, Lz = 0.01 m (thickness)
- Grid: Nx = 32, Ny = 32 uniform finite-volume cells
- Cell volume weights: V_ij = dx * dy * Lz (m^3)

Seeded Numerical Flaw:
- Unrecorded convective heat loss on the right boundary (x = Lx) to ambient T_amb = 290.0 K
  with heat transfer coefficient h_conv = 50.0 W/(m^2*K).
- The simulation fails to account for this boundary flux in outward_power (exports zero outward power).
- Produces a definite negative thermal energy deficit (< -0.1 J) over 25 steps (t = 0.25 s).
- Flagged by H_ENERGY (non-conservation) and H_BALANCE (residual deficit).

Module-level exports:
- times: float64 array of shape (N_samples,)
- temperature: float64 array of shape (N_samples, Nx, Ny)
- thermal_weights: float64 array of shape (Nx, Ny)
- source_power: float64 array of shape (N_samples,)
- outward_power: float64 array of shape (N_samples,) [unrecorded: all zeros]
- exact_temperature: float64 array of shape (N_samples, Nx, Ny)
"""

import sys

import numpy as np


def run_faulty_simulation(
    lx: float = 0.1,
    ly: float = 0.1,
    lz: float = 0.01,
    nx: int = 32,
    ny: int = 32,
    steps: int = 25,
    dt: float = 0.01,
    rho: float = 8960.0,
    cp: float = 385.0,
    k_cond: float = 400.0,
    t0: float = 300.0,
    amplitude: float = 10.0,
    h_conv: float = 50.0,
    t_ambient: float = 290.0,
):
    alpha = k_cond / (rho * cp)
    dx = lx / nx
    dy = ly / ny
    cell_vol = dx * dy * lz
    area_face = dy * lz

    # Diffusive CFL stability check in 2D
    r_x = alpha * dt / (dx**2)
    r_y = alpha * dt / (dy**2)
    if (r_x + r_y) > 0.5:
        raise ValueError(f"Diffusive CFL limit exceeded: r_x + r_y = {r_x + r_y} > 0.5")

    # Cell-centered grid
    x = (np.arange(nx, dtype=np.float64) + 0.5) * dx
    y = (np.arange(ny, dtype=np.float64) + 0.5) * dy
    grid_x, grid_y = np.meshgrid(x, y, indexing="ij")

    # 2D Fourier fundamental wavenumbers
    kx = 2.0 * np.pi / lx
    ky = 2.0 * np.pi / ly
    lam = alpha * (kx**2 + ky**2)

    # Sinc factors for finite-volume cell-averaged projection
    sinc_x = np.sin(kx * dx / 2.0) / (kx * dx / 2.0) if dx > 0 else 1.0
    sinc_y = np.sin(ky * dy / 2.0) / (ky * dy / 2.0) if dy > 0 else 1.0

    # Initial condition: cell-averaged temperature
    t_curr = t0 + amplitude * np.cos(kx * grid_x) * np.cos(ky * grid_y) * sinc_x * sinc_y

    times_list = [0.0]
    temp_list = [t_curr.copy()]
    exact_list = [t_curr.copy()]

    # Time integration with FTCS 5-point discrete Laplacian plus unrecorded boundary flux leak
    for step in range(1, steps + 1):
        lap_x = (np.roll(t_curr, 1, axis=0) - 2.0 * t_curr + np.roll(t_curr, -1, axis=0)) / (dx**2)
        lap_y = (np.roll(t_curr, 1, axis=1) - 2.0 * t_curr + np.roll(t_curr, -1, axis=1)) / (dy**2)
        t_curr = t_curr + alpha * dt * (lap_x + lap_y)

        # Seeded unrecorded convective heat loss through the right boundary face (x = Lx)
        # Heat flux leaving the domain: q_leak = h_conv * (T_boundary - T_ambient) * area_face
        # Temperature drop in boundary cells: dT = -dt * q_leak / (rho * cp * cell_vol)
        q_leak = h_conv * area_face * (t_curr[-1, :] - t_ambient)
        t_curr[-1, :] -= dt * q_leak / (rho * cp * cell_vol)

        t_sim = step * dt
        times_list.append(t_sim)
        temp_list.append(t_curr.copy())

        # Exact reference without convective defect
        t_exact = t0 + amplitude * np.cos(kx * grid_x) * np.cos(
            ky * grid_y
        ) * sinc_x * sinc_y * np.exp(-lam * t_sim)
        exact_list.append(t_exact)

    times_arr = np.array(times_list, dtype=np.float64)
    temp_arr = np.array(temp_list, dtype=np.float64)
    exact_arr = np.array(exact_list, dtype=np.float64)
    weights_arr = np.full((nx, ny), cell_vol, dtype=np.float64)

    # Flawed simulation: sets outward_power to zero despite physical leak occurring
    source_pwr = np.zeros(times_arr.shape, dtype=np.float64)
    outward_pwr = np.zeros(times_arr.shape, dtype=np.float64)

    return times_arr, temp_arr, weights_arr, source_pwr, outward_pwr, exact_arr


# Module-level exports for standalone execution and observation adapter extraction
(
    times,
    temperature,
    thermal_weights,
    source_power,
    outward_power,
    exact_temperature,
) = run_faulty_simulation()

if __name__ == "__main__":
    rho_val = 8960.0
    cp_val = 385.0

    # Compute discrete energy change relative to initial state
    energy_change = (
        rho_val
        * cp_val
        * np.sum(
            thermal_weights * (temperature - temperature[0, :, :]),
            axis=(1, 2),
        )
    )
    final_dE = energy_change[-1]

    print(f"Faulty Heat Diffusion Simulation Completed ({len(times)} samples, 32x32 grid).")
    print(f"Final thermal energy deficit: {final_dE:.6e} J (expected < -0.1 J)")

    assert final_dE < -0.1, (
        f"Deficit is insufficient to guarantee flagging: final dE = {final_dE} >= -0.1 J"
    )
    print("ALL FAULTY HEAT DIFFUSION SEED CHECKS CONFIRMED.")
    sys.exit(0)
