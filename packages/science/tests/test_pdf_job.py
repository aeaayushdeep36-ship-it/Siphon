import hashlib
import io
import json
from pathlib import Path

from siphon_science.pdf_job import run_pdf_cli


def document():
    return {
        "schemaVersion": "1.0",
        "reportId": "11111111-1111-4111-8111-111111111111",
        "auditId": "22222222-2222-4222-8222-222222222222",
        "revisionId": "33333333-3333-4333-8333-333333333333",
        "reportDigest": "a" * 64,
        "title": "Authored PDF job fixture",
        "domain": "heat_diffusion",
        "createdAt": "2026-10-29T00:00:00.000Z",
        "coverage": "limited",
        "blocks": [{"kind": "paragraph", "text": "No real audit claimed.", "tone": "warning"}],
    }


def test_pdf_job_binds_layout_and_output(tmp_path):
    payload = json.dumps(document()).encode()
    pdf, result = tmp_path / "report.pdf", tmp_path / "result.json"
    assert run_pdf_cli(io.BytesIO(payload), pdf_path=pdf, result_path=result) == 0
    receipt = json.loads(result.read_bytes())
    assert receipt["documentDigest"] == hashlib.sha256(payload).hexdigest()
    assert receipt["pdfSha256"] == hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert receipt["bytes"] == len(pdf.read_bytes())
    assert pdf.read_bytes().startswith(b"%PDF-")
    assert run_pdf_cli(io.BytesIO(payload), pdf_path=pdf, result_path=result) == 2


def test_pdf_job_rejects_unknown_fields_and_oversize_without_outputs(tmp_path):
    value = document()
    value["sourcePath"] = "/tmp/untrusted.py"
    for payload in [json.dumps(value).encode(), b" " * (512 * 1024 + 1)]:
        assert (
            run_pdf_cli(
                io.BytesIO(payload),
                pdf_path=tmp_path / "report.pdf",
                result_path=tmp_path / "result.json",
            )
            == 2
        )
        assert not Path(tmp_path / "report.pdf").exists()
        assert not Path(tmp_path / "result.json").exists()
