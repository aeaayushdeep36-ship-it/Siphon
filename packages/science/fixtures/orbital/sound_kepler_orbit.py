"""Sound Kepler Two-Body Orbit Simulation Fixture.

Physical setup:
- Central gravitational field: Earth-centered standard gravitational parameter
  mu = 3.986004418e14 m^3/s^2.
- Bound eccentric Keplerian orbit:
  Perigee radius: rp = 7.0e6 m (~622 km altitude)
  Eccentricity: e = 0.1
  Semi-major axis: a = rp / (1 - e) = 7.777777777777778e6 m
  Perigee speed: vp = sqrt(mu * (1 + e) / rp) = 7914.7738 m/s
  Orbital period: T = 2 * pi * sqrt(a^3 / mu) ~= 6813.51 s (~1.89 hours)
- Numerical integration:
  Symplectic Velocity-Verlet integrator over 1 full orbit.
  Conserves specific mechanical energy E = 0.5 * v^2 - mu / r to <= 1e-7 relative drift.
  Conserves specific angular momentum h = r x v to machine precision.
- Analytical comparison:
  Includes exact positions and velocities from Kepler's equation solved to machine precision.

Module-level exports:
- times: float64 array of shape (N_samples,)
- positions: float64 array of shape (N_samples, 3) in meters
- velocities: float64 array of shape (N_samples, 3) in m/s
- central_mu: float (m^3/s^2)
- exact_positions: float64 array of shape (N_samples, 3) in meters
- exact_velocities: float64 array of shape (N_samples, 3) in m/s
- specific_energy: float64 array of shape (N_samples,) in J/kg
- specific_angular_momentum: float64 array of shape (N_samples, 3) in m^2/s
"""

from __future__ import annotations

import math
import sys

import numpy as np

# Physical constants (SI units)
MU_EARTH: float = 3.986004418e14  # m^3/s^2
RP: float = 7.0e6  # m
ECC: float = 0.1  # dimensionless
A_SEMI: float = RP / (1.0 - ECC)  # m
PERIOD: float = 2.0 * math.pi * math.sqrt((A_SEMI**3) / MU_EARTH)  # s
VP: float = math.sqrt(MU_EARTH * (1.0 + ECC) / RP)  # m/s

# Initial conditions at perigee in the XY orbital plane
R0: np.ndarray = np.array([RP, 0.0, 0.0], dtype=np.float64)
V0: np.ndarray = np.array([0.0, VP, 0.0], dtype=np.float64)


def _solve_kepler_e(m: float, ecc: float) -> float:
    """Solve M = E - ecc * sin(E) using Halley's iteration."""
    m_norm = m % (2.0 * math.pi)
    e_curr = m_norm + ecc * math.sin(m_norm)
    for _ in range(50):
        s_e = math.sin(e_curr)
        c_e = math.cos(e_curr)
        f = e_curr - ecc * s_e - m_norm
        if abs(f) <= 1e-14:
            break
        f_prime = 1.0 - ecc * c_e
        f_double_prime = ecc * s_e
        delta = f / (f_prime - 0.5 * f * f_double_prime / f_prime)
        e_curr -= delta
        if abs(delta) <= 1e-14:
            break
    return e_curr


