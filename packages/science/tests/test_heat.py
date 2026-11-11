import unittest

import numpy as np

from siphon_science.heat import heat_balance_si, thermal_energy_change_si
from siphon_science.numeric_inputs import NumericInputError


def a(value):
    return np.asarray(value, dtype=np.float64)


class HeatTests(unittest.TestCase):
    def energy(self, temperatures, weights, rho=2, cp=3):
        return thermal_energy_change_si(
            a(temperatures),
            a(weights),
            density_kg_m3=rho,
            heat_capacity_j_kg_k=cp,
            maximum_samples=100,
            maximum_grid_values=100,
        )

    def balance(self, times, energy, source, outward):
        return heat_balance_si(a(times), a(energy), a(source), a(outward), maximum_samples=100)

    def test_weighted_energy_does_not_use_naive_temperature_sum(self):
        # Opposite changes cancel unweighted, but volumes1,2 yield 6J increase.
        result = self.energy([[300, 300], [299, 301]], [1, 2])
        np.testing.assert_array_equal(result, [0, 6])

    def test_redistribution_and_offset_invariance(self):
        result = self.energy([[290, 310], [295, 305], [300, 300]], [1, 1])
        np.testing.assert_array_equal(result, [0, 0, 0])
        temperatures = a([[300, 300], [301, 302]])
        np.testing.assert_array_equal(
            self.energy(temperatures, [1, 1]), self.energy(temperatures + 1000, [1, 1])
        )

    def test_two_dimensional_thickness_weights(self):
        # Four cells each area2, thickness0.5 => volume1; rise2K => 48J.
        result = self.energy([[[300, 300], [300, 300]], [[302, 302], [302, 302]]], [[1, 1], [1, 1]])
        np.testing.assert_array_equal(result, [0, 48])

    def test_outward_flux_sign_and_nonuniform_time(self):
        result = self.balance([0, 1, 3], [0, -2, -6], [0, 0, 0], [2, 2, 2])
        np.testing.assert_array_equal(result.residual_j, [0, 0, 0])
        wrong_sign = self.balance([0, 1, 3], [0, -2, -6], [0, 0, 0], [-2, -2, -2])
        np.testing.assert_array_equal(wrong_sign.residual_j, [0, -4, -12])

    def test_linear_net_power_exact_integral(self):
        # Source=2t+3, outward=1 => integral(t^2+2t), irregular sample spacing.
        result = self.balance([0, 1, 3], [0, 3, 15], [3, 5, 9], [1, 1, 1])
        np.testing.assert_array_equal(result.integrated_net_input_j, [0, 3, 15])
        np.testing.assert_array_equal(result.residual_j, [0, 0, 0])

    def test_quadrature_is_not_an_oracle(self):
        # P=t^2 has exact integral1/3 at t=1; two-sample trapezoid gives1/2.
        result = self.balance([0, 1], [0, 1 / 3], [0, 1], [0, 0])
        self.assertAlmostEqual(result.residual_j[-1], -1 / 6)
        self.assertEqual(result.time_quadrature, "piecewise_linear_trapezoidal")
        self.assertFalse(hasattr(result, "status"))

    def test_periodic_diffusion_with_source_and_seeded_energy_loss(self):
        # Authored finite-difference fixture: diffusion redistributes energy;
        # a constant source adds four joules per second in total.
        cells, steps, dt = 16, 80, 0.1
        initial = np.sin(np.arange(cells, dtype=np.float64) * (2 * np.pi / cells))
        times = np.arange(steps + 1, dtype=np.float64) * dt

        def simulate(loss):
            current = initial.copy()
            snapshots = [current.copy()]
            for _ in range(steps):
                current = (
                    current
                    + 0.1 * (np.roll(current, 1) - 2 * current + np.roll(current, -1))
                    + dt * (0.25 - loss)
                )
                snapshots.append(current.copy())
            return self.energy(np.stack(snapshots), np.ones(cells), rho=1, cp=1)

        source = np.full(steps + 1, 4.0)
        outward = np.zeros(steps + 1)
        correct = self.balance(times, simulate(0), source, outward)
        faulty = self.balance(times, simulate(0.05), source, outward)
        self.assertLess(np.max(np.abs(correct.residual_j)), 1e-10)
        self.assertAlmostEqual(faulty.residual_j[-1], -6.4, places=10)
        self.assertFalse(hasattr(correct, "status"))

    def test_rejects_bad_shapes_material_and_weights(self):
        for weights in ([0, 1], [-1, 1], [np.inf, 1], [1]):
            with self.assertRaises(NumericInputError):
                self.energy([[300, 301]], weights)
        for rho in (0, -1, np.nan, True):
            with self.assertRaises(NumericInputError):
                self.energy([[300]], [1], rho=rho)
        with self.assertRaises(NumericInputError):
            self.energy([[300], [np.nan]], [1])

    def test_rejects_bad_time_and_reference_and_overflow(self):
        for times in ([0, 0], [1, 0], [0, np.inf]):
            with self.assertRaises(NumericInputError):
                self.balance(times, [0, 1], [1, 1], [0, 0])
        with self.assertRaisesRegex(NumericInputError, "heat_energy_reference_mismatch"):
            self.balance([0, 1], [1, 2], [1, 1], [0, 0])
        with self.assertRaisesRegex(NumericInputError, "unrepresentable_heat_result"):
            self.energy([[0], [1e308]], [1])

    def test_caps_and_snapshot_ownership(self):
        with self.assertRaisesRegex(NumericInputError, "heat_dimension_limit"):
            thermal_energy_change_si(
                a([[300, 300]]),
                a([1, 1]),
                density_kg_m3=1,
                heat_capacity_j_kg_k=1,
                maximum_samples=1,
                maximum_grid_values=1,
            )
        energy = a([0, 1])
        result = self.balance([0, 1], energy, [1, 1], [0, 0])
        energy[1] = 100
        self.assertEqual(result.energy_change_j[1], 1)
        self.assertFalse(result.residual_j.flags.writeable)


if __name__ == "__main__":
    unittest.main()
