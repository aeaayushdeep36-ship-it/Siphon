"""Authored presentation data only; no uploaded source or external services."""

import io
import json

import pytest
from pypdf import PdfReader

from siphon_science import pdf_render
from siphon_science.pdf_models import parse_pdf_document


def layout():
    return {
        "schemaVersion": "1.0",
        "reportId": "10000000-0000-4000-8000-000000000001",
        "auditId": "10000000-0000-4000-8000-000000000002",
        "revisionId": "10000000-0000-4000-8000-000000000003",
        "reportDigest": "a" * 64,
        "title": "AUTHORED FIXTURE - NOT A REAL AUDIT",
        "domain": "heat_diffusion",
        "createdAt": "2026-10-29T00:00:00.000Z",
        "coverage": "limited",
        "blocks": [
            {"kind": "heading", "text": "Scientific evidence"},
            {
                "kind": "paragraph",
                "text": "ρ Δt μ: 0.5000000000000001 J; inconclusive.",
                "tone": "warning",
            },
        ],
    }


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def test_plain_unicode_precision_and_invariant_pdf():
    payload = encoded(layout())
    first, second = pdf_render.render_pdf(payload), pdf_render.render_pdf(payload)
    assert first == second
    reader = PdfReader(io.BytesIO(first))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "ρ Δt μ: 0.5000000000000001 J; inconclusive." in text
    assert "AUTHORED FIXTURE - NOT A REAL AUDIT" in text
    assert "Page 1" in text
    assert reader.metadata.subject == "Report SHA-256 " + "a" * 64
    assert "/JavaScript" not in reader.trailer["/Root"]
    assert all("/Annots" not in page for page in reader.pages)


def test_literal_markup_never_opens_files_or_urls(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Image reader must never be reached")

    monkeypatch.setattr("reportlab.platypus.paraparser.ImageReader", forbidden)
    value = layout()
    value["blocks"].append(
        {
            "kind": "paragraph",
            "text": '<img src="file:///private/no-image.png"/><a href="https://example.org">literal</a>',
            "tone": "normal",
        }
    )
    reader = PdfReader(io.BytesIO(pdf_render.render_pdf(encoded(value))))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "file:///private/no-image.png" in text
    assert "<img" in text
    assert all("/Annots" not in page for page in reader.pages)


@pytest.mark.parametrize(
    "mutation",
    [
        "unknown_block",
        "extra",
        "control",
        "surrogate",
        "bad_date",
        "bad_id",
        "wrong_type",
        "too_many_blocks",
    ],
)
def test_invalid_layout_rejected(mutation):
    value = layout()
    if mutation == "unknown_block":
        value["blocks"] = [{"kind": "image", "url": "https://example.org"}]
    if mutation == "extra":
        value["template"] = "untrusted"
    if mutation == "control":
        value["title"] = "\x00"
    if mutation == "surrogate":
        value["title"] = "\ud800"
    if mutation == "bad_date":
        value["createdAt"] = "2025-02-29T00:00:00Z"
    if mutation == "bad_id":
        value["reportId"] = "not-an-id"
    if mutation == "wrong_type":
        value["blocks"][0]["text"] = 100
    if mutation == "too_many_blocks":
        value["blocks"] *= 751
    # ensure_ascii also permits malformed-surrogate test transport without encoding it.
    with pytest.raises(ValueError):
        pdf_render.render_pdf(json.dumps(value).encode())


def test_duplicate_keys_and_byte_limit():
    with pytest.raises(ValueError, match="duplicate_json_key"):
        parse_pdf_document(b'{"title":"first","title":"second"}')
    with pytest.raises(ValueError, match="pdf_layout_byte_limit"):
        pdf_render.render_pdf(b" " * (512 * 1024 + 1))


@pytest.mark.parametrize("text", ["unsupported \U0001f6f8", "مرحبا"])
def test_missing_glyph_or_unsupported_shaping_fails_without_replacement(text):
    value = layout()
    value["blocks"][1]["text"] = text
    with pytest.raises(ValueError, match="pdf_font_glyph_unavailable|pdf_complex_text_unsupported"):
        pdf_render.render_pdf(encoded(value))


def test_long_text_paginates_and_page_limit_is_enforced(monkeypatch):
    value = layout()
    value["blocks"] += [
        {"kind": "paragraph", "text": "Long authored explanation " * 40, "tone": "normal"}
    ] * 25
    reader = PdfReader(io.BytesIO(pdf_render.render_pdf(encoded(value))))
    assert len(reader.pages) > 1
    assert all(f"Page {i + 1}" in page.extract_text() for i, page in enumerate(reader.pages))
    monkeypatch.setattr(pdf_render, "MAX_PAGES", 1)
    with pytest.raises(ValueError, match="pdf_page_limit"):
        pdf_render.render_pdf(encoded(value))


def test_pdf_output_bound(monkeypatch):
    monkeypatch.setattr(pdf_render, "MAX_PDF_BYTES", 256)
    with pytest.raises(ValueError, match="pdf_output_byte_limit"):
        pdf_render.render_pdf(encoded(layout()))
