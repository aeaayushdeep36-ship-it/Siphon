"""Tests for heat diffusion PDE fixtures, analytic references, convergence rates, and H_BALANCE evaluation."""

import runpy
import unittest
import uuid
from pathlib import Path

import numpy as np

from siphon_science.heat import (
    compute_trapezoid_quadrature_bound,
    heat_balance_si,
    thermal_energy_change_si,
)
from siphon_science.heat_reference import compute_heat_error_norms, evaluate_fourier_analytic_mode
from siphon_science.heat_refinement import (
    verify_spatial_convergence,
    verify_temporal_convergence,
)
from siphon_science.scientific_checks import evaluate_sampled_metric

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "heat"


class HeatFixturesTests(unittest.TestCase):
    def test_sound_heat_diffusion_fixture_module(self):
        """Verify sound heat diffusion fixture module exports and discrete conservation."""
        import fixtures.heat.sound_heat_diffusion as sound

        # Check export presence and types
        self.assertIsInstance(sound.times, np.ndarray)
        self.assertIsInstance(sound.temperature, np.ndarray)
        self.assertIsInstance(sound.thermal_weights, np.ndarray)
        self.assertIsInstance(sound.source_power, np.ndarray)
        self.assertIsInstance(sound.outward_power, np.ndarray)
        self.assertIsInstance(sound.exact_temperature, np.ndarray)

        # Shapes
        n_samples = len(sound.times)
        self.assertEqual(sound.temperature.shape, (n_samples, 32, 32))
        self.assertEqual(sound.thermal_weights.shape, (32, 32))
        self.assertEqual(sound.source_power.shape, (n_samples,))
        self.assertEqual(sound.outward_power.shape, (n_samples,))
        self.assertEqual(sound.exact_temperature.shape, (n_samples, 32, 32))

        # Check physical parameters
        rho = 8960.0
        cp = 385.0

        # Discrete energy change relative to initial state
        delta_e = thermal_energy_change_si(
            sound.temperature,
            sound.thermal_weights,
            density_kg_m3=rho,
            heat_capacity_j_kg_k=cp,
            maximum_samples=1000,
            maximum_grid_values=10000,
        )

        # Machine-precision conservation: telescoping Laplacian preserves discrete energy to <= 1e-10 J
        max_drift = np.max(np.abs(delta_e))
        self.assertLess(max_drift, 1e-10)

        # Accuracy against exact analytical cell-averaged solution
        total_vol = np.sum(sound.thermal_weights)
        l2_err = np.sqrt(
            np.sum(
                sound.thermal_weights * ((sound.temperature[-1] - sound.exact_temperature[-1]) ** 2)
            )
            / total_vol
        )
        self.assertLess(l2_err, 0.05)

    def test_faulty_heat_diffusion_fixture_module(self):
        """Verify faulty heat diffusion fixture module exports and flagged deficit."""
        import fixtures.heat.faulty_heat_diffusion as faulty

        # Check export presence and types
        self.assertIsInstance(faulty.times, np.ndarray)
        self.assertIsInstance(faulty.temperature, np.ndarray)
        self.assertIsInstance(faulty.thermal_weights, np.ndarray)
        self.assertIsInstance(faulty.source_power, np.ndarray)
        self.assertIsInstance(faulty.outward_power, np.ndarray)

        rho = 8960.0
        cp = 385.0

        # Energy change
        delta_e = thermal_energy_change_si(
            faulty.temperature,
            faulty.thermal_weights,
            density_kg_m3=rho,
            heat_capacity_j_kg_k=cp,
            maximum_samples=1000,
            maximum_grid_values=10000,
        )

        # Seeded convective flux leak must produce deficit < -0.1 J
        final_deficit = delta_e[-1]
        self.assertLess(final_deficit, -0.1)

        # Balance residual: since outward_power is recorded as 0, residual matches delta_e
        balance_res = heat_balance_si(
            faulty.times,
            delta_e,
            faulty.source_power,
            faulty.outward_power,
            maximum_samples=1000,
        )
        self.assertLess(balance_res.residual_j[-1], -0.1)

    def test_fixtures_runnable_as_main(self):
        """Verify both fixture scripts run directly via __main__ without unhandled errors."""
        sound_path = str(FIXTURES_DIR / "sound_heat_diffusion.py")
        faulty_path = str(FIXTURES_DIR / "faulty_heat_diffusion.py")

        # Save sys.modules state to allow clean runpy execution
        try:
            runpy.run_path(sound_path, run_name="__main__")
        except SystemExit as exc:
            self.assertEqual(exc.code, 0)

        try:
            runpy.run_path(faulty_path, run_name="__main__")
        except SystemExit as exc:
            self.assertEqual(exc.code, 0)

    def test_spatial_convergence_order(self):
        """Verify spatial convergence order p ~= 2.00 under diffusive CFL scaling."""
        result = verify_spatial_convergence(
            (16, 32, 64),
            t_target=0.5,
            r_cfl=0.1,
        )

        mean_p = result["mean_order"]
        self.assertGreaterEqual(mean_p, 1.95)
        self.assertLessEqual(mean_p, 2.05)

        for p in result["orders"]:
            self.assertGreaterEqual(p, 1.95)
            self.assertLessEqual(p, 2.05)

    def test_temporal_convergence_order(self):
        """Verify temporal convergence order q ~= 1.00 under time-step refinement."""
        result = verify_temporal_convergence(
            (1, 2, 4),
            nx=64,
            dt_base=4.0e-3,
            t_target=0.2,
        )

        q = result["temporal_order"]
        self.assertGreaterEqual(q, 0.95)
        self.assertLessEqual(q, 1.05)

    def test_heat_reference_solution_and_norms(self):
        """Verify Fourier analytical solution evaluator and error norm calculations."""
        nx, ny = 16, 16
        dx, dy = 0.1 / nx, 0.1 / ny
        alpha = 1.159555e-4
        x = (np.arange(nx) + 0.5) * dx
        y = (np.arange(ny) + 0.5) * dy

        # Evaluate at t=0
        t_cont = evaluate_fourier_analytic_mode(
            0.0, x, y, dx=dx, dy=dy, alpha=alpha, cell_averaged=False
        )
        t_cell = evaluate_fourier_analytic_mode(
            0.0, x, y, dx=dx, dy=dy, alpha=alpha, cell_averaged=True
        )

        self.assertEqual(t_cont.shape, (nx, ny))
        self.assertEqual(t_cell.shape, (nx, ny))
        # Cell-averaged solution amplitude is slightly reduced due to sinc factors
        self.assertLess(np.max(t_cell) - 300.0, np.max(t_cont) - 300.0)

        weights = np.full((nx, ny), dx * dy * 0.01)
        norms = compute_heat_error_norms(t_cont, t_cell, weights, t0=300.0)
        self.assertIn("l2_error_final", norms)
        self.assertIn("linf_error_final", norms)
        self.assertIn("relative_l2_final", norms)
        self.assertGreater(norms["l2_error_final"], 0.0)

    def test_h_balance_piecewise_linear_exact_quadrature(self):
        """Verify H_BALANCE with piecewise-linear net power has zero quadrature uncertainty."""
        times = np.array([0.0, 1.0, 2.5, 4.0], dtype=np.float64)
        # Net power: P(t) = 10 * t + 5
        source = 10.0 * times + 5.0
        outward = np.zeros_like(times)
        # Exact integral: \int_0^t (10 \tau + 5) d\tau = 5 * t^2 + 5 * t
        energy = 5.0 * (times**2) + 5.0 * times

        res = heat_balance_si(times, energy, source, outward, maximum_samples=1000)
        np.testing.assert_allclose(res.residual_j, 0.0, atol=1e-12)

        # For piecewise-linear, M = 0.0
        u_quad = compute_trapezoid_quadrature_bound(times, second_derivative_bound_w_s2=0.0)
        self.assertEqual(u_quad, 0.0)

        # Evaluate through scientific_checks
        diagnostic = {
            "auditId": "a" * 32,
            "revisionId": "b" * 32,
            "inputDigest": "c" * 64,
            "contextDigest": "d" * 64,
            "adapterDigest": "e" * 64,
            "sourceOperationId": "f" * 32,
            "operationId": "1" * 32,
        }
        metric = {
            "name": "heat_balance_residual_j",
            "value": float(np.max(np.abs(res.residual_j))),
            "unit": "J",
            "normalization": "none",
            "arithmetic": {
                "method": "decimal50_interval_v1",
                "absoluteUncertaintyBound": 1e-14,
            },
        }
        evidence = evaluate_sampled_metric(
            diagnostic,
            metric,
            check_id="H_BALANCE",
            plan_digest="a" * 64,
            evidence_id=str(uuid.uuid4()),
            policy={
                "scope": "reported_samples",
                "target": {
                    "value": 1e-8,
                    "unit": "J",
                    "justification": "Authored test target",
                    "evidenceIds": [str(uuid.uuid4())],
                },
                "quadratureUncertaintyBound": 0.0,
            },
        )
        self.assertEqual(evidence["status"], "passed_within_tolerance")
        self.assertIn("mathematically exact", evidence["uncertainty"]["justification"])

    def test_h_balance_nonlinear_power_remainder_bound(self):
        """Verify H_BALANCE with nonlinear power is enclosed by composite trapezoid bound."""
        # P(t) = 6 * t^2 -> P''(t) = 12 = M
        times = np.linspace(0.0, 1.0, 11)  # dt = 0.1
        m_bound = 12.0
        source = 6.0 * (times**2)
        outward = np.zeros_like(times)
        # Exact integral: \int_0^t 6 \tau^2 d\tau = 2 * t^3
        energy = 2.0 * (times**3)

        res = heat_balance_si(times, energy, source, outward, maximum_samples=1000)
        # Analytical trapezoid error for quadratic over uniform dt:
        # E_k = (M / 12) * dt^3 per interval, total = (M / 12) * dt^2 * T = (12/12) * 0.01 * 1 = 0.01 J
        max_residual = float(np.max(np.abs(res.residual_j)))
        self.assertGreater(max_residual, 0.0)

        # Composite trapezoidal remainder bound
        u_quad = compute_trapezoid_quadrature_bound(times, second_derivative_bound_w_s2=m_bound)
        self.assertGreaterEqual(u_quad, max_residual)

        diagnostic = {
            "auditId": "a" * 32,
            "revisionId": "b" * 32,
            "inputDigest": "c" * 64,
            "contextDigest": "d" * 64,
            "adapterDigest": "e" * 64,
            "sourceOperationId": "f" * 32,
            "operationId": "1" * 32,
        }
        metric = {
            "name": "heat_balance_residual_j",
            "value": max_residual,
            "unit": "J",
            "normalization": "none",
            "arithmetic": {
                "method": "decimal50_interval_v1",
                "absoluteUncertaintyBound": 1e-14,
            },
        }
        # Target = 0.03 J, with u_quad ~= 0.01 J -> upper bound ~= 0.02 J -> passes
        evidence = evaluate_sampled_metric(
            diagnostic,
            metric,
            check_id="H_BALANCE",
            plan_digest="a" * 64,
            evidence_id=str(uuid.uuid4()),
            policy={
                "scope": "reported_samples",
                "target": {
                    "value": 0.03,
                    "unit": "J",
                    "justification": "Authored nonlinear power remainder test target",
                    "evidenceIds": [str(uuid.uuid4())],
                },
                "quadratureUncertaintyBound": u_quad,
            },
        )
        self.assertEqual(evidence["status"], "passed_within_tolerance")
        self.assertIn(
            "plus certified quadrature uncertainty bound", evidence["uncertainty"]["justification"]
        )


if __name__ == "__main__":
    unittest.main()
