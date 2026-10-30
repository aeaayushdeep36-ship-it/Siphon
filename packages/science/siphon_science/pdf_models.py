"""Private data-only presentation protocol, shared with Zod PdfRenderDocument."""

from __future__ import annotations

import json
import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, model_validator

from .models import Digest, Identifier, JsonInteger, WireModel

MAX_LAYOUT_BYTES = 512 * 1024


def _plain(value: str) -> str:
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\ud800-\udfff]", value):
        raise ValueError("unsupported_display_text")
    return value


Text80 = Annotated[str, Field(min_length=1, max_length=80), AfterValidator(_plain)]
Text100 = Annotated[str, Field(min_length=1, max_length=100), AfterValidator(_plain)]
Text200 = Annotated[str, Field(min_length=1, max_length=200), AfterValidator(_plain)]
Text300 = Annotated[str, Field(min_length=1, max_length=300), AfterValidator(_plain)]
Text1000 = Annotated[str, Field(min_length=1, max_length=1000), AfterValidator(_plain)]
Text16000 = Annotated[str, Field(min_length=1, max_length=16000), AfterValidator(_plain)]
PositiveCount = Annotated[JsonInteger, Field(gt=0, le=9007199254740991)]
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]

# Exact pattern emitted by the pinned Zod Timestamp; parity includes calendar edges.
TIMESTAMP = re.compile(
    r"(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|"
    r"\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|"
    r"(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))"
    r"T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z)",
    re.ASCII,
)


def _timestamp(value: str) -> str:
    if not TIMESTAMP.fullmatch(value):
        raise ValueError("invalid_timestamp")
    return value


class PlotPoint(WireModel):
    x: FiniteNumber
    y: FiniteNumber


class PlotSeries(WireModel):
    label: Text200
    experiment_id: Identifier
    original_point_count: PositiveCount
    points: Annotated[list[PlotPoint], Field(min_length=1, max_length=2000)]


class Plot(WireModel):
    id: Identifier
    title: Text300
    kind: Literal["line", "scatter"]
    x_label: Text100
    x_unit: Text80
    y_label: Text100
    y_unit: Text80
    evidence_ids: Annotated[list[Identifier], Field(min_length=1, max_length=20)]
    description: Text1000
    series: Annotated[list[PlotSeries], Field(min_length=1, max_length=4)]


class Heading(WireModel):
    kind: Literal["heading"]
    text: Text300


class Paragraph(WireModel):
    kind: Literal["paragraph"]
    text: Text16000
    tone: Literal["normal", "muted", "warning"]


class PlotBlock(WireModel):
    kind: Literal["plot"]
    plot: Plot


Block = Annotated[Heading | Paragraph | PlotBlock, Field(discriminator="kind")]


class PdfDocument(WireModel):
    schema_version: Literal["1.0"]
    report_id: Identifier
    audit_id: Identifier
    revision_id: Identifier
    report_digest: Digest
    title: Text200
    domain: Literal["heat_diffusion", "orbital_dynamics"]
    created_at: Annotated[str, AfterValidator(_timestamp)]
    coverage: Literal["full", "limited"]
    blocks: Annotated[list[Block], Field(min_length=1, max_length=1500)]

    @model_validator(mode="after")
    def plot_budget(self) -> Self:
        points = 0
        for block in self.blocks:
            if isinstance(block, PlotBlock):
                for series in block.plot.series:
                    if series.original_point_count < len(series.points):
                        raise ValueError("invalid_plot_sampling_label")
                    points += len(series.points)
        if points > 16000:
            raise ValueError("plot_budget_exceeded")
        return self


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def parse_pdf_document(payload: bytes) -> PdfDocument:
    if type(payload) is not bytes or len(payload) > MAX_LAYOUT_BYTES:
        raise ValueError("pdf_layout_byte_limit")
    value = json.loads(payload.decode("utf-8", errors="strict"), object_pairs_hook=_unique_object)
    return PdfDocument.model_validate(value)
