"""Data-only SI measurements; never authorizes a released physics check.

The caller must verify context, adapter fidelity and sandbox provenance. This
library revalidates the complete numeric export before invoking diagnostics.
No uploaded module, runtime namespace, tolerance or repair code is accepted.
"""

import json
import math
import sys
from decimal import DecimalException
from pathlib import Path

from .arithmetic_bounds import ArithmeticBoundError, diagnostic_arithmetic_bounds
from .evidence import maximum_absolute_drift
from .heat import heat_balance_si, thermal_energy_change_si
from .inspection_job import DIGEST, UUID, _unique_object
from .numeric_inputs import NumericInputError
from .orbital import central_invariants_si, isolated_invariants_si
from .validation_job import _validate_request, load_numeric_payloads, validate_observation_job

METRICS = {
    "central_orbit_si": (
        ("specific_energy_drift", "m^2/s^2"),
        ("specific_angular_momentum_drift", "m^2/s"),
    ),
    "isolated_orbits_si": (
        ("total_energy_drift", "J"),
        ("angular_momentum_drift", "kg*m^2/s"),
        ("linear_momentum_drift", "kg*m/s"),
    ),
    "heat_energy_si": (("thermal_energy_change", "J"),),
    "heat_balance_si": (("heat_balance_residual", "J"),),
}


def _request(request):
    fields = {
        "schemaVersion",
        "auditId",
        "revisionId",
        "operationId",
        "contextDigest",
        "validation",
        "profile",
    }
    if type(request) is not dict or set(request) != fields or request["schemaVersion"] != "1.0":
        raise NumericInputError("invalid_diagnostic_job")
    for key in ("auditId", "revisionId", "operationId"):
        if type(request[key]) is not str or not UUID.fullmatch(request[key]):
            raise NumericInputError("invalid_diagnostic_job")
    if type(request["contextDigest"]) is not str or not DIGEST.fullmatch(request["contextDigest"]):
        raise NumericInputError("invalid_diagnostic_job")
    validation = _validate_request(request["validation"])
    if request["operationId"] in (
        validation["sourceOperationId"],
        validation["evaluationOperationId"],
    ):
        raise NumericInputError("separate_diagnostic_operation_required")
    profile = request["profile"]
    if (
        type(profile) is not dict
        or type(profile.get("kind")) is not str
        or profile["kind"] not in METRICS
    ):
        raise NumericInputError("invalid_diagnostic_profile")
    heat = profile["kind"].startswith("heat_")
    if set(profile) != ({"kind", "densityKgM3", "heatCapacityJKgK"} if heat else {"kind"}):
        raise NumericInputError("invalid_diagnostic_profile")
    if heat:
        for key in ("densityKgM3", "heatCapacityJKgK"):
            if (
                type(profile[key]) not in (int, float)
                or not math.isfinite(profile[key])
                or profile[key] <= 0
            ):
                raise NumericInputError("invalid_heat_material")
    mappings = {item["key"]: item for item in validation["mappings"]}

    def shape(key, unit):
        item = mappings.get(key)
        if item is None or item["declaredUnit"] != unit:
            raise NumericInputError("diagnostic_requires_explicit_si_units")
        return item["expectedShape"]

    times = shape("times", "s")
    if len(times) != 1 or times[0] < 2:
        raise NumericInputError("diagnostic_requires_multiple_samples")
    if heat:
        temperatures = shape("temperature", "K")
        weights = shape("thermal_weights", "m^3")
        if (
            len(temperatures) not in (2, 3)
            or temperatures[0] != times[0]
            or weights != temperatures[1:]
            or math.prod(weights) > 65536
        ):
            raise NumericInputError("diagnostic_shape_or_dimension_limit")
        if profile["kind"] == "heat_balance_si":
            for key in ("source_power", "outward_power"):
                if shape(key, "W") != times:
                    raise NumericInputError("diagnostic_shape_or_dimension_limit")
    else:
        positions = shape("positions", "m")
        if (
            len(positions) != 3
            or positions[0] != times[0]
            or positions[2] not in (2, 3)
            or shape("velocities", "m/s") != positions
        ):
            raise NumericInputError("diagnostic_shape_or_dimension_limit")
        if profile["kind"] == "central_orbit_si":
            if positions[1] != 1 or shape("central_mu", "m^3/s^2") != []:
                raise NumericInputError("diagnostic_shape_or_dimension_limit")
        elif (
            not 2 <= positions[1] <= 32
            or shape("masses", "kg") != [positions[1]]
            or shape("gravity_constant", "m^3/(kg*s^2)") != []
        ):
            raise NumericInputError("diagnostic_shape_or_dimension_limit")
    return times[0]


