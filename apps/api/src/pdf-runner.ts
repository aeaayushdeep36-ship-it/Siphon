import { type Sandbox } from 'e2b';
import { z } from 'zod';
import { Count, Digest, Id, PdfRenderDocument } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import { readJsonBounded } from './http.js';
import { verifyUploadBytes } from './upload-bytes.js';

export const PDF_COMMAND =
  '/opt/siphon/venv/bin/python -I -m siphon_science.pdf_job < /tmp/siphon-pdf-document.json > /dev/null 2>&1';
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const PdfReceipt = z.strictObject({
  schemaVersion: z.literal('1.0'),
  reportId: Id,
  reportDigest: Digest,
  documentDigest: Digest,
  pdfSha256: Digest,
  bytes: Count.refine((n) => n > 0 && n <= MAX_PDF_BYTES),
});
export interface PdfSession {
  readonly sandboxId: string;
  writeDocument(
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void>;
  run(signal: AbortSignal): Promise<number>;
  readResult(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  readPdf(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
export class E2bPdfSession implements PdfSession {
  constructor(private readonly sandbox: Sandbox) {}
  get sandboxId() {
    return this.sandbox.sandboxId;
  }
  async writeDocument(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
    await this.sandbox.files.write(
      '/tmp/siphon-pdf-document.json',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      { signal, requestTimeoutMs: 30000 },
    );
  }
  async run(signal: AbortSignal) {
    return (
      await this.sandbox.commands.run(PDF_COMMAND, {
        signal,
        requestTimeoutMs: 30000,
        timeoutMs: 120000,
        retainOutput: false,
        cwd: '/tmp',
        envs: {},
      })
    ).exitCode;
  }
  readResult(signal: AbortSignal) {
    return this.sandbox.files.read('/tmp/siphon-pdf-result.json', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
  readPdf(signal: AbortSignal) {
    return this.sandbox.files.read('/tmp/siphon-report.pdf', {
      format: 'stream',
      signal,
      requestTimeoutMs: 30000,
    });
  }
}
export interface PdfExecutionGate {
  /** Must bind immutable published report/layout, current fence, fresh PDF-role VM
   * and reserved output/storage/compute. No permissive default implementation. */
  claim(
    document: PdfRenderDocument,
    documentDigest: string,
    sandboxId: string,
  ): Promise<void>;
  authorizeResult(): Promise<void>;
}
export class PdfRunner {
  constructor(
    private readonly session: PdfSession,
    private readonly gate: PdfExecutionGate,
  ) {}
  async run(value: unknown, signal?: AbortSignal) {
    const document = PdfRenderDocument.parse(value);
    const body = new Uint8Array(
      new TextEncoder().encode(canonicalJson(document)),
    );
    const documentDigest = await sha256(canonicalJson(document));
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(180000)])
      : AbortSignal.timeout(180000);
    deadline.throwIfAborted();
    await this.gate.claim(document, documentDigest, this.session.sandboxId);
    try {
      await this.gate.authorizeResult();
      await this.session.writeDocument(body, deadline);
      await this.gate.authorizeResult();
      if ((await this.session.run(deadline)) !== 0)
        throw new Error('PDF job failed');
      await this.gate.authorizeResult();
      const receipt = PdfReceipt.parse(
        await readJsonBounded(
          new Response(await this.session.readResult(deadline)),
          4096,
          deadline,
        ),
      );
      if (
        receipt.reportId !== document.reportId ||
        receipt.reportDigest !== document.reportDigest ||
        receipt.documentDigest !== documentDigest
      )
        throw new Error('PDF receipt mismatch');
      await this.gate.authorizeResult();
      const { bytes } = await verifyUploadBytes(
        await this.session.readPdf(deadline),
        receipt.bytes,
        receipt.pdfSha256,
        MAX_PDF_BYTES,
        deadline,
      );
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
        throw new Error('Invalid PDF signature');
      await this.gate.authorizeResult();
      deadline.throwIfAborted();
      return { receipt, bytes };
    } catch {
      throw new Error('trusted_pdf_render_failed');
    }
  }
}
