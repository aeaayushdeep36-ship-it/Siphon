// @vitest-environment jsdom
/// <reference types="node" />
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, resumeNeedsAiDisclosure } from './App.js';
import type {
  InvestigationReviewSnapshot,
  UploadEntry,
} from '@siphon/contracts';
import { authoredReport } from '../../api/test/report-fixture.js';

const session = vi.hoisted(() => ({
  notify: (value: unknown): void => {
    void value;
  },
  user: { displayName: 'Authored tester', getIdToken: async () => 'fixture' },
}));
vi.mock('./auth.js', () => ({
  auth: {},
  signIn: vi.fn(),
  signInErrorMessage: () => 'Authored authentication failure',
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, notify: (user: unknown) => void) => {
    session.notify = notify;
    notify(session.user);
    return () => {};
  },
  signOut: async () => session.notify(null),
}));

const auditId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const oldRevisionId = '33333333-3333-4333-8333-333333333333';
const questionId = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64);
const now = '2026-11-11T12:00:00.000Z';
const metricEvidence = {
  ...authoredReport().metrics[0]!,
  id: oldRevisionId,
  auditId,
  revisionId,
  inputDigest: digest,
};
const audit = {
  schemaVersion: '1.0',
  id: auditId,
  ownerUid: 'authored-user',
  title: 'Authored audit',
  domain: 'heat_diffusion',
  currentRevisionId: revisionId,
  createdAt: now,
  updatedAt: now,
  deletionRequestedAt: null,
};
const base = `/audits/${auditId}/revisions/${revisionId}`;
const acceptedDisclosure = {
  configuration: {
    provider: 'groq',
    model: 'authored-model',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    noticeVersion: 'groq_audit_disclosure.v1',
    scopes: ['source_context', 'source_adapter', 'numeric_investigation'],
  },
  disclosureDigest: 'd'.repeat(64),
  status: 'accepted',
  acceptedAt: now,
} as const;
const workspace = {
  schemaVersion: '1.0',
  auditId,
  revisionId,
  generation: 0,
  inputDigest: digest,
  aiDisclosure: acceptedDisclosure,
  stage: 'draft',
  status: 'idle',
  uploads: [],
  uploadStates: [],
  readiness: null,
  context: null,
  plan: null,
};
const progress = {
  schemaVersion: '1.0',
  auditId,
  revisionId,
  generation: 0,
  stage: 'draft',
  status: 'idle',
  updatedAt: now,
  progress: null,
  isCurrentRevision: true,
  pollAfterSeconds: 5,
};
const investigation: InvestigationReviewSnapshot = {
  provider: 'groq',
  model: 'authored-model',
  operationId: questionId,
  draftDigest: 'b'.repeat(64),
  evidence: [metricEvidence],
  status: 'awaiting_review',
  expiresAt: '2026-11-18T12:00:00Z',
  draft: {
    schemaVersion: '1.0',
    auditId,
    revisionId,
    inputDigest: digest,
    evidenceDigest: 'c'.repeat(64),
    hypotheses: [
      {
        text: 'A possible sampling effect.',
        evidenceIds: [oldRevisionId],
        verification: 'Compare the recorded samples.',
      },
    ],
    recommendations: [
      {
        text: 'Inspect output sampling.',
        evidenceIds: [oldRevisionId],
        validation: 'Verify with independent observations.',
      },
    ],
  },
};
let root: Root;
let host: HTMLDivElement;
let requests: { path: string; method: string; body: unknown }[];
let respond: (path: string, init: RequestInit) => Response | Promise<Response>;

