import { describe, expect, it } from 'vitest';
import { validateInvestigationDraft } from './investigation-draft.js';

function fixture() {
  const snapshot = {
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    evidenceDigest: 'b'.repeat(64),
    evidenceIds: [crypto.randomUUID()],
  };
  const draft = {
    schemaVersion: '1.0',
    auditId: snapshot.auditId,
    revisionId: snapshot.revisionId,
    inputDigest: snapshot.inputDigest,
    evidenceDigest: snapshot.evidenceDigest,
    hypotheses: [
      {
        text: 'Sampling may affect the observed drift.',
        evidenceIds: snapshot.evidenceIds,
        verification: 'Compare additional saved samples.',
      },
    ],
    recommendations: [
      {
        text: 'Review the reported samples.',
        evidenceIds: snapshot.evidenceIds,
        validation: 'Compare a separately recorded run.',
      },
    ],
  };
  return { snapshot, draft };
}

describe('investigation draft boundary', () => {
  it('accepts evidence-linked advisory text for the exact snapshot', () => {
    const f = fixture();
    expect(validateInvestigationDraft(f.draft, f.snapshot)).toEqual(f.draft);
  });
  it('rejects changed snapshots, unknown or duplicated evidence, and missing validation', () => {
    const f = fixture();
    expect(() =>
      validateInvestigationDraft(f.draft, {
        ...f.snapshot,
        evidenceDigest: 'c'.repeat(64),
      }),
    ).toThrow('snapshot changed');
    expect(() =>
      validateInvestigationDraft(
        {
          ...f.draft,
          hypotheses: [
            { ...f.draft.hypotheses[0], evidenceIds: [crypto.randomUUID()] },
          ],
        },
        f.snapshot,
      ),
    ).toThrow('unknown evidence');
    expect(() =>
      validateInvestigationDraft(
        {
          ...f.draft,
          hypotheses: [
            {
              ...f.draft.hypotheses[0],
              evidenceIds: [
                f.snapshot.evidenceIds[0],
                f.snapshot.evidenceIds[0],
              ],
            },
          ],
        },
        f.snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateInvestigationDraft(
        {
          ...f.draft,
          recommendations: [
            { text: 'Review.', evidenceIds: f.snapshot.evidenceIds },
          ],
        },
        f.snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateInvestigationDraft(
        {
          ...f.draft,
          hypotheses: [
            { ...f.draft.hypotheses[0], text: '```python\nprint(1)\n```' },
          ],
        },
        f.snapshot,
      ),
    ).toThrow();
    expect(() =>
      validateInvestigationDraft(
        { ...f.draft, facts: ['unverified claim'] },
        f.snapshot,
      ),
    ).toThrow();
  });
});
