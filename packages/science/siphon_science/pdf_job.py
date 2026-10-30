"""Fixed-path, data-only PDF job. Never imports uploaded simulation modules."""

import hashlib
import json
import sys
from pathlib import Path

from .pdf_models import MAX_LAYOUT_BYTES, parse_pdf_document
from .pdf_render import render_pdf


def run_pdf_cli(input_stream, *, pdf_path, result_path):
    try:
        payload = input_stream.read(MAX_LAYOUT_BYTES + 1)
        if len(payload) > MAX_LAYOUT_BYTES:
            raise ValueError("pdf_layout_byte_limit")
        document = parse_pdf_document(payload)
        output = render_pdf(payload)
        receipt = {
            "schemaVersion": "1.0",
            "reportId": document.report_id,
            "reportDigest": document.report_digest,
            "documentDigest": hashlib.sha256(payload).hexdigest(),
            "pdfSha256": hashlib.sha256(output).hexdigest(),
            "bytes": len(output),
        }
        with Path(pdf_path).open("xb") as handle:
            handle.write(output)
        with Path(result_path).open("xb") as handle:
            handle.write(json.dumps(receipt, separators=(",", ":")).encode("utf-8"))
        return 0
    except Exception:
        # No decoder strings, display text, paths or raw exceptions leave this job.
        return 2


if __name__ == "__main__":
    raise SystemExit(
        run_pdf_cli(
            sys.stdin.buffer,
            pdf_path="/tmp/siphon-report.pdf",
            result_path="/tmp/siphon-pdf-result.json",
        )
    )
