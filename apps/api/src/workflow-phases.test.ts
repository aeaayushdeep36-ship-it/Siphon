import { describe, expect, it, vi } from 'vitest';
import {
  dispatchWorkflowPhase,
  InspectionPhasePayload,
  isInspectionWorkflowPhase,
  isScientificWorkflowPhase,
  WorkflowDispatchError,
} from './workflow-phases.js';

const phase = {
  schemaVersion: '1.0' as const,
  jobId: 'a'.repeat(64),
  phase: 'investigation_dispatch' as const,
  phaseKey: '11111111-1111-4111-8111-111111111111',
  operationId: '11111111-1111-4111-8111-111111111111',
  fence: {
    auditId: '22222222-2222-4222-8222-222222222222',
    revisionId: '33333333-3333-4333-8333-333333333333',
    inputDigest: 'b'.repeat(64),
    generation: 4,
  },
};

function binding(status: unknown = { status: 'queued' }) {
  return {
    create: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ status: vi.fn(async () => status) })),
  };
}

describe('bounded Workflow phase messages', () => {
  it.each([
    'inspection_begin',
    'inspection_reserve',
    'inspection_create',
    'inspection_execute',
    'inspection_cleanup',
    'inspection_finish',
  ] as const)(
    'routes the %s child to the inspection phase handler',
    (phase) => {
      expect(isInspectionWorkflowPhase(phase)).toBe(true);
    },
  );

  it.each([
    'scientific_evaluate',
    'scientific_investigate',
    'investigation_prepare',
    'investigation_dispatch',
    'report',
    'pdf',
    'finish',
  ] as const)(
    'routes the %s child to the scientific phase handler',
    (phase) => {
      expect(isScientificWorkflowPhase(phase)).toBe(true);
    },
  );

  it('accepts only bounded identity and fencing metadata', () => {
    expect(InspectionPhasePayload.parse(phase)).toEqual(phase);
    expect(() =>
      InspectionPhasePayload.parse({ ...phase, sourceText: 'private source' }),
    ).toThrow();
    expect(() =>
      InspectionPhasePayload.parse({ ...phase, requestBody: { messages: [] } }),
    ).toThrow();
  });

  it('uses a stable deterministic ID and does not status-check a successful create', async () => {
    const instance = binding();
    const first = await dispatchWorkflowPhase(instance, phase.jobId, phase);
    const replay = await dispatchWorkflowPhase(instance, phase.jobId, phase);
    expect(first.id).toBe(replay.id);
    expect(first.id).toMatch(/^phase-[a-f0-9]{64}$/);
    expect(first.reconciled).toBe(false);
    expect(replay.reconciled).toBe(false);
    expect(instance.create).toHaveBeenCalledTimes(2);
    expect(instance.get).not.toHaveBeenCalled();
  });

  it('separates an explicit scientific resume attempt from a completed child', async () => {
    const instance = binding();
    const first = await dispatchWorkflowPhase(instance, phase.jobId, {
      ...phase,
      phase: 'scientific_evaluate',
      phaseKey: 'c'.repeat(64),
    });
    const retry = await dispatchWorkflowPhase(instance, phase.jobId, {
      ...phase,
      phase: 'scientific_evaluate',
      phaseKey: 'd'.repeat(64),
    });
    expect(first.id).not.toBe(retry.id);
    expect(first.id).toMatch(/^phase-[a-f0-9]{64}$/);
    expect(retry.id).toMatch(/^phase-[a-f0-9]{64}$/);
    expect(instance.create).toHaveBeenCalledTimes(2);
  });

  it('treats an immediate queued status as accepted, not completed', async () => {
    const instance = binding({ status: 'queued' });
    instance.create.mockRejectedValue(new Error('duplicate ID'));
    const result = await dispatchWorkflowPhase(instance, phase.jobId, phase);
    expect(result.reconciled).toBe(true);
    expect(instance.get).toHaveBeenCalledWith(result.id);
  });

  it('accepts a completed child and rejects failed or unrecognizable children', async () => {
    const complete = binding({ status: 'complete' });
    complete.create.mockRejectedValue(new Error('duplicate ID'));
    await expect(
      dispatchWorkflowPhase(complete, phase.jobId, phase),
    ).resolves.toMatchObject({ reconciled: true });

    const failed = binding({ status: 'errored' });
    failed.create.mockRejectedValue(new Error('duplicate ID'));
    await expect(
      dispatchWorkflowPhase(failed, phase.jobId, phase),
    ).rejects.toMatchObject<Partial<WorkflowDispatchError>>({
      code: 'stopped',
    });

    const unknown = binding({ status: 'new_status' });
    unknown.create.mockRejectedValue(new Error('duplicate ID'));
    await expect(
      dispatchWorkflowPhase(unknown, phase.jobId, phase),
    ).rejects.toMatchObject<Partial<WorkflowDispatchError>>({
      code: 'unknown',
    });
  });

  it('reports an unknown result when status cannot be read', async () => {
    const instance = binding();
    instance.create.mockRejectedValue(new Error('ambiguous create'));
    instance.get.mockRejectedValue(new Error('status unavailable'));
    await expect(
      dispatchWorkflowPhase(instance, phase.jobId, phase),
    ).rejects.toMatchObject<Partial<WorkflowDispatchError>>({
      code: 'unknown',
    });
  });
});
