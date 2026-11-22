"""Tests for orbital dynamics simulation fixtures, analytic references, convergence rates, and conservation evaluation."""

import runpy
import unittest
import uuid
from pathlib import Path

import numpy as np

from siphon_science.orbital import central_invariants_si, isolated_invariants_si
from siphon_science.orbital_reference import (
    compute_orbital_error_norms,
    evaluate_lagrange_three_body,
    solve_kepler_anomaly,
)
from siphon_science.orbital_refinement import verify_orbital_convergence
from siphon_science.scientific_checks import evaluate_sampled_metric

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "orbital"


class OrbitalFixturesTests(unittest.TestCase):
    def test_sound_kepler_orbit_fixture_module(self):
        """Verify sound Kepler orbit fixture module exports and conservation."""
        import fixtures.orbital.sound_kepler_orbit as sound

        # Check export presence and types
        self.assertIsInstance(sound.times, np.ndarray)
        self.assertIsInstance(sound.positions, np.ndarray)
        self.assertIsInstance(sound.velocities, np.ndarray)
        self.assertIsInstance(sound.central_mu, float)
        self.assertIsInstance(sound.exact_positions, np.ndarray)
        self.assertIsInstance(sound.exact_velocities, np.ndarray)
        self.assertIsInstance(sound.specific_energy, np.ndarray)
        self.assertIsInstance(sound.specific_angular_momentum, np.ndarray)

        # Shapes
        n_samples = len(sound.times)
        self.assertEqual(sound.positions.shape, (n_samples, 3))
        self.assertEqual(sound.velocities.shape, (n_samples, 3))
        self.assertEqual(sound.exact_positions.shape, (n_samples, 3))
        self.assertEqual(sound.exact_velocities.shape, (n_samples, 3))
        self.assertEqual(sound.specific_energy.shape, (n_samples,))
        self.assertEqual(sound.specific_angular_momentum.shape, (n_samples, 3))

        # Check central invariants via scientific core
        invariants = central_invariants_si(
            sound.positions,
            sound.velocities,
            central_mu_m3_s2=sound.central_mu,
            maximum_samples=1000,
        )
        e0 = invariants.specific_energy_m2_s2[0]
        max_e_drift = float(np.max(np.abs(invariants.specific_energy_m2_s2 - e0)))
        rel_e_drift = max_e_drift / abs(e0)
        self.assertLess(rel_e_drift, 1e-6)

        h0 = invariants.specific_angular_momentum_m2_s[0]
        max_h_drift = float(np.max(np.abs(invariants.specific_angular_momentum_m2_s - h0)))
        self.assertLess(max_h_drift, 1e-2)

        # Accuracy against exact analytical Kepler trajectory
        norms = compute_orbital_error_norms(
            sound.positions,
            sound.exact_positions,
            sim_velocities=sound.velocities,
            ref_velocities=sound.exact_velocities,
        )
        self.assertLess(norms["pos_l2_error"], 5.0)
        self.assertLess(norms["pos_relative_l2"], 1e-6)

        # Evaluate through scientific_checks for O_ENERGY and O_ANGULAR
        diagnostic = {
            "operationId": str(uuid.uuid4()),
            "auditId": "a" * 32,
            "revisionId": "b" * 32,
            "inputDigest": "a" * 64,
            "contextDigest": "b" * 64,
            "adapterDigest": "c" * 64,
            "sourceOperationId": str(uuid.uuid4()),
        }
        metric_energy = {
            "name": "max_energy_drift",
            "value": max_e_drift,
            "unit": "J/kg",
            "normalization": "none",
            "arithmetic": {"absoluteUncertaintyBound": 1e-10},
        }
        policy_energy = {
            "scope": "reported_samples",
            "target": {
                "value": 1.0,
                "unit": "J/kg",
                "justification": "Target energy drift for bound Kepler orbit.",
                "evidenceIds": [str(uuid.uuid4())],
            },
        }
        evidence_e = evaluate_sampled_metric(
            diagnostic,
            metric_energy,
            check_id="O_ENERGY",
            plan_digest="d" * 64,
            evidence_id=str(uuid.uuid4()),
            policy=policy_energy,
        )
        self.assertEqual(evidence_e["status"], "passed_within_tolerance")

        metric_angular = {
            "name": "max_angular_momentum_drift",
            "value": max_h_drift,
            "unit": "m^2/s",
            "normalization": "none",
            "arithmetic": {"absoluteUncertaintyBound": 1e-10},
        }
        policy_angular = {
            "scope": "reported_samples",
            "target": {
                "value": 1e-1,
                "unit": "m^2/s",
                "justification": "Target angular momentum drift for planar orbit.",
                "evidenceIds": [str(uuid.uuid4())],
            },
        }
        evidence_h = evaluate_sampled_metric(
            diagnostic,
            metric_angular,
            check_id="O_ANGULAR",
            plan_digest="d" * 64,
            evidence_id=str(uuid.uuid4()),
            policy=policy_angular,
        )
        self.assertEqual(evidence_h["status"], "passed_within_tolerance")

    def test_faulty_kepler_orbit_fixture_module(self):
        """Verify faulty Kepler orbit fixture module exports and flagged dissipative loss."""
        import fixtures.orbital.faulty_kepler_orbit as faulty

        self.assertIsInstance(faulty.times, np.ndarray)
        self.assertIsInstance(faulty.positions, np.ndarray)
        self.assertIsInstance(faulty.velocities, np.ndarray)
        self.assertIsInstance(faulty.central_mu, float)

        invariants = central_invariants_si(
            faulty.positions,
            faulty.velocities,
            central_mu_m3_s2=faulty.central_mu,
            maximum_samples=1000,
        )
        e0 = invariants.specific_energy_m2_s2[0]
        ef = invariants.specific_energy_m2_s2[-1]
        rel_energy_drop = (e0 - ef) / abs(e0)
        self.assertGreater(rel_energy_drop, 0.05)

        # Evaluate through scientific_checks: with target < 1e-3, must evaluate to flagged
        diagnostic = {
            "operationId": str(uuid.uuid4()),
            "auditId": "a" * 32,
            "revisionId": "b" * 32,
            "inputDigest": "a" * 64,
            "contextDigest": "b" * 64,
            "adapterDigest": "c" * 64,
            "sourceOperationId": str(uuid.uuid4()),
        }
        max_e_drift = float(np.max(np.abs(invariants.specific_energy_m2_s2 - e0)))
        metric_energy = {
            "name": "max_energy_drift",
            "value": max_e_drift,
            "unit": "J/kg",
            "normalization": "none",
            "arithmetic": {"absoluteUncertaintyBound": 1e-10},
        }
        policy_energy = {
            "scope": "reported_samples",
            "target": {
                "value": 1e-2,
                "unit": "J/kg",
                "justification": "Target energy drift for conservative orbit.",
                "evidenceIds": [str(uuid.uuid4())],
            },
        }
        evidence_e = evaluate_sampled_metric(
            diagnostic,
            metric_energy,
            check_id="O_ENERGY",
            plan_digest="d" * 64,
            evidence_id=str(uuid.uuid4()),
            policy=policy_energy,
        )
        self.assertEqual(evidence_e["status"], "flagged")

    def test_sound_three_body_fixture_module(self):
        """Verify sound isolated three-body fixture module exports and invariants."""
        import fixtures.orbital.sound_three_body as three_body

        self.assertIsInstance(three_body.times, np.ndarray)
        self.assertIsInstance(three_body.positions, np.ndarray)
        self.assertIsInstance(three_body.velocities, np.ndarray)
        self.assertIsInstance(three_body.masses, np.ndarray)
        self.assertIsInstance(three_body.gravitational_constant, float)
        self.assertIsInstance(three_body.exact_positions, np.ndarray)
        self.assertIsInstance(three_body.exact_velocities, np.ndarray)

        n_samples = len(three_body.times)
        self.assertEqual(three_body.positions.shape, (n_samples, 3, 3))
        self.assertEqual(three_body.velocities.shape, (n_samples, 3, 3))
        self.assertEqual(three_body.masses.shape, (3,))

        invariants = isolated_invariants_si(
            three_body.positions,
            three_body.velocities,
            three_body.masses,
            gravitational_constant=three_body.gravitational_constant,
            maximum_samples=1000,
            maximum_bodies=10,
        )
        e0 = invariants.energy_j[0]
        max_e_drift = float(np.max(np.abs(invariants.energy_j - e0)))
        rel_e_drift = max_e_drift / abs(e0)
        self.assertLess(rel_e_drift, 1e-6)

        # Center of mass drift
        max_cm_drift = float(np.max(np.linalg.norm(invariants.center_of_mass_m, axis=-1)))
        self.assertLess(max_cm_drift, 1e-4)

        # Momentum drift
        max_p_drift = float(np.max(np.linalg.norm(invariants.momentum_kg_m_s, axis=-1)))
        total_m = float(np.sum(three_body.masses))
        self.assertLess(max_p_drift / (total_m * 2000.0), 1e-12)

        # Trajectory accuracy against exact analytical solution
        norms = compute_orbital_error_norms(
            three_body.positions,
            three_body.exact_positions,
            sim_velocities=three_body.velocities,
            ref_velocities=three_body.exact_velocities,
        )
        self.assertLess(norms["pos_l2_error"], 10.0)
        self.assertLess(norms["pos_relative_l2"], 1e-6)

        # Evaluate through scientific_checks for O_MOMENTUM
        diagnostic = {
            "operationId": str(uuid.uuid4()),
            "auditId": "a" * 32,
            "revisionId": "b" * 32,
            "inputDigest": "a" * 64,
            "contextDigest": "b" * 64,
            "adapterDigest": "c" * 64,
            "sourceOperationId": str(uuid.uuid4()),
        }
        metric_momentum = {
            "name": "max_momentum_drift",
            "value": max_p_drift,
            "unit": "kg*m/s",
            "normalization": "none",
            "arithmetic": {"absoluteUncertaintyBound": 1e-10},
        }
        policy_momentum = {
            "scope": "reported_samples",
            "target": {
                "value": 1e16,
                "unit": "kg*m/s",
                "justification": "Target linear momentum for isolated 3-body system.",
                "evidenceIds": [str(uuid.uuid4())],
            },
        }
        evidence_p = evaluate_sampled_metric(
            diagnostic,
            metric_momentum,
            check_id="O_MOMENTUM",
            plan_digest="d" * 64,
            evidence_id=str(uuid.uuid4()),
            policy=policy_momentum,
        )
        self.assertEqual(evidence_p["status"], "passed_within_tolerance")

    def test_fixtures_runnable_as_main(self):
        """Verify all three orbital fixture scripts run directly via __main__ without unhandled errors."""
        sound_path = str(FIXTURES_DIR / "sound_kepler_orbit.py")
        faulty_path = str(FIXTURES_DIR / "faulty_kepler_orbit.py")
        three_body_path = str(FIXTURES_DIR / "sound_three_body.py")

        for path in (sound_path, faulty_path, three_body_path):
            try:
                runpy.run_path(path, run_name="__main__")
            except SystemExit as exc:
                self.assertEqual(exc.code, 0)

    def test_kepler_temporal_convergence_orders(self):
        """Verify empirical convergence orders: p ~= 2.00 for Verlet and p ~= 4.00 for RK4."""
        # 2nd-order Velocity-Verlet
        res_verlet = verify_orbital_convergence(
            (1, 2, 4),
            base_steps=200,
            orbit_fraction=0.25,
            method="verlet",
        )
        mean_p_verlet = res_verlet["mean_order"]
        self.assertGreaterEqual(mean_p_verlet, 1.85)
        self.assertLessEqual(mean_p_verlet, 2.15)

        # 4th-order Runge-Kutta
        res_rk4 = verify_orbital_convergence(
            (1, 2, 4),
            base_steps=50,
            orbit_fraction=0.25,
            method="rk4",
        )
        mean_p_rk4 = res_rk4["mean_order"]
        self.assertGreaterEqual(mean_p_rk4, 3.80)
        self.assertLessEqual(mean_p_rk4, 4.20)

    def test_kepler_anomaly_solver_halley_precision(self):
        """Verify Halley accelerated Kepler anomaly solver across diverse eccentricities."""
        eccentricities = [0.0, 0.05, 0.1, 0.3, 0.5, 0.7, 0.9, 0.98]
        mean_anomalies = np.linspace(0.0, 2.0 * np.pi, 25, endpoint=False)

        for ecc in eccentricities:
            for m in mean_anomalies:
                e_sol = solve_kepler_anomaly(float(m), ecc, tolerance=1e-14)
                residual = abs(e_sol - ecc * np.sin(e_sol) - (float(m) % (2.0 * np.pi)))
                self.assertLessEqual(residual, 1e-13)

    def test_lagrange_three_body_analytical_evaluator(self):
        """Verify exact analytical Lagrange 3-body circular choreography evaluator."""
        times = np.array([0.0, 1000.0, 5000.0, 10000.0], dtype=np.float64)
        pos, vel = evaluate_lagrange_three_body(times, mass=1e24, radius=1e7)

        self.assertEqual(pos.shape, (4, 3, 3))
        self.assertEqual(vel.shape, (4, 3, 3))

        # Check that distance between any pair is constant d = R * sqrt(3)
        expected_d = 1e7 * np.sqrt(3.0)
        for t_idx in range(4):
            d01 = np.linalg.norm(pos[t_idx, 0] - pos[t_idx, 1])
            d12 = np.linalg.norm(pos[t_idx, 1] - pos[t_idx, 2])
            d20 = np.linalg.norm(pos[t_idx, 2] - pos[t_idx, 0])
            self.assertAlmostEqual(float(d01), expected_d, places=5)
            self.assertAlmostEqual(float(d12), expected_d, places=5)
            self.assertAlmostEqual(float(d20), expected_d, places=5)
