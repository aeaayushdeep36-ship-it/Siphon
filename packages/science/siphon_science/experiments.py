"""Data-only baseline conservation experiment; fixed trusted-evaluator CLI.

Uploaded source never enters this process. The server resolves assertions and
policy support against the current owner/revision before dispatch. This job
recomputes numeric diagnostics rather than trusting supplied measured values.
"""

import json
import sys
from pathlib import Path

from pydantic import TypeAdapter

from .diagnostics_job import _request, run_diagnostics_job
from .inspection_job import _unique_object
from .models import Digest, Identifier
from .scientific_checks import PROFILE_CHECKS, SampledAccuracyPolicy, evaluate_sampled_metric
from .validation_job import load_numeric_payloads


def _validate_envelope(value):
    fields = {"schemaVersion", "diagnostic", "eligibility", "planDigest", "evidenceIds", "policies"}
    if type(value) is not dict or set(value) != fields or value["schemaVersion"] != "1.0":
        raise ValueError("invalid_experiment_envelope")
    request = value["diagnostic"]
    _request(request)
    TypeAdapter(Digest).validate_python(value["planDigest"])
    assessment = value["eligibility"]
    fields = {
        "schemaVersion",
        "domain",
        "inputDigest",
        "contextDigest",
        "adapterDigest",
        "decisions",
    }
    if type(assessment) is not dict or set(assessment) != fields:
        raise ValueError("invalid_eligibility_assessment")
    heat = request["profile"]["kind"].startswith("heat_")
    if assessment["schemaVersion"] != "1.0" or assessment["domain"] != (
        "heat_diffusion" if heat else "orbital_dynamics"
    ):
        raise ValueError("experiment_domain_mismatch")
    for key, expected in (
        ("inputDigest", request["validation"]["inputDigest"]),
        ("adapterDigest", request["validation"]["adapterDigest"]),
        ("contextDigest", request["contextDigest"]),
    ):
        if assessment[key] != expected:
            raise ValueError("experiment_snapshot_mismatch")
    expected_checks = (
        {"H_ENERGY", "H_BALANCE", "H_TIME_REF", "H_GRID_REF", "H_REFERENCE"}
        if heat
        else {"O_ENERGY", "O_ANGULAR", "O_MOMENTUM", "O_REFINE", "O_REFERENCE"}
    )
    decisions = assessment["decisions"]
    if type(decisions) is not list or len(decisions) != 5:
        raise ValueError("invalid_eligibility_decisions")
    allowed = set()
    seen = set()
    for item in decisions:
        if type(item) is not dict or set(item) != {
            "checkId",
            "registryVersion",
            "status",
            "applicability",
            "released",
            "reasons",
        }:
            raise ValueError("invalid_eligibility_decision")
        check = item["checkId"]
        if check not in expected_checks or check in seen or item["registryVersion"] != "0.1.0":
            raise ValueError("invalid_registry_decision")
        seen.add(check)
        if item["status"] not in ("eligible", "unresolved", "ineligible") or item[
            "applicability"
        ] not in ("eligible", "unresolved", "ineligible"):
            raise ValueError("invalid_eligibility_status")
        if type(item["released"]) is not bool or type(item["reasons"]) is not list:
            raise ValueError("invalid_eligibility_decision")
        if item["status"] == "eligible":
            if not item["released"] or item["applicability"] != "eligible" or item["reasons"]:
                raise ValueError("contradictory_eligibility")
            allowed.add(check)
    selected = allowed.intersection(PROFILE_CHECKS[request["profile"]["kind"]])
    for key in ("evidenceIds", "policies"):
        if type(value[key]) is not dict or set(value[key]) - selected:
            raise ValueError("policy_for_unselected_check")
    if set(value["evidenceIds"]) != selected:
        raise ValueError("missing_evidence_identity")
    for identity in value["evidenceIds"].values():
        TypeAdapter(Identifier).validate_python(identity)
    if len(set(value["evidenceIds"].values())) != len(selected):
        raise ValueError("duplicate_evidence_identity")
    for policy in value["policies"].values():
        SampledAccuracyPolicy.model_validate(policy)
    return selected


def evaluate_conservation_job(envelope, payloads):
    """Rehash exports, measure, enclose arithmetic, then apply explicit targets."""
    selected = _validate_envelope(envelope)
    diagnostics = run_diagnostics_job(envelope["diagnostic"], payloads)
    checks = PROFILE_CHECKS[diagnostics["profile"]["kind"]]
    evidence = [
        evaluate_sampled_metric(
            diagnostics,
            metric,
            check_id=check,
            plan_digest=envelope["planDigest"],
            evidence_id=envelope["evidenceIds"][check],
            policy=envelope["policies"].get(check, {"scope": "reported_samples", "target": None}),
        )
        for check, metric in zip(checks, diagnostics["metrics"])
        if check in selected
    ]
    return {"schemaVersion": "1.0", "diagnostics": diagnostics, "evidence": evidence}


def run_experiments_cli(input_stream, *, input_directory, result_path):
    try:
        raw = input_stream.read(65537)
        if len(raw) > 65536:
            raise ValueError("experiment_request_byte_limit")
        envelope = json.loads(raw, object_pairs_hook=_unique_object)
        _validate_envelope(envelope)
        payloads = load_numeric_payloads(envelope["diagnostic"]["validation"], input_directory)
        result = evaluate_conservation_job(envelope, payloads)
        encoded = json.dumps(result, separators=(",", ":"), allow_nan=False).encode()
        if len(encoded) > 32768:
            raise ValueError("experiment_result_byte_limit")
        code = 0
    except Exception:
        encoded = b'{"schemaVersion":"1.0","error":"experiment_failed"}'
        code = 2
    Path(result_path).write_bytes(encoded)
    return code


if __name__ == "__main__":
    raise SystemExit(
        run_experiments_cli(
            sys.stdin.buffer,
            input_directory="/tmp/siphon-experiment-data",
            result_path="/tmp/siphon-experiment-result.json",
        )
    )
