"""Typed wire boundaries; Zod contracts and shared parity fixtures own the protocol.

These models validate structure and deterministic protocol refinements only.
They do not establish source safety, execution provenance or physical meaning.
Validate decoded JSON rather than enabling Pydantic's JSON coercion shortcuts.
"""

from __future__ import annotations

import base64
import math
import re
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic.alias_generators import to_camel

UUID_PATTERN = r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)"
DIGEST_PATTERN = r"[0-9a-f]{64}"


def _uuid(value: str) -> str:
    if re.fullmatch(UUID_PATTERN, value, flags=re.I) is None:
        raise ValueError("invalid_identifier")
    return value


def _digest(value: str) -> str:
    if re.fullmatch(DIGEST_PATTERN, value) is None:
        raise ValueError("invalid_digest")
    return value


def _json_integer(value: object) -> int:
    # JSON has one number type; Zod accepts 1.0 when it represents an integer.
    # Do not also accept booleans, numeric strings or arbitrary __int__ objects.
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value) and value.is_integer():
        return int(value)
    raise ValueError("expected_json_integer")


def _bounded_text(minimum: int, maximum: int) -> AfterValidator:
    def validate(value: str) -> str:
        # The pinned Zod version measures code points, matching Python len.
        if not minimum <= len(value) <= maximum:
            raise ValueError("text_length_limit")
        return value

    return AfterValidator(validate)


Identifier = Annotated[str, AfterValidator(_uuid)]
Digest = Annotated[str, AfterValidator(_digest)]
JsonInteger = Annotated[int, BeforeValidator(_json_integer)]
PositiveLine = Annotated[JsonInteger, Field(ge=1, le=9007199254740991)]
ObservationKey = Literal[
    "times",
    "temperature",
    "positions",
    "velocities",
    "masses",
    "central_mu",
    "gravity_constant",
    "thermal_weights",
    "source_power",
    "outward_power",
]


class WireModel(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        revalidate_instances="always",
        hide_input_in_errors=True,
    )


class InspectionSource(WireModel):
    artifact_id: Identifier
    source_digest: Digest
    source_base64: Annotated[str, Field(max_length=174764)]

    @model_validator(mode="after")
    def canonical_encoding(self) -> Self:
        try:
            raw = base64.b64decode(self.source_base64, validate=True)
        except ValueError as error:
            raise ValueError("invalid_source_encoding") from error
        if base64.b64encode(raw).decode("ascii") != self.source_base64:
            raise ValueError("invalid_source_encoding")
        return self


class InspectionJobRequest(WireModel):
    schema_version: Literal["1.0"]
    operation_id: Identifier
    input_digest: Digest
    maximum_source_bytes: Annotated[JsonInteger, Field(ge=1, le=131072)]
    sources: Annotated[list[InspectionSource], Field(min_length=1, max_length=10)]

    @model_validator(mode="after")
    def manifest_limits(self) -> Self:
        if len({source.artifact_id for source in self.sources}) != len(self.sources):
            raise ValueError("duplicate_source")
        size = sum(len(base64.b64decode(source.source_base64)) for source in self.sources)
        if size > self.maximum_source_bytes:
            raise ValueError("source_limit")
        return self


class Dependency(WireModel):
    kind: Literal["absolute_import", "relative_import"]
    name: Annotated[str, _bounded_text(1, 200)]
    line: PositiveLine


class Definition(WireModel):
    kind: Literal["FunctionDef", "AsyncFunctionDef", "ClassDef", "assignment"]
    name: Annotated[str, _bounded_text(1, 200)]
    line: PositiveLine


class InspectionFinding(WireModel):
    code: Literal[
        "source_byte_limit",
        "null_byte",
        "invalid_source_encoding",
        "syntax_error",
        "parser_resource_or_input_error",
        "dynamic_code_requires_review",
        "dynamic_import_requires_review",
    ]
    line: PositiveLine | None


