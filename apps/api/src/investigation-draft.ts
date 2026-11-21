import { z } from 'zod';
import { Digest, Id, InvestigationDraft } from '@siphon/contracts';
export { InvestigationDraft } from '@siphon/contracts';

/** Check identity and evidence links; this cannot prove a claim is true or
 * that free text contains no executable instructions. Publication also needs
 * review, provider accounting, ownership and revision-fence checks.
 */
export function validateInvestigationDraft(
  value: unknown,
  expected: {
    auditId: string;
    revisionId: string;
    inputDigest: string;
    evidenceDigest: string;
    evidenceIds: readonly string[];
  },
) {
  const draft = InvestigationDraft.parse(value);
  Id.parse(expected.auditId);
  Id.parse(expected.revisionId);
  Digest.parse(expected.inputDigest);
  Digest.parse(expected.evidenceDigest);
  const ids = z.array(Id).min(1).max(150).parse(expected.evidenceIds);
  if (new Set(ids).size !== ids.length)
    throw new Error('Investigation evidence identifiers are duplicated');
  if (
    draft.auditId !== expected.auditId ||
    draft.revisionId !== expected.revisionId ||
    draft.inputDigest !== expected.inputDigest ||
    draft.evidenceDigest !== expected.evidenceDigest
  )
    throw new Error('Investigation evidence snapshot changed');
  const allowed = new Set(ids);
  if (
    [...draft.hypotheses, ...draft.recommendations].some((item) =>
      item.evidenceIds.some((id) => !allowed.has(id)),
    )
  )
    throw new Error('Investigation references unknown evidence');
  return draft;
}
