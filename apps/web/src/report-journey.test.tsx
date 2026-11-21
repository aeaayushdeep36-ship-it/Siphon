// @vitest-environment jsdom
/// <reference types="node" />
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import type { User } from 'firebase/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceReportResponse } from '@siphon/contracts';
import { authoredReport } from '../../api/test/report-fixture.js';
import { Report } from './Report.js';
import { AuditApi, digestBytes } from './api.js';

let host: HTMLDivElement;
let root: Root;
const user = { getIdToken: async () => 'fixture' } as User;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('authored report and PDF user journey', () => {
  it.each(['heat_diffusion', 'orbital_dynamics'] as const)(
    'shows exact %s evidence while keeping an unavailable PDF explicit',
    async (domain) => {
      const report = authoredReport(domain);
      const value = EvidenceReportResponse.parse({
        schemaVersion: '1.0',
        report,
        reportDigest: 'a'.repeat(64),
        pdf: { status: 'unavailable' },
        retention: {
          checkedAt: '2026-11-11T12:00:00Z',
          expiredEvidenceIds: [report.metrics[0]!.id],
          expiredArtifactIds: [],
        },
      });
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      await act(async () =>
        root.render(
          <Report value={value} api={new AuditApi(user)} onError={vi.fn()} />,
        ),
      );
      const metric = report.metrics[0]!;
      expect(host.textContent).toContain(
        `${metric.metric.value} ${metric.metric.unit}`,
      );
      expect(host.textContent).toContain(
        'Some evidence has expired. Reproduction is limited.',
      );
      expect(host.textContent).toContain('PDF: unavailable');
      expect(host.querySelector('button')!.disabled).toBe(true);
      expect(host.querySelectorAll('svg[aria-label]').length).toBe(
        report.plots.length,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'only downloads the published PDF after its bytes and hash agree (valid=%s)',
    async (valid) => {
      vi.useFakeTimers();
      const bytes = new TextEncoder().encode(
        '%PDF-1.7 authored download bytes only',
      );
      const report = authoredReport();
      const value = EvidenceReportResponse.parse({
        schemaVersion: '1.0',
        report,
        reportDigest: 'a'.repeat(64),
        pdf: {
          status: 'available',
          artifactId: crypto.randomUUID(),
          bytes: bytes.byteLength,
          sha256: valid ? await digestBytes(bytes.buffer) : 'f'.repeat(64),
          expiresAt: report.expiresAt,
        },
        retention: {
          checkedAt: '2026-11-11T12:00:00Z',
          expiredEvidenceIds: [],
          expiredArtifactIds: [],
        },
      });
      const blob = new Blob([bytes], { type: 'application/pdf' });
      Object.defineProperty(blob, 'arrayBuffer', {
        value: async () => bytes.buffer,
      });
      const fetch = vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'Content-Type': 'application/pdf' }),
        blob: async () => blob,
      }));
      vi.stubGlobal('fetch', fetch);
      const createObjectURL = vi.fn(() => 'blob:authored-pdf');
      const OriginalURL = URL;
      class TestURL extends OriginalURL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      }
      vi.stubGlobal('URL', TestURL);
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => {});
      const onError = vi.fn();
      await act(async () =>
        root.render(
          <Report value={value} api={new AuditApi(user)} onError={onError} />,
        ),
      );
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button')!.click(),
      );
      await act(async () => {
        await vi.waitFor(() => {
          expect(
            createObjectURL.mock.calls.length + onError.mock.calls.length,
          ).toBe(1);
        });
      });
      expect(fetch.mock.calls).toHaveLength(1);
      expect(createObjectURL).toHaveBeenCalledTimes(valid ? 1 : 0);
      expect(click).toHaveBeenCalledTimes(valid ? 1 : 0);
      if (valid) expect(onError).not.toHaveBeenCalled();
      else
        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'pdf_integrity' }),
        );
      expect(host.textContent).toContain(report.summary);
      expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(
        false,
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(TestURL.revokeObjectURL).toHaveBeenCalledTimes(valid ? 1 : 0);
      vi.useRealTimers();
    },
  );
});
