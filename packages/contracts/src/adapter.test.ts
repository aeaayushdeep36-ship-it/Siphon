import { describe, expect, it } from 'vitest';
import { AdapterProposal } from './adapter.js';

function proposal() {
  return {
    schemaVersion: '1.0',
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    sourceArtifactId: crypto.randomUUID(),
    sourceDigest: 'c'.repeat(64),
    domain: 'heat_diffusion',
    handler: 'script_globals_v1',
    mappings: [
      {
        key: 'times',
        root: 'times',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
      {
        key: 'temperature',
        root: 'history',
        steps: [{ kind: 'key', key: 'values' }],
        expectedShape: [2, 3],
        axisOrder: [1, 0],
        declaredUnit: 'K',
      },
    ],
  };
}
describe('declarative adapter boundary', () => {
  it('rejects mismatched sample horizons and oversized heat grids before execution', () => {
    const p = proposal();
    p.mappings[1]!.expectedShape = [3, 3];
    expect(AdapterProposal.safeParse(p).success).toBe(false);
    p.mappings[1]!.expectedShape = [2, 300, 300];
    p.mappings[1]!.axisOrder = [0, 1, 2];
    expect(AdapterProposal.safeParse(p).success).toBe(false);
  });
  it('accepts explicit mapping and rejects executable expressions and generated handler fields', () => {
    const p = proposal();
    expect(AdapterProposal.safeParse(p).success).toBe(true);
    p.mappings[1]!.root = 'history.values()';
    expect(AdapterProposal.safeParse(p).success).toBe(false);
    expect(
      AdapterProposal.safeParse({ ...proposal(), pythonCode: 'repair()' })
        .success,
    ).toBe(false);
  });
  it('requires a dimension permutation and domain-appropriate unique observations', () => {
    const p = proposal();
    p.mappings[1]!.axisOrder = [0, 0];
    expect(AdapterProposal.safeParse(p).success).toBe(false);
    expect(
      AdapterProposal.safeParse({ ...proposal(), domain: 'orbital_dynamics' })
        .success,
    ).toBe(false);
    const repeated = proposal();
    repeated.mappings.push(repeated.mappings[0]!);
    expect(AdapterProposal.safeParse(repeated).success).toBe(false);
  });
});
