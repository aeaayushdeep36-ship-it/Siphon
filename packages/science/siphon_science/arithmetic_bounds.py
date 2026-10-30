"""Outward enclosures of formulas evaluated on the exact represented inputs.

These bounds cover evaluation roundoff ONLY. They do not cover uncertainty of
the states/parameters, unit mappings, time/spatial discretization, quadrature or
between-sample behavior. No eligibility or verdict is produced here.
"""

import math
from dataclasses import dataclass
from decimal import (
    ROUND_CEILING,
    ROUND_FLOOR,
    ROUND_HALF_EVEN,
    Clamped,
    Context,
    Decimal,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    Underflow,
)


class ArithmeticBoundError(ValueError):
    pass


# Versioned evaluator work guard, not an accuracy threshold. The whole job still
# requires provider lifetime/CPU accounting. A term is a heat cell-sample, or an
# orbital body-sample plus pair-sample. No client/model may raise this ceiling.
MAXIMUM_ARITHMETIC_TERMS_V1 = 1_000_000


@dataclass(frozen=True)
class Interval:
    lower: Decimal
    upper: Decimal

    def __post_init__(self):
        if not self.lower.is_finite() or not self.upper.is_finite() or self.lower > self.upper:
            raise ArithmeticBoundError("invalid_arithmetic_interval")


class Arithmetic:
    """Contexts are private to this calculation, independent of global Decimal settings."""

    def __init__(self):
        options = dict(
            prec=50,
            Emin=-999999,
            Emax=999999,
            capitals=1,
            clamp=0,
            flags=[],
            traps=[Clamped, DivisionByZero, InvalidOperation, Overflow, Underflow],
        )
        self.down = Context(rounding=ROUND_FLOOR, **options)
        self.up = Context(rounding=ROUND_CEILING, **options)
        self.nearest = Context(rounding=ROUND_HALF_EVEN, **options)
        self.zero = self.point(0.0)
        self.half = self.point(0.5)

    @staticmethod
    def point(value):
        # from_float preserves the exact binary64 input, unlike Decimal(str(x)).
        if isinstance(value, bool):
            raise ArithmeticBoundError("invalid_arithmetic_input")
        decimal = Decimal.from_float(float(value))
        return Interval(decimal, decimal)

    def add(self, x, y):
        return Interval(self.down.add(x.lower, y.lower), self.up.add(x.upper, y.upper))

    def sub(self, x, y):
        return Interval(self.down.subtract(x.lower, y.upper), self.up.subtract(x.upper, y.lower))

    @staticmethod
    def neg(x):
        return Interval(x.upper.copy_negate(), x.lower.copy_negate())

    def mul(self, x, y):
        pairs = [(a, b) for a in (x.lower, x.upper) for b in (y.lower, y.upper)]
        return Interval(
            min(self.down.multiply(a, b) for a, b in pairs),
            max(self.up.multiply(a, b) for a, b in pairs),
        )

    def div(self, x, y):
        if y.lower <= 0 <= y.upper:
            raise ArithmeticBoundError("arithmetic_denominator_contains_zero")
        pairs = [(a, b) for a in (x.lower, x.upper) for b in (y.lower, y.upper)]
        return Interval(
            min(self.down.divide(a, b) for a, b in pairs),
            max(self.up.divide(a, b) for a, b in pairs),
        )

    def square(self, x):
        squares = [self.up.multiply(a, a) for a in (x.lower, x.upper)]
        lower = (
            Decimal(0)
            if x.lower <= 0 <= x.upper
            else min(self.down.multiply(a, a) for a in (x.lower, x.upper))
        )
        return Interval(lower, max(squares))

    def sqrt(self, x):
        if x.lower < 0:
            raise ArithmeticBoundError("negative_arithmetic_square_root")
        # Decimal sqrt is correctly rounded HALF_EVEN irrespective of requested
        # rounding mode. Adjacent decimal values enclose that rounded result.
        lower = Decimal(0) if x.lower == 0 else self.nearest.next_minus(self.nearest.sqrt(x.lower))
        upper = Decimal(0) if x.upper == 0 else self.nearest.next_plus(self.nearest.sqrt(x.upper))
        return Interval(lower, upper)

    @staticmethod
    def absolute(x):
        low = Decimal(0) if x.lower <= 0 <= x.upper else min(x.lower.copy_abs(), x.upper.copy_abs())
        return Interval(low, max(x.lower.copy_abs(), x.upper.copy_abs()))

    @staticmethod
    def maximum(x, y):
        return Interval(max(x.lower, y.lower), max(x.upper, y.upper))

    def sum(self, values):
        result = self.zero
        for value in values:
            result = self.add(result, value)
        return result

    def norm(self, vector):
        return self.sqrt(self.sum(self.square(value) for value in vector))

    def cross(self, x, y):
        return [
            self.sub(self.mul(x[1], y[2]), self.mul(x[2], y[1])),
            self.sub(self.mul(x[2], y[0]), self.mul(x[0], y[2])),
            self.sub(self.mul(x[0], y[1]), self.mul(x[1], y[0])),
        ]

    def vector(self, values):
        return [self.point(value) for value in values] + ([self.zero] if len(values) == 2 else [])

    def drift(self, current, initial):
        if isinstance(current, Interval):
            return self.absolute(self.sub(current, initial))
        return self.norm([self.sub(value, first) for value, first in zip(current, initial)])