def run_diagnostics_job(request, payloads):
    """Rehash/decode data, measure drift/residual and return bounded summaries.

    SI unit strings are explicit protocol values, not inferred conversions.
    Labels alone do not verify physical units or force/boundary semantics.
    """
    samples = _request(request)
    _report, decoded = validate_observation_job(request["validation"], payloads)
    arrays = {key: item.values for key, item in decoded.items()}
    times = arrays["times"]
    kind = request["profile"]["kind"]
    limitations = [
        "Measurements describe supplied sampled data, not independently verified simulation execution.",
        "Context, units, force/boundary semantics and adapter fidelity require separate verification.",
        "No released method, accuracy target or complete uncertainty treatment supports a pass or flag.",
        "Saved samples can miss between-sample behavior; conservation does not establish trajectory accuracy.",
    ]
    if kind == "central_orbit_si":
        values = central_invariants_si(
            arrays["positions"][:, 0, :],
            arrays["velocities"][:, 0, :],
            central_mu_m3_s2=float(arrays["central_mu"]),
            maximum_samples=samples,
        )
        series = [values.specific_energy_m2_s2, values.specific_angular_momentum_m2_s]
        limitations.append(
            "Specific quantities assume one test body relative to a fixed central point mass in an inertial frame; no total momentum is reported."
        )
    elif kind == "isolated_orbits_si":
        values = isolated_invariants_si(
            arrays["positions"],
            arrays["velocities"],
            arrays["masses"],
            gravitational_constant=float(arrays["gravity_constant"]),
            maximum_samples=samples,
            maximum_bodies=32,
        )
        series = [values.energy_j, values.angular_momentum_kg_m2_s, values.momentum_kg_m_s]
        limitations.append(
            "Total quantities assume isolated Newtonian point masses, fixed positive masses and a fixed inertial angular-momentum origin."
        )
    else:
        profile = request["profile"]
        energy = thermal_energy_change_si(
            arrays["temperature"],
            arrays["thermal_weights"],
            density_kg_m3=profile["densityKgM3"],
            heat_capacity_j_kg_k=profile["heatCapacityJKgK"],
            maximum_samples=samples,
            maximum_grid_values=65536,
        )
        series = [energy]
        limitations.append(
            "Energy uses positive physical volume/quadrature weights including thickness and constant material properties; energy change alone is not a conservation claim."
        )
        if kind == "heat_balance_si":
            balance = heat_balance_si(
                times,
                energy,
                arrays["source_power"],
                arrays["outward_power"],
                maximum_samples=samples,
            )
            series = [balance.residual_j]
            limitations.append(
                "Net input uses piecewise-linear trapezoidal integration of independently supplied source and outward-positive powers; quadrature uncertainty is unresolved."
            )
    metrics = [
        {
            "name": name,
            "unit": unit,
            "value": maximum_absolute_drift(values, maximum_samples=samples),
            "normalization": "absolute",
            "status": "inconclusive",
            "reason": "measurement_only",
        }
        for (name, unit), values in zip(METRICS[kind], series)
    ]
    try:
        bounds = diagnostic_arithmetic_bounds(arrays, request["profile"], metrics)
    except (ArithmeticBoundError, DecimalException) as error:
        bounds = [None] * len(metrics)
        limitations.append(
            "Arithmetic enclosure exceeded its versioned work allowance; no zero uncertainty is substituted."
            if isinstance(error, ArithmeticBoundError) and str(error) == "arithmetic_work_limit"
            else "Arithmetic enclosure is unavailable or not representable; no zero uncertainty is substituted."
        )
    for metric, bound in zip(metrics, bounds):
        metric["arithmetic"] = bound
    limitations.append(
        "Arithmetic enclosures cover only formula evaluation on exact represented inputs; they exclude state, parameter, mapping, discretization, quadrature and between-sample uncertainty."
    )
    validation = request["validation"]
    return {
        "schemaVersion": "1.0",
        "auditId": request["auditId"],
        "revisionId": request["revisionId"],
        "operationId": request["operationId"],
        "validationOperationId": validation["evaluationOperationId"],
        "sourceOperationId": validation["sourceOperationId"],
        "inputDigest": validation["inputDigest"],
        "contextDigest": request["contextDigest"],
        "adapterDigest": validation["adapterDigest"],
        "profile": dict(request["profile"]),
        "kind": "numeric_diagnostics",
        "methodVersion": "0.1.0",
        "sampleCount": samples,
        "timeRangeSeconds": [float(times[0]), float(times[-1])],
        "metrics": metrics,
        "limitations": limitations,
    }


def run_diagnostics_cli(input_stream, *, input_directory, result_path):
    """Production uses launcher-owned constants; no user path is accepted."""
    code = 0
    try:
        raw = input_stream.read(65537)
        if len(raw) > 65536:
            raise NumericInputError("diagnostic_request_byte_limit")
        request = json.loads(raw, object_pairs_hook=_unique_object)
        _request(request)
        payloads = load_numeric_payloads(request["validation"], input_directory)
        result = run_diagnostics_job(request, payloads)
        encoded = json.dumps(result, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(encoded) > 32768:
            raise NumericInputError("diagnostic_result_byte_limit")
    except Exception:
        encoded = b'{"schemaVersion":"1.0","error":"numeric_diagnostics_failed"}'
        code = 2
    try:
        with Path(result_path).open("xb") as handle:
            handle.write(encoded)
    except Exception:
        return 2
    return code


if __name__ == "__main__":
    raise SystemExit(
        run_diagnostics_cli(
            sys.stdin.buffer,
            input_directory="/tmp/siphon-diagnostics-data",
            result_path="/tmp/siphon-diagnostics-result.json",
        )
    )
