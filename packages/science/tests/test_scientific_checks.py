"""Authored analytic controls and seeded faults; no uploaded source execution."""

import copy
import io
import json
import tempfile
import uuid
from pathlib import Path

import numpy as np
import pytest
from test_diagnostics_job import job

from siphon_science.experiments import evaluate_conservation_job, run_experiments_cli
from siphon_science.scientific_checks import PROFILE_CHECKS


def envelope(arrays, profile, *, target=1e-8):
    request, payloads = job(arrays, profile)
    checks = PROFILE_CHECKS[profile["kind"]]
    heat = profile["kind"].startswith("heat_")
    all_checks = (
        ("H_ENERGY", "H_BALANCE", "H_TIME_REF", "H_GRID_REF", "H_REFERENCE")
        if heat
        else ("O_ENERGY", "O_ANGULAR", "O_MOMENTUM", "O_REFINE", "O_REFERENCE")
    )
    units = {
        "H_ENERGY": "J",
        "O_ENERGY": "m^2/s^2" if profile["kind"] == "central_orbit_si" else "J",
        "O_ANGULAR": "m^2/s" if profile["kind"] == "central_orbit_si" else "kg*m^2/s",
        "O_MOMENTUM": "kg*m/s",
    }
    assessment = {
        "schemaVersion": "1.0",
        "domain": "heat_diffusion" if heat else "orbital_dynamics",
        "inputDigest": request["validation"]["inputDigest"],
        "contextDigest": request["contextDigest"],
        "adapterDigest": request["validation"]["adapterDigest"],
        "decisions": [
            {
                "checkId": check,
                "registryVersion": "0.1.0",
                "status": "eligible" if check in checks else "ineligible",
                "applicability": "eligible" if check in checks else "ineligible",
                "released": check in checks,
                "reasons": [],
            }
            for check in all_checks
        ],
    }
    return {
        "schemaVersion": "1.0",
        "diagnostic": request,
        "eligibility": assessment,
        "planDigest": "d" * 64,
        "evidenceIds": {check: str(uuid.uuid4()) for check in checks},
        "policies": {
            check: {
                "scope": "reported_samples",
                "target": {
                    "value": target,
                    "unit": units[check],
                    "justification": "Authored fixture requirement on maximum saved-sample invariant drift, in explicit SI units.",
                    "evidenceIds": [str(uuid.uuid4())],
                },
            }
            for check in checks
        },
    }, payloads


def heat_case(*, dimensions=2, faulty=False):
    # A Fourier mode on a periodic uniform finite-volume grid. Sum of a
    # discrete Laplacian is zero by telescoping in each direction.
    x = np.arange(8) * (2 * np.pi / 8)
    state = 300 + np.cos(x)
    if dimensions == 2:
        state = state[:, None] + np.sin(x)[None, :]
    samples = [state.copy()]
    for _ in range(8):
        laplacian = sum(
            np.roll(state, 1, axis) - 2 * state + np.roll(state, -1, axis)
            for axis in range(dimensions)
        )
        state = state + 0.1 * laplacian + (0.01 if faulty else 0)
        samples.append(state.copy())
    return envelope(
        {
            "times": np.arange(9) * 0.1,
            "temperature": samples,
            "thermal_weights": np.full(state.shape, 0.125**dimensions),
        },
        {"kind": "heat_energy_si", "densityKgM3": 2.0, "heatCapacityJKgK": 3.0},
    )


def central_case(*, faulty=False, wrong_phase=False):
    times = np.linspace(0, 1, 21)
    angle = times * (2 if wrong_phase else 1)
    r = np.stack((np.cos(angle), np.sin(angle)), axis=1)[:, None, :]
    v = np.stack((-np.sin(angle), np.cos(angle)), axis=1)[:, None, :]
    if faulty:
        v *= 1 + times[:, None, None] * 0.1
    return envelope(
        {"times": times, "positions": r, "velocities": v, "central_mu": 1.0},
        {"kind": "central_orbit_si"},
    )


def mutual_case(*, faulty=False):
    # Three equal masses at vertices of an equilateral triangle, radius 1.
    # Side sqrt(3), pair-force inward sum 1/sqrt(3): omega^2=1/sqrt(3).
    times = np.linspace(0, 1, 21)
    omega = 3 ** (-0.25)
    angles = omega * times[:, None] + np.arange(3)[None, :] * (2 * np.pi / 3)
    r = np.stack((np.cos(angles), np.sin(angles)), axis=-1)
    v = omega * np.stack((-np.sin(angles), np.cos(angles)), axis=-1)
    if faulty:
        v[:, 0, 0] += times * 0.1
    return envelope(
        {
            "times": times,
            "positions": r,
            "velocities": v,
            "masses": [1.0] * 3,
            "gravity_constant": 1.0,
        },
        {"kind": "isolated_orbits_si"},
    )


@pytest.mark.parametrize("factory", [heat_case, central_case, mutual_case])
def test_independent_clean_and_seeded_drift(factory):
    request, payloads = factory()
    clean = evaluate_conservation_job(request, payloads)
    assert all(item["status"] == "passed_within_tolerance" for item in clean["evidence"])
    request, payloads = factory(faulty=True)
    faulty = evaluate_conservation_job(request, payloads)
    assert any(item["status"] == "flagged" for item in faulty["evidence"])
    assert all("code bug" in item["limitations"][-1] for item in faulty["evidence"])