def _float_outward(value, *, upward):
    result = float(value)
    if not math.isfinite(result):
        raise ArithmeticBoundError("unrepresentable_arithmetic_bound")
    represented = Decimal.from_float(result)
    if (upward and represented < value) or (not upward and represented > value):
        result = math.nextafter(result, math.inf if upward else -math.inf)
    if not math.isfinite(result) or (
        Decimal.from_float(result) < value if upward else Decimal.from_float(result) > value
    ):
        raise ArithmeticBoundError("unrepresentable_arithmetic_bound")
    return result


def summarize_interval(interval, measured_value):
    """Enclose exact metric and bound |exact_metric - existing_float_metric|."""
    if interval.lower < 0 or not math.isfinite(measured_value) or measured_value < 0:
        raise ArithmeticBoundError("invalid_arithmetic_metric")
    lower = _float_outward(interval.lower, upward=False)
    upper = _float_outward(interval.upper, upward=True)
    # Include endpoint conversion in the radius. Use directed subtraction, never
    # an unqualified global Decimal operation or a nearest-rounded float sum.
    engine = Arithmetic()
    point = engine.point(measured_value)
    converted = Interval(Decimal.from_float(lower), Decimal.from_float(upper))
    radius = engine.absolute(engine.sub(converted, point)).upper
    return {
        "method": "decimal50_interval_v1",
        "scope": "sampled_formula_roundoff",
        "lower": lower,
        "upper": upper,
        "absoluteUncertaintyBound": _float_outward(radius, upward=True),
    }


def diagnostic_arithmetic_bounds(arrays, profile, measured_metrics):
    """Internal caller supplies already validated readonly SI numeric arrays.

    Work scales as O(samples*cells) for heat or O(samples*bodies^2) for mutual
    gravity, with one sample's temporary intervals. Provider time limits apply.
    """
    engine = Arithmetic()
    kind = profile["kind"]
    samples = arrays["times"].shape[0]
    if kind.startswith("heat_"):
        terms = samples * arrays["thermal_weights"].size
    else:
        bodies = arrays["positions"].shape[1]
        terms = samples * (bodies + bodies * (bodies - 1) // 2)
    if terms > MAXIMUM_ARITHMETIC_TERMS_V1:
        raise ArithmeticBoundError("arithmetic_work_limit")
    initial, maxima = None, None
    if kind.startswith("heat_"):
        rho, cp = engine.point(profile["densityKgM3"]), engine.point(profile["heatCapacityJKgK"])
        capacities = [
            engine.mul(engine.mul(engine.point(weight), rho), cp)
            for weight in arrays["thermal_weights"].flat
        ]
        baseline = [engine.point(value) for value in arrays["temperature"][0].flat]
        integrated = engine.zero
    else:
        parameter = engine.point(
            float(arrays["central_mu" if kind == "central_orbit_si" else "gravity_constant"])
        )
        if kind == "isolated_orbits_si":
            masses = [engine.point(value) for value in arrays["masses"]]
    for sample in range(samples):
        if kind.startswith("heat_"):
            energy = (
                engine.zero
                if sample == 0
                else engine.sum(
                    engine.mul(engine.sub(engine.point(value), first), capacity)
                    for value, first, capacity in zip(
                        arrays["temperature"][sample].flat, baseline, capacities
                    )
                )
            )
            if kind == "heat_balance_si" and sample:
                width = engine.sub(
                    engine.point(arrays["times"][sample]), engine.point(arrays["times"][sample - 1])
                )
                net = [
                    engine.sub(
                        engine.point(arrays["source_power"][index]),
                        engine.point(arrays["outward_power"][index]),
                    )
                    for index in (sample - 1, sample)
                ]
                integrated = engine.add(
                    integrated, engine.mul(width, engine.mul(engine.half, engine.add(*net)))
                )
            current = [engine.sub(energy, integrated) if kind == "heat_balance_si" else energy]
        else:
            r = [engine.vector(value) for value in arrays["positions"][sample]]
            v = [engine.vector(value) for value in arrays["velocities"][sample]]
            if kind == "central_orbit_si":
                energy = engine.sub(
                    engine.mul(engine.half, engine.sum(engine.square(value) for value in v[0])),
                    engine.div(parameter, engine.norm(r[0])),
                )
                current = [energy, engine.cross(r[0], v[0])]
            else:
                weighted = [
                    [engine.mul(mass, component) for component in velocity]
                    for mass, velocity in zip(masses, v)
                ]
                kinetic = engine.sum(
                    engine.mul(
                        engine.half,
                        engine.mul(
                            mass, engine.sum(engine.square(component) for component in velocity)
                        ),
                    )
                    for mass, velocity in zip(masses, v)
                )
                potential = engine.zero
                for i in range(len(masses)):
                    for j in range(i + 1, len(masses)):
                        distance = engine.norm([engine.sub(a, b) for a, b in zip(r[i], r[j])])
                        potential = engine.sub(
                            potential,
                            engine.div(
                                engine.mul(parameter, engine.mul(masses[i], masses[j])), distance
                            ),
                        )
                crosses = [
                    engine.cross(position, momentum) for position, momentum in zip(r, weighted)
                ]
                angular = [engine.sum(value[axis] for value in crosses) for axis in range(3)]
                momentum = [engine.sum(value[axis] for value in weighted) for axis in range(3)]
                current = [engine.add(kinetic, potential), angular, momentum]
        if initial is None:
            initial = current
            maxima = [engine.zero] * len(current)
        # The first-sample drift is identically zero; avoid losing that correlation.
        if sample:
            maxima = [
                engine.maximum(bound, engine.drift(value, first))
                for bound, value, first in zip(maxima, current, initial)
            ]
    return [
        summarize_interval(interval, metric["value"])
        for interval, metric in zip(maxima, measured_metrics)
    ]
