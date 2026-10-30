"""Trusted data-only PDF renderer. No user modules, templates, paths or network I/O.

Input is the bounded presentation document generated from a verified report by
reviewed backend code. Layout validation is not evidence/provenance validation.
Production belongs in a separate fresh, resource-bounded PDF-role environment.
"""

from __future__ import annotations

import hashlib
import io
import unicodedata
from functools import lru_cache
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Flowable, Paragraph, SimpleDocTemplate, Spacer

from .pdf_models import Heading, PlotBlock, parse_pdf_document
from .pdf_models import Paragraph as ParagraphBlock

MAX_PDF_BYTES = 5 * 1024 * 1024
MAX_PAGES = 60
FONT_HASHES = {
    "DejaVuSans.ttf": "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954",
    "DejaVuSans-Bold.ttf": "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724",
}


@lru_cache(maxsize=1)
def _fonts() -> tuple[TTFont, TTFont]:
    result = []
    for index, (filename, digest) in enumerate(FONT_HASHES.items()):
        path = Path(__file__).parent / "assets" / "fonts" / filename
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("pdf_font_integrity")
        font = TTFont(f"Siphon{'Bold' if index else 'Regular'}", str(path))
        pdfmetrics.registerFont(font)
        result.append(font)
    return result[0], result[1]


def _check_text(value: str, font: TTFont) -> None:
    for character in value:
        if character in "\n\t":
            continue
        if unicodedata.bidirectional(character) in {"R", "AL", "AN"}:
            raise ValueError("pdf_complex_text_unsupported")
        if not font.face.charToGlyph.get(ord(character)):
            raise ValueError("pdf_font_glyph_unavailable")


class _LimitedBuffer(io.BytesIO):
    def write(self, value: bytes) -> int:
        if self.tell() + len(value) > MAX_PDF_BYTES:
            raise ValueError("pdf_output_byte_limit")
        return super().write(value)


class _BoundedCanvas(Canvas):
    def __init__(self, *args, **kwargs):
        kwargs["invariant"] = 1
        super().__init__(*args, **kwargs)

    def showPage(self) -> None:
        if self.getPageNumber() > MAX_PAGES:
            raise ValueError("pdf_page_limit")
        super().showPage()


class _Plot(Flowable):
    def __init__(self, plot, width: float):
        super().__init__()
        self.plot = plot
        self.width = width
        self.height = 210

    def draw(self) -> None:
        canvas = self.canv
        canvas.saveState()
        left, bottom, width, height = 58.0, 30.0, self.width - 76.0, 155.0
        all_points = [point for series in self.plot.series for point in series.points]
        xs, ys = [point.x for point in all_points], [point.y for point in all_points]

        def normalized(values):
            scale = max(max(abs(value) for value in values), 1e-300)
            low, high = (
                min(value / scale for value in values),
                max(value / scale for value in values),
            )

            def position(value):
                return 0.5 if low == high else ((value / scale) - low) / (high - low)

            return position

        x, y = normalized(xs), normalized(ys)
        canvas.setStrokeColor(colors.HexColor("#CBD5E1"))
        canvas.line(left, bottom, left + width, bottom)
        canvas.line(left, bottom, left, bottom + height)
        canvas.setFont("SiphonRegular", 7)
        canvas.setFillColor(colors.HexColor("#475569"))
        canvas.drawString(left, 12, f"X range: {min(xs):.4g} to {max(xs):.4g}")
        canvas.drawString(left, 0, f"Y range: {min(ys):.4g} to {max(ys):.4g}")
        palette = ["#2563EB", "#B45309", "#047857", "#7C3AED"]
        for index, series in enumerate(self.plot.series):
            color = colors.HexColor(palette[index])
            canvas.setStrokeColor(color)
            canvas.setFillColor(color)
            canvas.setLineWidth(1.1)
            points = [
                (left + width * x(point.x), bottom + height * y(point.y)) for point in series.points
            ]
            if self.plot.kind == "line" and len(points) > 1:
                path = canvas.beginPath()
                path.moveTo(*points[0])
                for point in points[1:]:
                    path.lineTo(*point)
                canvas.drawPath(path)
            else:
                for point in points:
                    canvas.circle(*point, 1.4, fill=1, stroke=0)
            canvas.drawString(left + index * 70, bottom + height + 12, f"S{index + 1}")
        canvas.restoreState()


def render_pdf(payload: bytes) -> bytes:
    document = parse_pdf_document(payload)
    regular, bold = _fonts()
    output = _LimitedBuffer()
    body = ParagraphStyle(
        "Body",
        fontName="SiphonRegular",
        fontSize=9,
        leading=13.5,
        textColor=colors.HexColor("#172033"),
        spaceAfter=7,
        splitLongWords=True,
        alignment=TA_LEFT,
        allowWidows=0,
        allowOrphans=0,
    )
    muted = ParagraphStyle(
        "Muted", parent=body, fontSize=8, leading=12, textColor=colors.HexColor("#526079")
    )
    warning = ParagraphStyle("Warning", parent=body, textColor=colors.HexColor("#854D0E"))
    heading = ParagraphStyle(
        "Heading",
        parent=body,
        fontName="SiphonBold",
        fontSize=13,
        leading=17,
        spaceBefore=12,
        spaceAfter=8,
        keepWithNext=True,
    )
    title = ParagraphStyle("Title", parent=heading, fontSize=21, leading=26, spaceBefore=0)

    def paragraph(value: str, style: ParagraphStyle, font: TTFont) -> Paragraph:
        _check_text(value, font)
        # Escape every string before Paragraph's XML parser; no user markup exists.
        return Paragraph(escape(value).replace("\n", "<br/>").replace("\t", "    "), style)

    story = [
        paragraph("Siphon", heading, bold),
        paragraph(document.title, title, bold),
        paragraph(document.domain.replace("_", " ").title(), muted, regular),
        Spacer(1, 5),
    ]
    width = A4[0] - 96
    for block in document.blocks:
        if isinstance(block, Heading):
            story.append(paragraph(block.text, heading, bold))
        elif isinstance(block, ParagraphBlock):
            style = {"normal": body, "muted": muted, "warning": warning}[block.tone]
            story.append(paragraph(block.text, style, regular))
        elif isinstance(block, PlotBlock):
            story.append(_Plot(block.plot, width))

    def footer(canvas: Canvas, _doc) -> None:
        canvas.saveState()
        canvas.setFont("SiphonRegular", 7)
        canvas.setFillColor(colors.HexColor("#526079"))
        canvas.drawString(48, 26, f"Siphon | {document.report_id}")
        canvas.drawRightString(A4[0] - 48, 26, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    report = SimpleDocTemplate(
        output,
        pagesize=A4,
        leftMargin=48,
        rightMargin=48,
        topMargin=42,
        bottomMargin=45,
        title=document.title,
        author="Siphon",
        subject=f"Report SHA-256 {document.report_digest}",
        creator="Siphon PDF renderer 0.1.0",
        pageCompression=1,
    )
    report.build(story, onFirstPage=footer, onLaterPages=footer, canvasmaker=_BoundedCanvas)
    result = output.getvalue()
    if not result.startswith(b"%PDF-") or len(result) > MAX_PDF_BYTES:
        raise ValueError("pdf_output_invalid")
    return result
