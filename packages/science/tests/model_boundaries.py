"""Shared authored contract cases. No source is imported, inspected or executed."""

import json
from pathlib import Path

from siphon_science.models import (
    InspectionJobRequest,
    ObservationMapping,
    ObservationValidationRequest,
    validate_inspection_job_result,
    validate_observation_validation_result,
)

FIXTURES = Path(__file__).resolve().parents[2] / "contracts/fixtures/python-boundaries.json"


def cases():
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def validate_case(case):
    value = case["value"]
    if case["kind"] == "inspection_result":
        return validate_inspection_job_result(
            value, InspectionJobRequest.model_validate(case["request"])
        )
    if case["kind"] == "observation_validation_result":
        return validate_observation_validation_result(
            value, ObservationValidationRequest.model_validate(case["request"])
        )
    models = {
        "inspection_request": InspectionJobRequest,
        "mapping": ObservationMapping,
        "observation_validation": ObservationValidationRequest,
    }
    return models[case["kind"]].model_validate(value)


def results():
    output = []
    for case in cases():
        try:
            normalized = validate_case(case).model_dump(mode="json", by_alias=True)
        except ValueError:
            output.append({"id": case["id"], "valid": False})
        else:
            output.append({"id": case["id"], "valid": True, "normalized": normalized})
    return output


if __name__ == "__main__":
    print(json.dumps(results(), separators=(",", ":"), allow_nan=False))
