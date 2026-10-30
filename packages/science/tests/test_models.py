import copy
import json

import pytest
from model_boundaries import cases, validate_case

from siphon_science.inspection_job import inspect_job
from siphon_science.models import InspectionJobRequest


@pytest.mark.parametrize("case", cases(), ids=lambda case: case["id"])
def test_shared_wire_boundaries(case):
    if not case["valid"]:
        with pytest.raises(ValueError):
            validate_case(case)
        return
    model = validate_case(case)
    serialized = model.model_dump(mode="json", by_alias=True)
    assert serialized == case["value"]
    second = copy.deepcopy(case)
    second["value"] = json.loads(json.dumps(serialized, allow_nan=False))
    assert validate_case(second).model_dump(by_alias=True) == serialized


def test_typed_request_rejects_python_containers_that_are_not_json_arrays():
    value = cases()[0]["value"]
    value["sources"] = tuple(value["sources"])
    with pytest.raises(ValueError):
        InspectionJobRequest.model_validate(value)


def test_input_errors_do_not_echo_source_text_in_exception_display():
    value = cases()[0]["value"]
    value["sources"][0]["sourceBase64"] = "private source content"
    with pytest.raises(ValueError) as error:
        InspectionJobRequest.model_validate(value)
    assert "private source content" not in str(error.value)


def test_existing_model_instance_cannot_bypass_boundary_revalidation():
    model = InspectionJobRequest.model_validate(cases()[0]["value"])
    model.maximum_source_bytes = True
    with pytest.raises(ValueError):
        InspectionJobRequest.model_validate(model)


def test_nested_model_instance_is_also_revalidated():
    model = InspectionJobRequest.model_validate(cases()[0]["value"])
    model.sources[0].source_digest = "invalid"
    with pytest.raises(ValueError):
        InspectionJobRequest.model_validate(model)


def test_static_job_truncates_astral_identifier_at_wire_character_limit():
    import base64
    import hashlib

    value = cases()[0]["value"]
    source = ("\U00010400" * 201 + " = 1").encode("utf-8")
    value["sources"][0].update(
        sourceDigest=hashlib.sha256(source).hexdigest(),
        sourceBase64=base64.b64encode(source).decode("ascii"),
    )
    result = inspect_job(value)
    assert result["sources"][0]["inspection"]["truncated"] is True
    assert result["sources"][0]["inspection"]["definitions"] == []
