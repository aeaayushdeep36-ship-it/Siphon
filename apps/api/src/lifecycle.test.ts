import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { transition, RevisionState } from './lifecycle.js';

const draft = (): RevisionState => ({
  schemaVersion: '1.0',
  auditId: randomUUID(),
  revisionId: randomUUID(),
  stage: 'draft',
  status: 'idle',
  generation: 0,
  inputDigest: 'b'.repeat(64),
  cancellationRequestedAt: null,
});

describe('revision transitions', () => {
  it('rejects inconsistent persisted stage/status combinations', () => {
    expect(
      RevisionState.safeParse({
        ...draft(),
        stage: 'finished',
        status: 'running',
      }).success,
    ).toBe(false);
    expect(
      RevisionState.safeParse({
        ...draft(),
        stage: 'finished',
        status: 'cancelled',
      }).success,
    ).toBe(false);
    expect(
      RevisionState.safeParse({
        ...draft(),
        stage: 'executing',
        status: 'waiting_for_input',
      }).success,
    ).toBe(false);
  });
  it('queues, starts and releases into a human-input state without a terminal failure', () => {
    let state = draft();
    state = transition(state, state, { kind: 'queue' });
    state = transition(state, state, { kind: 'start' });
    state = transition(state, state, {
      kind: 'wait',
      reason: 'Unresolved coordinate frame',
    });
    expect(state).toMatchObject({
      stage: 'clarifying',
      status: 'waiting_for_input',
      generation: 3,
    });
  });
  it('rejects stale completion and stage skipping', () => {
    const original = draft();
    const queued = transition(original, original, { kind: 'queue' });
    expect(() => transition(queued, original, { kind: 'start' })).toThrow(
      'Stale',
    );
    const running = transition(queued, queued, { kind: 'start' });
    expect(() =>
      transition(running, running, {
        kind: 'advance',
        stage: 'evaluating',
        reason: 'Skip',
      }),
    ).toThrow();
  });
  it('does not label a report with missing required PDF complete', () => {
    const state: RevisionState = {
      ...draft(),
      stage: 'reporting',
      status: 'running',
    };
    const event = {
      kind: 'finish',
      status: 'completed',
      hasEvidence: true,
      narrativeComplete: true,
      pdfComplete: false,
    } as const;
    expect(() => transition(state, state, event)).toThrow('missing');
    expect(
      transition(state, state, { ...event, status: 'partial' }).status,
    ).toBe('partial');
  });
  it('fences late results after cancellation and distinguishes request from provider termination', () => {
    const state = draft();
    const cancelled = transition(state, state, {
      kind: 'cancel',
      requestedAt: '2026-10-28T09:00:00Z',
    });
    expect(cancelled.cancellationRequestedAt).not.toBeNull();
    expect(() => transition(cancelled, cancelled, { kind: 'queue' })).toThrow(
      'terminal',
    );
  });
  it('cannot discard useful evidence through failed or claim partial without evidence', () => {
    const state: RevisionState = {
      ...draft(),
      stage: 'executing',
      status: 'running',
    };
    const event = {
      kind: 'finish',
      status: 'failed',
      hasEvidence: true,
      narrativeComplete: false,
      pdfComplete: false,
    } as const;
    expect(() => transition(state, state, event)).toThrow('preserved');
    expect(() =>
      transition(state, state, {
        ...event,
        status: 'partial',
        hasEvidence: false,
      }),
    ).toThrow();
  });
});