class InspectionResult(WireModel):
    schema_version: Literal["1.0"]
    source_digest: Digest
    parsed: bool
    truncated: bool
    dependencies: Annotated[list[Dependency], Field(max_length=200)]
    definitions: Annotated[list[Definition], Field(max_length=200)]
    findings: Annotated[list[InspectionFinding], Field(max_length=200)]

    @model_validator(mode="after")
    def outcome_consistency(self) -> Self:
        if len(self.dependencies) + len(self.definitions) + len(self.findings) > 200:
            raise ValueError("inspection_record_limit")
        failures = [item for item in self.findings if not item.code.endswith("_requires_review")]
        if self.parsed and failures:
            raise ValueError("contradictory_inspection_result")
        if not self.parsed and (
            len(failures) != 1 or self.dependencies or self.definitions or self.truncated
        ):
            raise ValueError("contradictory_inspection_result")
        return self


class InspectedSource(WireModel):
    artifact_id: Identifier
    inspection: InspectionResult


class InspectionJobResult(WireModel):
    schema_version: Literal["1.0"]
    operation_id: Identifier
    input_digest: Digest
    sources: Annotated[list[InspectedSource], Field(min_length=1, max_length=10)]


def validate_inspection_job_result(
    value: object, request: InspectionJobRequest
) -> InspectionJobResult:
    result = InspectionJobResult.model_validate(value)
    expected = {item.artifact_id: item.source_digest for item in request.sources}
    if (
        result.operation_id != request.operation_id
        or result.input_digest != request.input_digest
        or len(result.sources) != len(expected)
        or len({item.artifact_id for item in result.sources}) != len(expected)
        or any(
            expected.get(item.artifact_id) != item.inspection.source_digest
            for item in result.sources
        )
    ):
        raise ValueError("inspection_result_identity_mismatch")
    return result


class KeySelector(WireModel):
    kind: Literal["key"]
    key: Annotated[str, _bounded_text(1, 200)]


class IndexSelector(WireModel):
    kind: Literal["index"]
    index: Annotated[JsonInteger, Field(ge=0, le=1000000)]


class ObservationMapping(WireModel):
    key: ObservationKey
    root: Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")]
    steps: Annotated[
        list[Annotated[KeySelector | IndexSelector, Field(discriminator="kind")]],
        Field(max_length=8),
    ]
    expected_shape: Annotated[
        list[Annotated[JsonInteger, Field(ge=1, le=65536)]], Field(max_length=4)
    ]
    axis_order: Annotated[list[Annotated[JsonInteger, Field(ge=0, le=3)]], Field(max_length=4)]
    declared_unit: Annotated[str, _bounded_text(1, 100)]

    @model_validator(mode="after")
    def literal_axes(self) -> Self:
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,99}", self.root) is None or self.root.startswith(
            "__"
        ):
            raise ValueError("invalid_observation_root")
        if sorted(self.axis_order) != list(range(len(self.expected_shape))):
            raise ValueError("invalid_observation_axes")
        return self


class ObservationDescriptor(WireModel):
    key: ObservationKey
    filename: Annotated[str, StringConstraints(pattern=r"^obs_[a-z][a-z0-9_]{0,63}\.npy$")]
    sha256: Digest
    bytes: Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]
    shape: Annotated[
        list[Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]], Field(max_length=4)
    ]
    dtype: Literal["float64"]
    declared_unit: Annotated[str, _bounded_text(1, 100)]


class SourceJobResult(WireModel):
    schema_version: Literal["1.0"]
    operation_id: Identifier
    input_digest: Digest
    adapter_digest: Digest
    execution_profile: Literal["runpy_main_root_v1"]
    observations: Annotated[list[ObservationDescriptor], Field(min_length=1, max_length=10)]


