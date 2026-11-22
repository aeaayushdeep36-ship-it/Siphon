"""Faulty Kepler Two-Body Orbit Simulation Fixture.

Seeded scientific defect:
- Simulates an eccentric Earth satellite orbit (e=0.1, rp=7000 km) subject to
  unrecorded non-conservative atmospheric drag / damping:
    a_drag = -gamma * v
  where gamma = 2.0e-5 s^-1.
- This seeded dissipative loss causes continuous monotonic degradation of specific
  mechanical energy and specific angular momentum over the orbit.
- Verified by O_ENERGY and O_ANGULAR checks: the final energy deficit exceeds 5%,
  verifiably failing the sampled-state conservation target.

Module-level exports:
- times: float64 array of shape (N_samples,)
- positions: float64 array of shape (N_samples, 3) in meters
- velocities: float64 array of shape (N_samples, 3) in m/s
- central_mu: float (m^3/s^2)
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

# Damping coefficient: dissipative non-conservative drag
GAMMA_DRAG: float = 2.0e-5  # s^-1


def run_faulty_kepler_simulation(
    mu: float = MU_EARTH,
    rp: float = RP,
    ecc: float = ECC,
    gamma: float = GAMMA_DRAG,
    total_steps: int = 10000,
    sample_interval: int = 100,
) -> tuple[
    np.ndarray,
    np.ndarray,
    np.ndarray,
    float,
    np.ndarray,
    np.ndarray,
]:
    a = rp / (1.0 - ecc)
    period = 2.0 * math.pi * math.sqrt((a**3) / mu)
    vp = math.sqrt(mu * (1.0 + ecc) / rp)
    dt = period / total_steps

    r = np.array([rp, 0.0, 0.0], dtype=np.float64)
    v = np.array([0.0, vp, 0.0], dtype=np.float64)

    def total_acc(pos: np.ndarray, vel: np.ndarray) -> np.ndarray:
        dist = float(np.linalg.norm(pos))
        grav = -mu * pos / (dist**3)
        drag = -gamma * vel
        return grav + drag

    rec_times = [0.0]
    rec_pos = [r.copy()]
    rec_vel = [v.copy()]

    curr_acc = total_acc(r, v)
    for step in range(1, total_steps + 1):
        v_half = v + 0.5 * dt * curr_acc
        r = r + dt * v_half
        curr_acc = total_acc(r, v_half)
        v = v_half + 0.5 * dt * curr_acc

        if step % sample_interval == 0:
            rec_times.append(step * dt)
            rec_pos.append(r.copy())
            rec_vel.append(v.copy())

    times_arr = np.array(rec_times, dtype=np.float64)
    pos_arr = np.array(rec_pos, dtype=np.float64)
    vel_arr = np.array(rec_vel, dtype=np.float64)

    # Invariants
    r_norms = np.linalg.norm(pos_arr, axis=-1)
    v_sq = np.sum(vel_arr * vel_arr, axis=-1)
    energy_arr = 0.5 * v_sq - mu / r_norms
    angular_arr = np.cross(pos_arr, vel_arr)

    return times_arr, pos_arr, vel_arr, mu, energy_arr, angular_arr


# Module-level exports
(
    times,
    positions,
    velocities,
    central_mu,
    specific_energy,
    specific_angular_momentum,
) = run_faulty_kepler_simulation()

if __name__ == "__main__":
    e0 = specific_energy[0]
    ef = specific_energy[-1]
    rel_energy_drop = (e0 - ef) / abs(e0)

    h0_mag = float(np.linalg.norm(specific_angular_momentum[0]))
    hf_mag = float(np.linalg.norm(specific_angular_momentum[-1]))
    rel_h_drop = (h0_mag - hf_mag) / h0_mag

    print(f"Faulty Kepler Orbit Simulation ({len(times)} samples, period {PERIOD:.2f} s)")
    print(f"Initial specific energy: {e0:.6e} J/kg, Final: {ef:.6e} J/kg")
    print(f"Relative energy deficit: {rel_energy_drop * 100:.2f}%")
    print(f"Relative angular momentum loss: {rel_h_drop * 100:.2f}%")

    assert rel_energy_drop > 0.05, f"Expected >5% energy loss, got {rel_energy_drop * 100:.2f}%"
    assert rel_h_drop > 0.05, f"Expected >5% angular momentum loss, got {rel_h_drop * 100:.2f}%"
    print("ALL FAULTY KEPLER DEFICIT CHECKS PASSED.")
    sys.exit(0)
