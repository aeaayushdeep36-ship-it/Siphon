import { describe, expect, it, vi } from 'vitest';
import { buildPdfDocument } from './report-layout.js';
import { authoredReport } from '../test/report-fixture.js';
import { canonicalJson, sha256 } from './hashing.js';
import { PdfRunner } from './pdf-runner.js';

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
async function setup() {
  const document = await buildPdfDocument(authoredReport());
  const bytes = new TextEncoder().encode('%PDF-authored transport fixture');
  const receipt = {
    schemaVersion: '1.0',
    reportId: document.reportId,
    reportDigest: document.reportDigest,
    documentDigest: await sha256(canonicalJson(document)),
    pdfSha256: await sha256(new TextDecoder().decode(bytes)),
    bytes: bytes.length,
  };
  const session = {
    sandboxId: 'pdf_fresh',
    writeDocument: vi.fn<
      (bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<void>
    >(async () => {}),
    run: vi.fn(async () => 0),
    readResult: vi.fn(async () =>
      stream(new TextEncoder().encode(JSON.stringify(receipt))),
    ),
    readPdf: vi.fn(async () => stream(bytes)),
  };
  const gate = {
    claim: vi.fn(async () => {}),
    authorizeResult: vi.fn(async () => {}),
  };
  return {
    document,
    receipt,
    bytes,
    session,
    gate,
    runner: new PdfRunner(session, gate),
  };
}
describe('bounded data-only PDF transport', () => {
  it('binds canonical layout, rechecks authorization and verifies collected bytes', async () => {
    const f = await setup();
    expect((await f.runner.run(f.document)).bytes).toEqual(f.bytes);
    expect(f.gate.claim).toHaveBeenCalledWith(
      f.document,
      f.receipt.documentDigest,
      'pdf_fresh',
    );
    expect(f.session.writeDocument.mock.calls[0]?.[0]).toEqual(
      new TextEncoder().encode(canonicalJson(f.document)),
    );
    expect(f.gate.authorizeResult).toHaveBeenCalledTimes(5);
  });
  it('rejects a receipt for another report without reading its PDF', async () => {
    const f = await setup();
    f.receipt.reportDigest = 'f'.repeat(64);
    await expect(f.runner.run(f.document)).rejects.toThrow(
      'trusted_pdf_render_failed',
    );
    expect(f.session.readPdf).not.toHaveBeenCalled();
  });
  it('rejects corrupt or oversized bytes and revocation before command dispatch', async () => {
    const f = await setup();
    f.session.readPdf.mockImplementation(async () =>
      stream(new TextEncoder().encode('%PDF-corrupt')),
    );
    await expect(f.runner.run(f.document)).rejects.toThrow(
      'trusted_pdf_render_failed',
    );
    const revoked = await setup();
    revoked.gate.authorizeResult.mockRejectedValueOnce(new Error('cancelled'));
    await expect(revoked.runner.run(revoked.document)).rejects.toThrow(
      'trusted_pdf_render_failed',
    );
    expect(revoked.session.run).not.toHaveBeenCalled();
  });
});