function defaults(path: string): Response {
  if (path === '/audits?limit=20')
    return Response.json({
      schemaVersion: '1.0',
      audits: [audit],
      nextCursor: null,
    });
  if (path === `/audits/${audit.id}`)
    return Response.json({
      schemaVersion: '1.0',
      audit,
    });
  if (path.includes('/revisions?'))
    return Response.json({
      schemaVersion: '1.0',
      revisions: [revisionId, oldRevisionId].map((id) => ({
        revisionId: id,
        stage: 'draft',
        status: 'idle',
        createdAt: now,
        reportId: null,
      })),
      nextCursor: null,
    });
  if (path === `${base}/workspace`) return Response.json(workspace);
  if (path === `${base}/progress`) return Response.json(progress);
  throw new Error(`Unexpected authored route: ${path}`);
}
function button(text: string) {
  const element = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function input(id: string, value: string) {
  await act(async () => {
    const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `#${id}`,
    )!;
    const prototype =
      element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount() {
  await act(async () => root.render(<App />));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  requests = [];
  respond = (path) => defaults(path);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('/api/v1', '');
      requests.push({
        path,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      });
      return respond(path, init);
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('authored frontend journey through real browser API contracts', () => {
  it('provides a keyboard skip link that targets the main landmark', async () => {
    await mount();
    const skipLink = host.querySelector<HTMLAnchorElement>('.skip-link');
    const main = host.querySelector<HTMLElement>('#main');

    expect(skipLink?.textContent).toBe('Skip to main content');
    expect(skipLink?.getAttribute('href')).toBe('#main');
    expect(main?.tabIndex).toBe(-1);
    expect(host.querySelector('.app-shell')?.firstElementChild).toBe(skipLink);
  });

  it('requires consent only when a continuation can dispatch new AI work', () => {
    expect(
      resumeNeedsAiDisclosure({ stage: 'investigating', investigation: null }),
    ).toBe(true);
    expect(
      resumeNeedsAiDisclosure({
        stage: 'investigating',
        investigation,
      }),
    ).toBe(false);
    expect(
      resumeNeedsAiDisclosure({ stage: 'reporting', investigation: null }),
    ).toBe(false);
  });

  it.each(['heat_diffusion', 'orbital_dynamics'])(
    'creates an audit with explicit %s selection',
    async (domain) => {
      respond = (path, init) =>
        path === '/audits' && init.method === 'POST'
          ? Response.json({ schemaVersion: '1.0', audit: { ...audit, domain } })
          : defaults(path);
      await mount();
      await input('audit-title', 'My simulation');
      // The radio controls have separate labels, so choose by their declared order.
      await act(async () => {
        const radios = host.querySelectorAll<HTMLInputElement>(
          'input[name="domain"]',
        );
        radios.item(domain === 'heat_diffusion' ? 0 : 1).click();
      });
      await click('Create private audit');
      expect(requests.find((item) => item.method === 'POST')?.body).toEqual({
        schemaVersion: '1.0',
        title: 'My simulation',
        domain,
      });
      expect(host.textContent).toContain('Source and supporting data');
      expect(host.querySelector('#files')?.hasAttribute('disabled')).toBe(
        false,
      );
    },
  );

  it('recovers failed initial progress reads without dispatching any work', async () => {
    vi.useFakeTimers();
    let reads = 0;
    respond = (path) =>
      path === `${base}/progress` && ++reads === 1
        ? Response.json(
            {
              error: {
                code: 'storage_unavailable',
                message: 'Storage is temporarily unavailable.',
              },
            },
            { status: 503 },
          )
        : defaults(path);
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    expect(host.textContent).toContain('Saved state could not be refreshed');
    expect(host.textContent).toContain(
      'Saved activity is temporarily unavailable.',
    );
    expect(host.textContent).not.toContain(
      'No activity message has been recorded.',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(host.textContent).not.toContain(
      'Saved state could not be refreshed',
    );
    expect(host.textContent).toContain('draft · idle');
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('keeps work disabled while saved workspace and progress reads stay unavailable', async () => {
    vi.useFakeTimers();
    respond = (path) =>
      path === `${base}/workspace` || path === `${base}/progress`
        ? Response.json(
            {
              error: {
                code: 'storage_unavailable',
                message: 'Storage is temporarily unavailable.',
              },
            },
            { status: 503 },
          )
        : defaults(path);
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    expect(host.textContent).toContain('Saved state could not be refreshed');
    expect(host.textContent).toContain('storage_unavailable');
    expect(host.textContent).toContain('Saved progress unavailable');
    expect(host.textContent).toContain(
      'Saved activity is temporarily unavailable.',
    );
    expect(button('Start readiness and audit').disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('#files')?.disabled).toBe(true);
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('displays a retryable recovery path during storage_unavailable and preserves user draft state', async () => {
    let unavailable = true;
    respond = (path) => {
      if (
        unavailable &&
        (path === `${base}/workspace` || path === `${base}/progress`)
      ) {
        return Response.json(
          {
            error: {
              code: 'storage_unavailable',
              message: 'Storage is temporarily unavailable.',
            },
          },
          { status: 503 },
        );
      }
      return defaults(path);
    };

    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );

    expect(host.textContent).toContain('Saved state could not be refreshed');
    expect(host.textContent).toContain('storage_unavailable');
    expect(host.textContent).toContain('Use Refresh audit to check now');
    expect(host.textContent).toContain(audit.title);
    expect(host.textContent).toContain(`Revision ${audit.currentRevisionId}`);

    const refreshButton = button('Refresh audit');
    expect(refreshButton).not.toBeNull();
    expect(refreshButton.disabled).toBe(false);

    unavailable = false;
    await act(async () => refreshButton.click());

    expect(host.textContent).not.toContain(
      'Saved state could not be refreshed',
    );
    expect(host.textContent).toContain('draft · idle');
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('keeps loaded progress distinct from a failed workspace read', async () => {
    respond = (path) =>
      path === `${base}/workspace`
        ? Response.json(
            {
              error: {
                code: 'unavailable',
                message: 'Saved workspace unavailable.',
              },
            },
            { status: 503 },
          )
        : defaults(path);
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    expect(host.textContent).toContain('Saved state could not be refreshed');
    expect(host.textContent).toContain('draft · idle');
    expect(host.textContent).toContain(
      'No activity message has been recorded.',
    );
    expect(host.textContent).not.toContain(
      'Saved activity is temporarily unavailable.',
    );
  });

  it('shows a historical revision without enabling new work or repeatedly polling it', async () => {
    vi.useFakeTimers();
    respond = (path) => {
      if (path === `/audits/${auditId}/revisions/${oldRevisionId}/workspace`)
        return Response.json({ ...workspace, revisionId: oldRevisionId });
      if (path === `/audits/${auditId}/revisions/${oldRevisionId}/progress`)
        return Response.json({
          ...progress,
          revisionId: oldRevisionId,
          isCurrentRevision: false,
          pollAfterSeconds: null,
        });
      return defaults(path);
    };
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    await click(`${oldRevisionId} · draft · idle`);
    expect(host.textContent).toContain('This revision is historical.');
    expect(button('Start readiness and audit').disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('#files')!.disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const count = requests.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(requests).toHaveLength(count);
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('preserves an unknown option and custom text when saving answers to a successor', async () => {
    respond = (path, init) => {
      if (path === `${base}/workspace`)
        return Response.json({
          ...workspace,
          stage: 'clarifying',
          status: 'waiting_for_input',
        });
      if (path === `${base}/progress`)
        return Response.json({
          ...progress,
          stage: 'clarifying',
          status: 'waiting_for_input',
        });
      if (path === `${base}/questions`)
        return Response.json({
          questionSetDigest: digest,
          questionSet: {
            schemaVersion: '1.0',
            auditId,
            revisionId,
            inputDigest: digest,
            questions: [
              {
                schemaVersion: '1.0',
                id: questionId,
                key: 'units',
                prompt: 'What units apply?',
                reason: 'Units cannot be guessed.',
                options: [
                  { id: 'si', label: 'SI units', unknown: false },
                  { id: 'unknown', label: 'Unknown units', unknown: true },
                ],
                customTextAllowed: true,
                requiredFacts: ['units'],
                affectedChecks: ['H_ENERGY'],
              },
            ],
          },
        });
      if (path === `${base}/answers` && init.method === 'POST')
        return Response.json({
          schemaVersion: '1.0',
          auditId,
          revisionId: oldRevisionId,
          parentRevisionId: revisionId,
          inputDigest: digest,
          stage: 'draft',
          status: 'idle',
        });
      if (path === `/audits/${auditId}/revisions/${oldRevisionId}/workspace`)
        return Response.json({ ...workspace, revisionId: oldRevisionId });
      if (path === `/audits/${auditId}/revisions/${oldRevisionId}/progress`)
        return Response.json({ ...progress, revisionId: oldRevisionId });
      return defaults(path);
    };
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    await act(async () =>
      host
        .querySelectorAll<HTMLInputElement>(`input[name="${questionId}"]`)[1]!
        .click(),
    );
    await input(`custom-${questionId}`, 'Please keep the units unresolved.');
    await click('Save answers as successor revision');
    expect(host.textContent).toContain(
      'Answers saved in a successor revision.',
    );
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(
      requests.find((item) => item.path.endsWith('/answers'))?.body,
    ).toMatchObject({
      answers: [
        {
          selectedOptionId: 'unknown',
          customText: 'Please keep the units unresolved.',
        },
      ],
    });
  });

  it('discards late private history after sign-out', async () => {
    let finish!: (response: Response) => void;
    respond = () => new Promise((resolve) => (finish = resolve));
    await mount();
    await click('Sign out');
    await act(async () =>
      finish(
        Response.json({
          schemaVersion: '1.0',
          audits: [audit],
          nextCursor: null,
        }),
      ),
    );
    expect(host.textContent).not.toContain('Authored audit');
    expect(host.textContent).not.toContain('Private history');
    expect(host.textContent).toContain('Sign in to view audit history');
  });

  it.each(['accept', 'omit'] as const)(
    'saves owner investigation decision %s against the displayed draft without dispatching report work',
    async (decision) => {
      let status: InvestigationReviewSnapshot['status'] = 'awaiting_review';
      respond = (path, init) => {
        if (path === `${base}/workspace`)
          return Response.json({
            ...workspace,
            stage: 'investigating',
            status: 'running',
            investigation: { ...investigation, status },
          });
        if (path === `${base}/progress`)
          return Response.json({
            ...progress,
            stage: 'investigating',
            status: 'running',
          });
        if (path === `${base}/investigation-review` && init.method === 'POST') {
          status = decision === 'accept' ? 'accepted' : 'omitted';
          return Response.json({
            schemaVersion: '1.0',
            operationId: investigation.operationId,
            draftDigest: investigation.draftDigest,
            status,
            replayed: false,
          });
        }
        return defaults(path);
      };
      await mount();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('.history-item')!.click(),
      );
      expect(host.textContent).toContain('A possible sampling effect.');
      expect(host.textContent).toContain(
        'Verify with independent observations.',
      );
      expect(host.textContent).toContain('not established findings');
      expect(host.textContent).toContain(
        'Deterministic evidence behind this advisory',
      );
      expect(host.textContent).toContain('energy drift: 0.5 J');
      expect(host.textContent).toContain(
        'Target: 1 J — Authored policy fixture only.',
      );
      expect(host.textContent).toContain(
        'Uncertainty: 0 J — Authored policy fixture only.',
      );
      expect(host.textContent).toContain('Interval: [0.5, 0.5] J');
      expect(host.textContent).toContain('passed within tolerance');
      expect(host.textContent).not.toContain('score');
      await click(
        decision === 'accept' ? 'Include advisory text' : 'Omit advisory text',
      );
      const mutations = requests.filter((item) => item.method !== 'GET');
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toMatchObject({
        path: `${base}/investigation-review`,
        body: {
          schemaVersion: '1.0',
          expectedGeneration: 0,
          expectedInputDigest: digest,
          draftDigest: investigation.draftDigest,
          decision,
        },
      });
      expect(host.textContent).toContain(
        `Advisory text ${status}. Numerical verdicts are unchanged.`,
      );
      expect(host.querySelector('[role="alert"]')).toBeNull();
      expect(
        [...host.querySelectorAll('button')].some(
          (item) => item.textContent === 'Include advisory text',
        ),
      ).toBe(false);
    },
  );

  it.each(['expired', 'historical', 'changed_revision'] as const)(
    'prevents advisory review for %s evidence',
    async (condition) => {
      respond = (path) => {
        if (path === `${base}/workspace`)
          return Response.json({
            ...workspace,
            stage: 'investigating',
            status: 'running',
            investigation: {
              ...investigation,
              status: condition === 'expired' ? 'expired' : 'awaiting_review',
              draft: {
                ...investigation.draft,
                revisionId:
                  condition === 'changed_revision' ? oldRevisionId : revisionId,
              },
            },
          });
        if (path === `${base}/progress`)
          return Response.json({
            ...progress,
            stage: 'investigating',
            status: 'running',
            isCurrentRevision: condition !== 'historical',
            pollAfterSeconds: condition === 'historical' ? null : 5,
          });
        return defaults(path);
      };
      await mount();
      await act(async () =>
        host.querySelector<HTMLButtonElement>('.history-item')!.click(),
      );
      const include = [...host.querySelectorAll('button')].find(
        (item) => item.textContent === 'Include advisory text',
      );
      expect(!include || include.disabled).toBe(true);
      if (condition === 'expired')
        expect(host.textContent).toContain('This draft has expired');
      if (condition === 'changed_revision')
        expect(host.textContent).toContain(
          'Saved state could not be refreshed',
        );
      expect(requests.every((item) => item.method === 'GET')).toBe(true);
    },
  );

  it('distinguishes failed report reads from an unpublished report and retries without dispatch', async () => {
    let reportReads = 0;
    respond = (path) => {
      if (path === `${base}/workspace`)
        return Response.json({
          ...workspace,
          stage: 'finished',
          status: 'partial',
        });
      if (path === `${base}/progress`)
        return Response.json({
          ...progress,
          stage: 'finished',
          status: 'partial',
          pollAfterSeconds: null,
        });
      if (path === `${base}/report`)
        return ++reportReads === 1
          ? Response.json(
              {
                error: {
                  code: 'unavailable',
                  message: 'Report read unavailable.',
                },
              },
              { status: 503 },
            )
          : Response.json(
              {
                error: { code: 'report_not_ready', message: 'No report yet.' },
              },
              { status: 404 },
            );
      return defaults(path);
    };
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    expect(host.textContent).toContain('Report could not be refreshed');
    expect(host.textContent).not.toContain(
      'No structured report has been published',
    );
    await click('Retry report read');
    expect(host.textContent).not.toContain('Report could not be refreshed');
    expect(host.textContent).toContain(
      'No structured report has been published',
    );
    expect(reportReads).toBe(2);
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
  });

  it('uploads source and supporting data with verified metadata and preserved relative paths', async () => {
    const uploads: UploadEntry[] = [];
    const ready = new Set<string>();
    respond = (path, init) => {
      if (path === `${base}/workspace`)
        return Response.json({
          ...workspace,
          uploads,
          uploadStates: uploads.map((item) => ({
            artifactId: item.artifactId,
            lifecycle: ready.has(item.artifactId) ? 'ready' : 'reserved',
            expiresAt: now,
          })),
        });
      if (path === `${base}/artifacts` && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        const entry = {
          schemaVersion: '1.0' as const,
          artifactId: crypto.randomUUID(),
          path: body.path,
          bytes: body.bytes,
          sha256: body.sha256,
        };
        uploads.push(entry);
        return Response.json({
          ...entry,
          auditId,
          revisionId,
          generation: 0,
          inputDigest: digest,
          lifecycle: 'reserved',
          uploadExpiresAt: now,
          expiresAt: now,
        });
      }
      if (path.endsWith('/content') && init.method === 'PUT') {
        const entry = uploads.find((item) => path.includes(item.artifactId))!;
        expect(new Headers(init.headers).get('X-Content-SHA256')).toBe(
          entry.sha256,
        );
        expect((init.body as ArrayBuffer).byteLength).toBe(entry.bytes);
        ready.add(entry.artifactId);
        return new Response(null, { status: 204 });
      }
      return defaults(path);
    };
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    const files = [
      ['simulation.py', 'print("authored upload only")\n'],
      ['data.csv', '1,2\n3,4\n'],
    ].map(([name, text]) => {
      const file = new File([text!], name!);
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new TextEncoder().encode(text!).buffer,
      });
      return file;
    });
    await act(async () => {
      const picker = host.querySelector<HTMLInputElement>('#files')!;
      Object.defineProperty(picker, 'files', { value: files });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await input('upload-path-1', 'inputs/data.csv');
    await click('Upload selected files');
    expect(uploads.map((item) => item.path)).toEqual([
      'simulation.py',
      'inputs/data.csv',
    ]);
    expect(ready.size).toBe(2);
    expect(host.textContent).toContain('Upload bytes stored.');
    expect(button('Start readiness and audit').disabled).toBe(false);
    expect(requests.some((item) => item.path.endsWith('/run'))).toBe(false);
  });

  it('requires and records explicit AI data sharing permission before starting an audit', async () => {
    const upload: UploadEntry = {
      schemaVersion: '1.0',
      artifactId: '55555555-5555-4555-8555-555555555555',
      path: 'simulation.py',
      bytes: 16,
      sha256: 'e'.repeat(64),
    };
    let status: 'required' | 'accepted' | 'revoked' = 'required';
    respond = (path, init) => {
      if (path === `${base}/workspace`)
        return Response.json({
          ...workspace,
          uploads: [upload],
          uploadStates: [
            {
              artifactId: upload.artifactId,
              lifecycle: 'ready',
              expiresAt: now,
            },
          ],
          aiDisclosure: {
            ...acceptedDisclosure,
            status,
            acceptedAt: status === 'accepted' ? now : null,
          },
        });
      if (path === `${base}/ai-disclosure` && init.method === 'POST') {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          schemaVersion: '1.0',
          expectedGeneration: 0,
          expectedInputDigest: digest,
          disclosureDigest: acceptedDisclosure.disclosureDigest,
          decision: status === 'accepted' ? 'revoke' : 'accept',
        });
        expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
        const decision = status === 'accepted' ? 'revoke' : 'accept';
        status = decision === 'accept' ? 'accepted' : 'revoked';
        return Response.json({
          schemaVersion: '1.0',
          auditId,
          revisionId,
          disclosureDigest: acceptedDisclosure.disclosureDigest,
          decision,
          replayed: false,
        });
      }
      return defaults(path);
    };
    await mount();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('.history-item')!.click(),
    );
    expect(button('Start readiness and audit').disabled).toBe(true);
    expect(button('Allow AI data sharing').disabled).toBe(true);
    await act(async () => {
      host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click();
    });
    expect(button('Allow AI data sharing').disabled).toBe(false);
    await click('Allow AI data sharing');
    expect(button('Start readiness and audit').disabled).toBe(false);
    expect(requests.some((item) => item.path.endsWith('/run'))).toBe(false);
    expect(host.textContent).toContain('permission is recorded');
    await click('Revoke permission');
    expect(button('Start readiness and audit').disabled).toBe(true);
    expect(host.textContent).toContain(
      'Permission revoked for future authorized AI dispatches.',
    );
    expect(requests.some((item) => item.path.endsWith('/run'))).toBe(false);
  });
});
