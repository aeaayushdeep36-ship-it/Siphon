import { describe, expect, it, vi } from 'vitest';
import type { Sandbox } from 'e2b';
import { E2bInspectionSession } from './inspection-runner.js';
import { E2bValidationSession } from './validation-runner.js';
import { E2bDiagnosticsSession } from './diagnostics-runner.js';
import { E2bConservationSession } from './conservation-runner.js';
import { E2bFidelitySession } from './fidelity-session.js';

describe('E2B staging directories', () => {
  it('creates each fresh sandbox directory before writing input', async () => {
    const makeDir = vi.fn().mockResolvedValue(true);
    const write = vi.fn().mockResolvedValue(undefined);
    const sandbox = { files: { makeDir, write } } as unknown as Sandbox;
    const signal = new AbortController().signal;
    const data = new Uint8Array([1]);
    await new E2bInspectionSession(sandbox).writeRequest(data, signal);
    await new E2bValidationSession(sandbox).writeObservation(
      'times',
      data,
      signal,
    );
    await new E2bDiagnosticsSession(sandbox).writeObservation(
      'times',
      data,
      signal,
    );
    await new E2bConservationSession(sandbox).writeObservation(
      'times',
      data,
      signal,
    );
    await new E2bFidelitySession(sandbox).writeObservation(
      'original',
      'times',
      data,
      signal,
    );
    await new E2bFidelitySession(sandbox).writeObservation(
      'adapted',
      'times',
      data,
      signal,
    );
    expect(makeDir.mock.calls.map(([path]) => path)).toEqual([
      '/tmp/siphon-inspection',
      '/tmp/siphon-validation-data',
      '/tmp/siphon-diagnostics-data',
      '/tmp/siphon-experiment-data',
      '/tmp/siphon-fidelity-original',
      '/tmp/siphon-fidelity-adapted',
    ]);
    expect(write).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 6; i++)
      expect(makeDir.mock.invocationCallOrder[i]).toBeLessThan(
        write.mock.invocationCallOrder[i]!,
      );
  });
});
