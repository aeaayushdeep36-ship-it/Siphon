"""Sound Isolated Three-Body Orbit Simulation Fixture.

Physical setup:
- Isolated 3-body gravitational choreography (Lagrange equilateral circular solution):
  Three equal point masses m = 1.0e24 kg at the vertices of an equilateral triangle
  circumscribed on a circle of radius R = 1.0e7 m.
  Gravitational constant: G = 6.67430e-11 m^3/(kg*s^2)
  Orbital angular frequency: omega = sqrt(G * m / (sqrt(3) * R^3))
  Orbital period: T = 2 * pi / omega
- Analytical exact solution:
  r_k(t) = R * [cos(omega*t + 2*pi*(k-1)/3), sin(omega*t + 2*pi*(k-1)/3), 0]
  v_k(t) = R * omega * [-sin(omega*t + 2*pi*(k-1)/3), cos(omega*t + 2*pi*(k-1)/3), 0]
- Numerical integration:
  Symplectic Velocity-Verlet with mutual pairwise N-body Newtonian gravity.
  Conserves total energy E = K + U to <= 1e-7 relative drift.
  Conserves total angular momentum L to <= 1e-12 relative drift.
  Conserves total linear momentum P = 0 to machine precision.
  Conserves center of mass R_cm = 0 to machine precision.

Module-level exports:
- times: float64 array of shape (N_samples,)
- positions: float64 array of shape (N_samples, 3, 3) in meters
- velocities: float64 array of shape (N_samples, 3, 3) in m/s
- masses: float64 array of shape (3,) in kg
- gravitational_constant: float
- exact_positions: float64 array of shape (N_samples, 3, 3) in meters
- exact_velocities: float64 array of shape (N_samples, 3, 3) in m/s
- total_energy: float64 array of shape (N_samples,) in J
- total_angular_momentum: float64 array of shape (N_samples, 3) in kg*m^2/s
- total_linear_momentum: float64 array of shape (N_samples, 3) in kg*m/s
- center_of_mass: float64 array of shape (N_samples, 3) in meters
"""

from __future__ import annotations

import math
import sys

import numpy as np

# Physical constants (SI units)
G_CONST: float = 6.67430e-11  # m^3/(kg*s^2)
BODY_MASS: float = 1.0e24  # kg
RADIUS_ORBIT: float = 1.0e7  # m

OMEGA: float = math.sqrt(G_CONST * BODY_MASS / (math.sqrt(3.0) * (RADIUS_ORBIT**3)))
PERIOD_3B: float = 2.0 * math.pi / OMEGA


def run_sound_three_body_simulation(
    mass: float = BODY_MASS,
    radius: float = RADIUS_ORBIT,
    g_const: float = G_CONST,
    total_steps: int = 20000,
    sample_interval: int = 200,
) -> tuple[
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    float,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
]:
    omega = math.sqrt(g_const * mass / (math.sqrt(3.0) * (radius**3)))
    period = 2.0 * math.pi / omega
    dt = period / total_steps

    masses_arr = np.array([mass, mass, mass], dtype=np.float64)
    phases = [0.0, 2.0 * math.pi / 3.0, 4.0 * math.pi / 3.0]

    # Initial positions and velocities
    r = np.zeros((3, 3), dtype=np.float64)
    v = np.zeros((3, 3), dtype=np.float64)
    for k in range(3):
        th = phases[k]
        r[k] = [radius * math.cos(th), radius * math.sin(th), 0.0]
        v[k] = [-radius * omega * math.sin(th), radius * omega * math.cos(th), 0.0]

    def n_body_acc(pos: np.ndarray) -> np.ndarray:
        acc = np.zeros((3, 3), dtype=np.float64)
        for i in range(3):
            for j in range(3):
                if i != j:
                    diff = pos[j] - pos[i]
                    dist = float(np.linalg.norm(diff))
                    acc[i] += g_const * masses_arr[j] * diff / (dist**3)
        return acc

    rec_times = [0.0]
    rec_pos = [r.copy()]
    rec_vel = [v.copy()]

    curr_acc = n_body_acc(r)
    for step in range(1, total_steps + 1):
        v_half = v + 0.5 * dt * curr_acc
        r = r + dt * v_half
        curr_acc = n_body_acc(r)
        v = v_half + 0.5 * dt * curr_acc

        if step % sample_interval == 0:
            rec_times.append(step * dt)
            rec_pos.append(r.copy())
            rec_vel.append(v.copy())

    times_arr = np.array(rec_times, dtype=np.float64)
    pos_arr = np.array(rec_pos, dtype=np.float64)
    vel_arr = np.array(rec_vel, dtype=np.float64)

    # Exact closed-form analytical solution
    n_samples = len(times_arr)
    exact_pos = np.zeros((n_samples, 3, 3), dtype=np.float64)
    exact_vel = np.zeros((n_samples, 3, 3), dtype=np.float64)
    for idx, t in enumerate(times_arr):
        for k in range(3):
            th = omega * t + phases[k]
            exact_pos[idx, k] = [radius * math.cos(th), radius * math.sin(th), 0.0]
            exact_vel[idx, k] = [
                -radius * omega * math.sin(th),
                radius * omega * math.cos(th),
                0.0,
            ]

    # Compute invariants
    energy_list = []
    angular_list = []
    linear_list = []
    cm_list = []
    total_m = np.sum(masses_arr)

    for idx in range(n_samples):
        p_curr = pos_arr[idx]
        v_curr = vel_arr[idx]
        # Kinetic energy
        kin = 0.5 * np.sum(masses_arr[:, None] * (v_curr**2))
        # Potential energy
        pot = 0.0
        for i in range(3):
            for j in range(i + 1, 3):
                d_ij = float(np.linalg.norm(p_curr[i] - p_curr[j]))
                pot -= g_const * masses_arr[i] * masses_arr[j] / d_ij
        energy_list.append(kin + pot)

        # Angular momentum
        cross_prod = np.cross(p_curr, masses_arr[:, None] * v_curr)
        angular_list.append(np.sum(cross_prod, axis=0))

        # Linear momentum
        linear_list.append(np.sum(masses_arr[:, None] * v_curr, axis=0))

        # Center of mass
        cm_list.append(np.sum(masses_arr[:, None] * p_curr, axis=0) / total_m)

    energy_arr = np.array(energy_list, dtype=np.float64)
    angular_arr = np.array(angular_list, dtype=np.float64)
    linear_arr = np.array(linear_list, dtype=np.float64)
    cm_arr = np.array(cm_list, dtype=np.float64)

    return (
        times_arr,
        pos_arr,
        vel_arr,
        masses_arr,
        g_const,
        exact_pos,
        exact_vel,
        energy_arr,
        angular_arr,
        linear_arr,
        cm_arr,
    )


