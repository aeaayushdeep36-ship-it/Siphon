"""Released sampled-state conservation criteria, not physical accuracy certificates.

The exact mathematical input is the represented binary64 observation export.
Only formula-evaluation uncertainty is relevant to this explicitly scoped
criterion. State/parameter error and behavior between samples are excluded,
never silently assigned zero uncertainty. Targets remain user requirements.
"""

from typing import Annotated, Literal

from pydantic import Field, TypeAdapter, model_validator

from .evidence import decide_absolute_metric
from .models import Digest, Identifier, WireModel

RELEASED_CHECKS = frozenset(("H_ENERGY", "O_ENERGY", "O_ANGULAR", "O_MOMENTUM"))
PROFILE_CHECKS = {
    "heat_energy_si": ("H_ENERGY",),
    "heat_balance_si": (),  # Physical/time quadrature policy is not released.
    "central_orbit_si": ("O_ENERGY", "O_ANGULAR"),
    "isolated_orbits_si": ("O_ENERGY", "O_ANGULAR", "O_MOMENTUM"),
}
Magnitude = Annotated[float, Field(ge=0, allow_inf_nan=False, strict=True)]


class MetricSupport(WireModel):
    value: Magnitude
    unit: Annotated[str, Field(min_length=1, max_length=80)]
    justification: Annotated[str, Field(min_length=1, max_length=2000)]
    evidence_ids: Annotated[list[Identifier], Field(min_length=1, max_length=20)]

    @model_validator(mode="after")
    def unique_evidence(self):
        if len(set(self.evidence_ids)) != len(self.evidence_ids):
            raise ValueError("duplicate_support_evidence")
        return self


class SampledAccuracyPolicy(WireModel):
    scope: Literal["reported_samples"]
    target: MetricSupport | None


LIMITATIONS = [
    "Criterion applies only to invariant drift at the exported sample states, treating represented states and parameters as exact mathematical inputs.",
    "The interval encloses formula-evaluation roundoff only; it does not bound physical state/parameter error, mapping errors, spatial quadrature error or unobserved between-sample behavior.",
    "Conservation within a declared target does not establish trajectory/phase accuracy, convergence, physical validation or absence of defects; an exceedance alone does not diagnose a code bug.",
]


def evaluate_sampled_metric(diagnostic, metric, *, check_id, plan_digest, evidence_id, policy):
    """Internal producer: caller establishes current eligibility and provenance.

    Called only with a freshly recomputed validated diagnostic by experiments.
    No AI-authored numerical value, interval or numerical verdict is consumed.
    """
    if check_id not in RELEASED_CHECKS:
        raise ValueError("check_not_released")
    TypeAdapter(Digest).validate_python(plan_digest)
    TypeAdapter(Identifier).validate_python(evidence_id)
    policy = SampledAccuracyPolicy.model_validate(policy)
    target = policy.target
    if target and target.unit != metric["unit"]:
        raise ValueError("accuracy_target_unit_mismatch")
    arithmetic = metric["arithmetic"]
    uncertainty = (
        {
            "value": arithmetic["absoluteUncertaintyBound"],
            "unit": metric["unit"],
            "justification": "Directed decimal50_interval_v1 enclosure of the invariant drift formula on exact represented inputs; scope is reported samples only.",
            "evidenceIds": [diagnostic["operationId"]],
        }
        if arithmetic is not None
        else None
    )
    decision = decide_absolute_metric(
        metric["value"],
        target=target.value if target else None,
        absolute_uncertainty_bound=uncertainty["value"] if uncertainty else None,
    )
    return {
        "schemaVersion": "1.0",
        "id": evidence_id,
        "auditId": diagnostic["auditId"],
        "revisionId": diagnostic["revisionId"],
        "checkId": check_id,
        "checkVersion": "0.1.0",
        **{key: diagnostic[key] for key in ("inputDigest", "contextDigest", "adapterDigest")},
        "planDigest": plan_digest,
        "experimentIds": [diagnostic["sourceOperationId"]],
        "metric": {key: metric[key] for key in ("name", "value", "unit", "normalization")},
        "target": target.model_dump(by_alias=True) if target else None,
        "uncertainty": uncertainty,
        "interval": (
            {"lower": decision.lower_bound, "upper": decision.upper_bound}
            if decision.lower_bound is not None
            else None
        ),
        "status": decision.status,
        "reason": decision.reason,
        "limitations": LIMITATIONS.copy(),
    }