class ObservationValidationRequest(WireModel):
    schema_version: Literal["1.0"]
    evaluation_operation_id: Identifier
    source_operation_id: Identifier
    input_digest: Digest
    adapter_digest: Digest
    manifest: SourceJobResult
    mappings: Annotated[list[ObservationMapping], Field(min_length=1, max_length=10)]
    maximum_bytes: Annotated[JsonInteger, Field(ge=1, le=52428800)]
    maximum_elements: Annotated[JsonInteger, Field(ge=1, le=6553600)]

    @model_validator(mode="after")
    def approved_observations(self) -> Self:
        if self.evaluation_operation_id == self.source_operation_id:
            raise ValueError("separate_evaluation_operation_required")
        expected = {item.key: item for item in self.mappings}
        manifest = self.manifest
        if (
            manifest.operation_id != self.source_operation_id
            or manifest.input_digest != self.input_digest
            or manifest.adapter_digest != self.adapter_digest
            or len(expected) != len(self.mappings)
            or len(manifest.observations) != len(expected)
            or len({item.key for item in manifest.observations}) != len(expected)
            or sum(item.bytes for item in manifest.observations) > self.maximum_bytes
            or sum(math.prod(item.expected_shape) for item in self.mappings) > self.maximum_elements
        ):
            raise ValueError("observation_export_identity_or_budget_mismatch")
        for item in manifest.observations:
            mapping = expected.get(item.key)
            if (
                mapping is None
                or item.filename != "obs_" + item.key + ".npy"
                or item.shape != mapping.expected_shape
                or item.declared_unit != mapping.declared_unit
            ):
                raise ValueError("observation_export_mapping_mismatch")
        return self


class ValidatedObservation(WireModel):
    key: ObservationKey
    sha256: Digest
    bytes: Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]
    shape: Annotated[list[Annotated[JsonInteger, Field(ge=1, le=65536)]], Field(max_length=4)]
    dtype: Literal["float64"]
    original_dtype: Annotated[str, StringConstraints(pattern=r"^[<>=]f8$")]
    conversion: Literal["none", "exact_to_float64"]
    declared_unit: Annotated[str, _bounded_text(1, 100)]
    elements: Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]


class ObservationValidationResult(WireModel):
    schema_version: Literal["1.0"]
    evaluation_operation_id: Identifier
    source_operation_id: Identifier
    input_digest: Digest
    adapter_digest: Digest
    validation: Literal["validated_numeric_structure"]
    total_bytes: Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]
    total_elements: Annotated[JsonInteger, Field(ge=0, le=9007199254740991)]
    observations: Annotated[list[ValidatedObservation], Field(min_length=1, max_length=10)]

    @model_validator(mode="after")
    def consistent_totals(self) -> Self:
        if (
            self.evaluation_operation_id == self.source_operation_id
            or len({item.key for item in self.observations}) != len(self.observations)
            or any(item.elements != math.prod(item.shape) for item in self.observations)
            or self.total_bytes != sum(item.bytes for item in self.observations)
            or self.total_elements != sum(item.elements for item in self.observations)
        ):
            raise ValueError("invalid_validation_summary")
        return self


def validate_observation_validation_result(
    value: object, request: ObservationValidationRequest
) -> ObservationValidationResult:
    result = ObservationValidationResult.model_validate(value)
    expected = {item.key: item for item in request.manifest.observations}
    if (
        result.evaluation_operation_id != request.evaluation_operation_id
        or result.source_operation_id != request.source_operation_id
        or result.input_digest != request.input_digest
        or result.adapter_digest != request.adapter_digest
        or len(result.observations) != len(expected)
        or result.total_bytes > request.maximum_bytes
        or result.total_elements > request.maximum_elements
    ):
        raise ValueError("validation_summary_snapshot_mismatch")
    for item in result.observations:
        source = expected.get(item.key)
        if (
            source is None
            or source.sha256 != item.sha256
            or source.bytes != item.bytes
            or source.declared_unit != item.declared_unit
            or source.shape != item.shape
        ):
            raise ValueError("validation_summary_observation_mismatch")
    return result