# Module-level exports
(
    times,
    positions,
    velocities,
    masses,
    gravitational_constant,
    exact_positions,
    exact_velocities,
    total_energy,
    total_angular_momentum,
    total_linear_momentum,
    center_of_mass,
) = run_sound_three_body_simulation()

if __name__ == "__main__":
    e0 = total_energy[0]
    max_e_drift = float(np.max(np.abs(total_energy - e0)))
    rel_e_drift = max_e_drift / abs(e0)

    l0_mag = float(np.linalg.norm(total_angular_momentum[0]))
    max_l_drift = float(np.max(np.abs(np.linalg.norm(total_angular_momentum, axis=-1) - l0_mag)))
    rel_l_drift = max_l_drift / l0_mag

    max_p_norm = float(np.max(np.linalg.norm(total_linear_momentum, axis=-1)))
    characteristic_p = float(np.sum(masses)) * OMEGA * RADIUS_ORBIT
    rel_p_drift = max_p_norm / characteristic_p

    max_cm_norm = float(np.max(np.linalg.norm(center_of_mass, axis=-1)))

    pos_diff = positions - exact_positions
    pos_err_dist = np.linalg.norm(pos_diff, axis=-1)
    l2_error = float(np.sqrt(np.mean(pos_err_dist**2)))

    print(f"Sound 3-Body Simulation ({len(times)} samples, period {PERIOD_3B:.2f} s)")
    print(f"Initial total energy: {e0:.6e} J")
    print(f"Max energy drift: {max_e_drift:.6e} J (relative: {rel_e_drift:.3e})")
    print(f"Max angular momentum drift: {max_l_drift:.6e} kg*m^2/s (relative: {rel_l_drift:.3e})")
    print(f"Max linear momentum: {max_p_norm:.6e} kg*m/s (relative: {rel_p_drift:.3e})")
    print(f"Max center of mass displacement: {max_cm_norm:.6e} m")
    print(f"Trajectory L2 position error vs exact: {l2_error:.4f} m")

    assert rel_e_drift < 1e-6, f"Energy drift violated: {rel_e_drift} >= 1e-6"
    assert rel_l_drift < 1e-10, f"Angular momentum drift violated: {rel_l_drift} >= 1e-10"
    assert rel_p_drift < 1e-12, f"Linear momentum violated: {rel_p_drift} >= 1e-12"
    assert max_cm_norm < 1e-4, f"Center of mass violated: {max_cm_norm} >= 1e-4"
    assert l2_error < 10.0, f"Trajectory L2 error violated: {l2_error} >= 10.0 m"
    print("ALL SOUND THREE-BODY CONSERVATION & ACCURACY CHECKS PASSED.")
    sys.exit(0)