def run_sound_kepler_simulation(
    mu: float = MU_EARTH,
    rp: float = RP,
    ecc: float = ECC,
    total_steps: int = 20000,
    sample_interval: int = 200,
) -> tuple[
    np.ndarray,
    np.ndarray,
    np.ndarray,
    float,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
]:
    a = rp / (1.0 - ecc)
    b = a * math.sqrt(1.0 - ecc * ecc)
    period = 2.0 * math.pi * math.sqrt((a**3) / mu)
    vp = math.sqrt(mu * (1.0 + ecc) / rp)
    n_motion = math.sqrt(mu / (a**3))

    dt = period / total_steps

    r = np.array([rp, 0.0, 0.0], dtype=np.float64)
    v = np.array([0.0, vp, 0.0], dtype=np.float64)

    def acc(pos: np.ndarray) -> np.ndarray:
        dist = float(np.linalg.norm(pos))
        return -mu * pos / (dist**3)

    rec_times = [0.0]
    rec_pos = [r.copy()]
    rec_vel = [v.copy()]

    curr_acc = acc(r)
    for step in range(1, total_steps + 1):
        v_half = v + 0.5 * dt * curr_acc
        r = r + dt * v_half
        curr_acc = acc(r)
        v = v_half + 0.5 * dt * curr_acc

        if step % sample_interval == 0:
            rec_times.append(step * dt)
            rec_pos.append(r.copy())
            rec_vel.append(v.copy())

    times_arr = np.array(rec_times, dtype=np.float64)
    pos_arr = np.array(rec_pos, dtype=np.float64)
    vel_arr = np.array(rec_vel, dtype=np.float64)

    # Exact closed-form Kepler analytical solution at recorded times
    exact_pos_list = []
    exact_vel_list = []
    for t in times_arr:
        m_t = n_motion * t
        e_t = _solve_kepler_e(m_t, ecc)
        c_e = math.cos(e_t)
        s_e = math.sin(e_t)

        # Planar coordinates (perigee along +x, velocity along +y at perigee)
        x_exact = a * (c_e - ecc)
        y_exact = b * s_e
        exact_pos_list.append([x_exact, y_exact, 0.0])

        r_mag = a * (1.0 - ecc * c_e)
        e_dot = n_motion / r_mag
        vx_exact = -a * s_e * e_dot
        vy_exact = b * c_e * e_dot
        exact_vel_list.append([vx_exact, vy_exact, 0.0])

    exact_pos_arr = np.array(exact_pos_list, dtype=np.float64)
    exact_vel_arr = np.array(exact_vel_list, dtype=np.float64)

    # Specific invariants
    r_norms = np.linalg.norm(pos_arr, axis=-1)
    v_sq = np.sum(vel_arr * vel_arr, axis=-1)
    energy_arr = 0.5 * v_sq - mu / r_norms
    angular_arr = np.cross(pos_arr, vel_arr)

    return (
        times_arr,
        pos_arr,
        vel_arr,
        mu,
        exact_pos_arr,
        exact_vel_arr,
        energy_arr,
        angular_arr,
    )


# Module-level exports
(
    times,
    positions,
    velocities,
    central_mu,
    exact_positions,
    exact_velocities,
    specific_energy,
    specific_angular_momentum,
) = run_sound_kepler_simulation()

if __name__ == "__main__":
    e0 = specific_energy[0]
    max_e_drift = float(np.max(np.abs(specific_energy - e0)))
    rel_e_drift = max_e_drift / abs(e0)

    h0 = specific_angular_momentum[0]
    max_h_drift = float(np.max(np.abs(specific_angular_momentum - h0)))

    pos_diff = positions - exact_positions
    pos_err_dist = np.linalg.norm(pos_diff, axis=-1)
    l2_error = float(np.sqrt(np.mean(pos_err_dist**2)))
    linf_error = float(np.max(pos_err_dist))

    print(f"Sound Kepler Orbit Simulation ({len(times)} samples, period {PERIOD:.2f} s)")
    print(f"Initial energy: {e0:.6e} J/kg")
    print(f"Maximum absolute energy drift: {max_e_drift:.6e} J/kg (relative: {rel_e_drift:.3e})")
    print(f"Maximum angular momentum drift: {max_h_drift:.6e} m^2/s")
    print(f"Trajectory L2 position error vs exact: {l2_error:.4f} m (L_inf: {linf_error:.4f} m)")

    assert rel_e_drift < 1e-6, f"Energy drift violated: {rel_e_drift} >= 1e-6"
    assert l2_error < 5.0, f"Trajectory L2 error violated: {l2_error} >= 5.0 m"
    print("ALL SOUND KEPLER CONSERVATION & TRAJECTORY ACCURACY CHECKS PASSED.")
    sys.exit(0)
