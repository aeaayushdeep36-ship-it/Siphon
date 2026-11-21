// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiDisclosurePanel,
  type AiDisclosureView,
} from './AiDisclosurePanel.js';

const disclosure: NonNullable<AiDisclosureView> = {
  configuration: {
    provider: 'groq',
    model: 'authored-model',
    endpoint: 'https://api.groq.example/v1',
    noticeVersion: 'groq_audit_disclosure.v1',
    scopes: ['source_context', 'source_adapter', 'numeric_investigation'],
  },
  disclosureDigest: 'a'.repeat(64),
  status: 'required',
  acceptedAt: null,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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

describe('AI disclosure panel', () => {
  it('requires an unchecked explicit decision and explains all configured scopes', async () => {
    const onDecision = vi.fn();
    await act(async () =>
      root.render(
        <AiDisclosurePanel
          disclosure={disclosure}
          disabled={false}
          onDecision={onDecision}
        />,
      ),
    );

    expect(host.textContent).toContain('groq');
    expect(host.textContent).toContain('authored-model');
    expect(host.textContent).toContain('https://api.groq.example/v1');
    expect(host.textContent).toContain('source text to describe');
    expect(host.textContent).toContain('source text to propose mappings');
    expect(host.textContent).toContain('validated numerical evidence');
    expect(host.textContent).toContain('cannot recall data already sent');

    const checkbox = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    const allow = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Allow AI data sharing',
    )!;
    expect(checkbox.checked).toBe(false);
    expect(allow.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(allow.disabled).toBe(false);
    await act(async () => allow.click());
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('accept');
  });

  it('offers revoke for accepted permission and explains its forward-only effect', async () => {
    const onDecision = vi.fn();
    await act(async () =>
      root.render(
        <AiDisclosurePanel
          disclosure={{
            ...disclosure,
            status: 'accepted',
            acceptedAt: '2026-11-11T12:00:00Z',
          }}
          disabled={false}
          onDecision={onDecision}
        />,
      ),
    );
    expect(host.textContent).toContain('Permission recorded');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button')!.click(),
    );
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('revoke');
    expect(host.textContent).toContain(
      'prevents future authorized AI dispatches',
    );
  });

  it('requires a fresh explicit opt-in after permission was revoked', async () => {
    const onDecision = vi.fn();
    await act(async () =>
      root.render(
        <AiDisclosurePanel
          disclosure={{
            ...disclosure,
            status: 'revoked',
            acceptedAt: '2026-11-11T12:00:00Z',
          }}
          disabled={false}
          onDecision={onDecision}
        />,
      ),
    );

    expect(host.textContent).toContain('Permission was revoked');
    const checkbox = host.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    const allow = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Allow AI data sharing',
    )!;
    expect(checkbox.checked).toBe(false);
    expect(allow.disabled).toBe(true);
    await act(async () => checkbox.click());
    await act(async () => allow.click());
    expect(onDecision).toHaveBeenCalledExactlyOnceWith('accept');
  });

  it('fails closed when no valid provider configuration is available', async () => {
    await act(async () =>
      root.render(
        <AiDisclosurePanel
          disclosure={null}
          disabled={false}
          onDecision={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain('No valid AI provider configuration');
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
  });
});
