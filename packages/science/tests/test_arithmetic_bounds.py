import math
import random
import unittest
from decimal import Decimal, DefaultContext, Inexact, localcontext
from fractions import Fraction
from unittest.mock import patch

import numpy as np
from test_diagnostics_job import central, job

from siphon_science.arithmetic_bounds import (
    Arithmetic,
    ArithmeticBoundError,
    Interval,
    diagnostic_arithmetic_bounds,
    summarize_interval,
)
from siphon_science.diagnostics_job import run_diagnostics_job


def fraction(value):
    return Fraction.from_float(float(value))


class ArithmeticBoundsTests(unittest.TestCase):
    def contains(self, interval, exact):
        self.assertLessEqual(Fraction(interval.lower), exact)
        self.assertGreaterEqual(Fraction(interval.upper), exact)

    def covers(self, metric, exact):
        bound = metric["arithmetic"]
        self.assertIsNotNone(bound)
        self.assertLessEqual(fraction(bound["lower"]), exact)
        self.assertGreaterEqual(fraction(bound["upper"]), exact)
        self.assertGreaterEqual(
            fraction(bound["absoluteUncertaintyBound"]), abs(fraction(metric["value"]) - exact)
        )

    def test_elementary_operations_enclose_independent_exact_rational_arithmetic(self):
        engine = Arithmetic()
        rng = random.Random(442)
        pairs = [
            (0.1, 0.2),
            (-0.1, 0.2),
            (1e308, 1e-308),
            (math.ulp(0.0), -math.ulp(0.0)),
            (1e308, -1e308),
            (-2.0, -3.0),
        ]
        pairs += [
            (
                math.ldexp(rng.uniform(-1, 1), rng.randint(-1000, 1000)),
                math.ldexp(rng.uniform(-1, 1), rng.randint(-1000, 1000)),
            )
            for _ in range(50)
        ]
        for a, b in pairs:
            with self.subTest(a=a, b=b):
                x, y = engine.point(a), engine.point(b)
                self.contains(engine.add(x, y), fraction(a) + fraction(b))
                self.contains(engine.sub(x, y), fraction(a) - fraction(b))
                self.contains(engine.mul(x, y), fraction(a) * fraction(b))
                self.contains(engine.div(x, y), fraction(a) / fraction(b))
                self.contains(engine.square(x), fraction(a) ** 2)

    def test_thick_interval_products_quotients_and_square_handle_all_signs(self):
        engine = Arithmetic()
        for a, b in ((-3, -1), (-2, 4), (0, 5), (2, 3)):
            x = Interval(Decimal(a), Decimal(b))
            self.assertEqual(engine.square(x).lower, 0 if a <= 0 <= b else min(a * a, b * b))
            for c, d in ((-4, -2), (1, 7)):
                y = Interval(Decimal(c), Decimal(d))
                for left in (Fraction(a), Fraction(a + b, 2), Fraction(b)):
                    for right in (Fraction(c), Fraction(c + d, 2), Fraction(d)):
                        self.contains(engine.mul(x, y), left * right)
                        self.contains(engine.div(x, y), left / right)

    def test_square_roots_are_verified_by_exact_squared_endpoint_comparisons(self):
        engine = Arithmetic()
        for value in (0.0, 2.0, 9.0, 0.1, math.ulp(0.0), 1e308):
            with self.subTest(value=value):
                result = engine.sqrt(engine.point(value))
                self.assertGreaterEqual(result.lower, 0)
                self.assertLessEqual(Fraction(result.lower) ** 2, fraction(value))
                self.assertGreaterEqual(Fraction(result.upper) ** 2, fraction(value))
        self.contains(engine.norm(engine.vector([3.0, 4.0])), Fraction(5))

    def test_default_and_current_decimal_context_cannot_silently_reduce_enclosure_precision(self):
        old = DefaultContext.copy()
        try:
            DefaultContext.prec, DefaultContext.Emax = 2, 9
            DefaultContext.traps[Inexact] = True
            with localcontext() as context:
                context.prec, context.Emax = 2, 9
                context.traps[Inexact] = True
                engine = Arithmetic()
                self.contains(engine.div(engine.point(1.0), engine.point(7.0)), Fraction(1, 7))
                self.assertEqual(context.prec, 2)
                self.contains(
                    engine.mul(engine.point(1e308), engine.point(1e-308)),
                    fraction(1e308) * fraction(1e-308),
                )
        finally:
            DefaultContext.prec, DefaultContext.Emax = old.prec, old.Emax
            DefaultContext.traps = old.traps

    def test_outward_float_conversion_preserves_small_nonzero_and_cancellation_bounds(self):
        engine = Arithmetic()
        tiny = engine.mul(engine.point(math.ulp(0.0)), engine.half)
        result = summarize_interval(tiny, 0.0)
        self.assertEqual(result["lower"], 0.0)
        self.assertEqual(result["upper"], math.ulp(0.0))
        self.assertGreater(result["absoluteUncertaintyBound"], 0.0)
        self.assertEqual(summarize_interval(engine.zero, 0.0)["absoluteUncertaintyBound"], 0.0)
        bound = summarize_interval(
            engine.absolute(
                engine.sub(engine.point(0.3), engine.add(engine.point(0.1), engine.point(0.2)))
            ),
            0.0,
        )
        self.assertGreaterEqual(
            fraction(bound["absoluteUncertaintyBound"]),
            abs(fraction(0.3) - fraction(0.1) - fraction(0.2)),
        )

    def test_invalid_or_unrepresentable_intervals_never_return_a_zero_bound(self):
        engine = Arithmetic()
        for value in (True, float("nan"), float("inf")):
            with self.assertRaises(ArithmeticBoundError):
                engine.point(value)
        with self.assertRaises(ArithmeticBoundError):
            engine.div(engine.point(1.0), Interval(Decimal(-1), Decimal(1)))
        with self.assertRaises(ArithmeticBoundError):
            engine.sqrt(engine.point(-1.0))
        with self.assertRaises(ArithmeticBoundError):
            Interval(Decimal(2), Decimal(1))
        with self.assertRaises(ArithmeticBoundError):
            summarize_interval(engine.mul(engine.point(1e308), engine.point(1e308)), 1.0)

    def test_heat_weighted_sum_encloses_exact_float_input_formula(self):
        temperatures = [[300.1, 299.9], [300.3, 299.8], [300.7, 299.6]]
        weights, rho, cp = [0.1, 0.3], 2.1, 3.7
        request, payloads = job(
            {"times": [0.0, 0.1, 0.3], "temperature": temperatures, "thermal_weights": weights},
            {"kind": "heat_energy_si", "densityKgM3": rho, "heatCapacityJKgK": cp},
        )
        metric = run_diagnostics_job(request, payloads)["metrics"][0]
        exact = max(
            abs(
                sum(
                    (fraction(row[i]) - fraction(temperatures[0][i]))
                    * fraction(weights[i])
                    * fraction(rho)
                    * fraction(cp)
                    for i in range(2)
                )
            )
            for row in temperatures
        )
        self.covers(metric, exact)
        self.assertEqual(metric["status"], "inconclusive")

    def test_heat_balance_encloses_sampled_trapezoid_not_unknown_continuous_power_integral(self):
        times, temperature, source = [0.0, 0.3, 1.0], [[10.0], [10.2], [10.7]], [0.1, 0.4, 0.7]
        request, payloads = job(
            {
                "times": times,
                "temperature": temperature,
                "thermal_weights": [0.2],
                "source_power": source,
                "outward_power": [0.05, 0.05, 0.05],
            },
            {"kind": "heat_balance_si", "densityKgM3": 2.1, "heatCapacityJKgK": 3.7},
        )
        result = run_diagnostics_job(request, payloads)
        residuals, integral = [], Fraction(0)
        for index in range(3):
            if index:
                integral += (
                    (fraction(times[index]) - fraction(times[index - 1]))
                    * (fraction(source[index]) + fraction(source[index - 1]) - 2 * fraction(0.05))
                    / 2
                )
            energy = (
                (fraction(temperature[index][0]) - fraction(10.0))
                * fraction(0.2)
                * fraction(2.1)
                * fraction(3.7)
            )
            residuals.append(abs(energy - integral))
        self.covers(result["metrics"][0], max(residuals))
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "temperature": [[0.0], [1 / 3]],
                "thermal_weights": [1.0],
                "source_power": [0.0, 1.0],
                "outward_power": [0.0, 0.0],
            },
            {"kind": "heat_balance_si", "densityKgM3": 1.0, "heatCapacityJKgK": 1.0},
        )
        metric = run_diagnostics_job(request, payloads)["metrics"][0]
        self.covers(metric, abs(fraction(1 / 3) - Fraction(1, 2)))
        self.assertGreater(metric["arithmetic"]["lower"], 0.16)
        self.assertLess(metric["arithmetic"]["absoluteUncertaintyBound"], 1e-14)

    def test_central_speed_defect_encloses_exact_energy_and_angular_formulas(self):
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[1.0, 0.0]], [[0.0, 1.0]]],
                "velocities": [[[0.0, 1.0]], [[-1.1, 0.0]]],
                "central_mu": 1.0,
            },
            {"kind": "central_orbit_si"},
        )
        metrics = run_diagnostics_job(request, payloads)["metrics"]
        self.covers(metrics[0], (fraction(1.1) ** 2 - 1) / 2)
        self.covers(metrics[1], fraction(1.1) - 1)
        clean = run_diagnostics_job(*central())["metrics"]
        for metric in clean:
            self.covers(metric, Fraction(0))

    def test_three_body_energy_angular_and_momentum_norm_have_independent_exact_controls(self):
        request, payloads = job(
            {
                "times": [0.0, 1.0],
                "positions": [[[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [0.0, 4.0, 0.0]]] * 2,
                "velocities": [
                    [[1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [-1.0, 0.0, 0.0]],
                    [[2.0, 0.0, 0.0], [0.0, 4.0, 0.0], [-2.0, 0.0, 0.0]],
                ],
                "masses": [1.0, 2.0, 3.0],
                "gravity_constant": 1.0,
            },
            {"kind": "isolated_orbits_si"},
        )
        metrics = run_diagnostics_job(request, payloads)["metrics"]
        self.covers(metrics[0], Fraction(18))
        self.covers(metrics[1], Fraction(24))
        momentum = metrics[2]["arithmetic"]
        self.assertLessEqual(fraction(momentum["lower"]) ** 2, 20)
        self.assertGreaterEqual(fraction(momentum["upper"]) ** 2, 20)

    def test_unavailable_arithmetic_enclosure_is_explicit_null_and_does_not_hide_a_measurement(
        self,
    ):
        request, payloads = central()
        with patch(
            "siphon_science.diagnostics_job.diagnostic_arithmetic_bounds",
            side_effect=ArithmeticBoundError("unrepresentable_arithmetic_bound"),
        ):
            result = run_diagnostics_job(request, payloads)
        self.assertTrue(
            all(
                metric["arithmetic"] is None and metric["status"] == "inconclusive"
                for metric in result["metrics"]
            )
        )
        self.assertTrue(any("no zero uncertainty" in text for text in result["limitations"]))

    def test_work_guard_stops_large_enclosures_before_per_state_computation(self):
        arrays = {"times": np.arange(2048, dtype=np.float64), "positions": np.zeros((2048, 32, 2))}
        with self.assertRaisesRegex(ArithmeticBoundError, "arithmetic_work_limit"):
            diagnostic_arithmetic_bounds(arrays, {"kind": "isolated_orbits_si"}, [])
        arrays = {"times": np.arange(32, dtype=np.float64), "thermal_weights": np.ones(65536)}
        with self.assertRaisesRegex(ArithmeticBoundError, "arithmetic_work_limit"):
            diagnostic_arithmetic_bounds(arrays, {"kind": "heat_energy_si"}, [])


if __name__ == "__main__":
    unittest.main()