def test_one_dimensional_control_and_phase_error_limitation():
    request, payloads = heat_case(dimensions=1)
    assert (
        evaluate_conservation_job(request, payloads)["evidence"][0]["status"]
        == "passed_within_tolerance"
    )
    # Wrong angular position evolution with unchanged circular velocity
    # magnitudes preserves E and h. It must not become a trajectory certificate.
    request, payloads = central_case(wrong_phase=True)
    result = evaluate_conservation_job(request, payloads)
    assert all(item["status"] == "passed_within_tolerance" for item in result["evidence"])
    assert "trajectory/phase accuracy" in result["evidence"][0]["limitations"][-1]


def test_eccentric_kepler_central_and_mutual_two_body_controls():
    # Independently parameterized Kepler ellipse: a=2, e=1/2, mu=1,
    # E-e*sin(E)=n*t; dE/dt=n/(1-e*cos(E)). This trajectory is not
    # generated by the diagnostic or an integration/reference solver.
    anomaly = np.linspace(0, 2 * np.pi, 31)
    eccentricity, axis = 0.5, 2.0
    mean_motion = np.sqrt(1 / axis**3)
    times = (anomaly - eccentricity * np.sin(anomaly)) / mean_motion
    rate = mean_motion / (1 - eccentricity * np.cos(anomaly))
    relative_r = axis * np.stack(
        (np.cos(anomaly) - eccentricity, np.sqrt(1 - eccentricity**2) * np.sin(anomaly)),
        axis=1,
    )
    relative_v = (
        axis
        * rate[:, None]
        * np.stack((-np.sin(anomaly), np.sqrt(1 - eccentricity**2) * np.cos(anomaly)), axis=1)
    )
    request, payloads = envelope(
        {
            "times": times,
            "positions": relative_r[:, None, :],
            "velocities": relative_v[:, None, :],
            "central_mu": 1.0,
        },
        {"kind": "central_orbit_si"},
    )
    assert all(
        item["status"] == "passed_within_tolerance"
        for item in evaluate_conservation_job(request, payloads)["evidence"]
    )
    # Equal masses1/2, G=1 => relative mu=1. Barycentric states are ±r/2.
    request, payloads = envelope(
        {
            "times": times,
            "positions": np.stack((-relative_r / 2, relative_r / 2), axis=1),
            "velocities": np.stack((-relative_v / 2, relative_v / 2), axis=1),
            "masses": [0.5, 0.5],
            "gravity_constant": 1.0,
        },
        {"kind": "isolated_orbits_si"},
    )
    result = evaluate_conservation_job(request, payloads)
    assert all(item["status"] == "passed_within_tolerance" for item in result["evidence"])
    assert result["evidence"][2]["metric"]["value"] == 0.0


def test_missing_target_remains_inconclusive_and_roundoff_is_not_default_zero():
    request, payloads = mutual_case()
    request["policies"] = {}
    result = evaluate_conservation_job(request, payloads)
    assert all(item["reason"] == "missing_target" for item in result["evidence"])
    assert all(item["interval"] is None for item in result["evidence"])
    assert all(item["uncertainty"]["value"] > 0 for item in result["evidence"])


def test_target_overlap_and_missing_arithmetic_stay_inconclusive(monkeypatch):
    import siphon_science.experiments as experiments

    request, payloads = central_case()
    result = evaluate_conservation_job(request, payloads)
    first = result["evidence"][0]
    request["policies"]["O_ENERGY"]["target"]["value"] = first["metric"]["value"]
    assert (
        evaluate_conservation_job(request, payloads)["evidence"][0]["reason"]
        == "interval_overlaps_target"
    )
    diagnostics = copy.deepcopy(result["diagnostics"])
    for metric in diagnostics["metrics"]:
        metric["arithmetic"] = None
    monkeypatch.setattr(experiments, "run_diagnostics_job", lambda *_: diagnostics)
    assert all(
        item["reason"] == "missing_uncertainty_bound"
        for item in evaluate_conservation_job(request, payloads)["evidence"]
    )


@pytest.mark.parametrize("failure", ["stale", "unsupported_scope", "units", "release", "corrupt"])
def test_invalid_authority_and_bytes_cannot_produce_verdict(failure):
    request, payloads = heat_case()
    if failure == "stale":
        request["eligibility"]["contextDigest"] = "0" * 64
    elif failure == "unsupported_scope":
        request["policies"]["H_ENERGY"]["scope"] = "physical_correctness"
    elif failure == "units":
        request["policies"]["H_ENERGY"]["target"]["unit"] = "K"
    elif failure == "release":
        request["eligibility"]["decisions"][0]["released"] = False
    else:
        payloads[next(iter(payloads))] = b"corrupt"
    with pytest.raises(ValueError):
        evaluate_conservation_job(request, payloads)


def test_fixed_data_only_cli_and_sanitized_failure():
    request, payloads = central_case()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        numeric = root / "numeric"
        numeric.mkdir()
        for name, raw in payloads.items():
            (numeric / name).write_bytes(raw)
        result = root / "result.json"
        assert (
            run_experiments_cli(
                io.BytesIO(json.dumps(request).encode()),
                input_directory=numeric,
                result_path=result,
            )
            == 0
        )
        assert len(json.loads(result.read_bytes())["evidence"]) == 2
        assert (
            run_experiments_cli(
                io.BytesIO(b"private-source-marker"), input_directory=numeric, result_path=result
            )
            == 2
        )
        assert json.loads(result.read_bytes()) == {
            "schemaVersion": "1.0",
            "error": "experiment_failed",
        }
