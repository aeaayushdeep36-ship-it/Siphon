import { z } from 'zod';
import { Digest, Domain, Id, SchemaVersion } from './common.js';

export const ContextField = z.enum([
  'units',
  'dimensions',
  'thermal_model',
  'thermal_boundary',
  'heat_sources',
  'thermal_quadrature',
  'time_control',
  'gravity_profile',
  'additional_forces',
  'reference_frame',
  'gravity_parameters',
]);
export const ContextProposal = z.strictObject({
  schemaVersion: SchemaVersion,
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  domain: Domain,
  summary: z.string().min(1).max(2000),
  domainMismatchSuspected: z.boolean(),
  candidates: z
    .array(
      z.strictObject({
        field: ContextField,
        description: z.string().min(1).max(500),
        uncertainty: z.enum(['explicit_declaration', 'inferred', 'unclear']),
        citations: z
          .array(
            z
              .strictObject({
                artifactId: Id,
                sourceDigest: Digest,
                startLine: z.number().int().positive().max(131072),
                endLine: z.number().int().positive().max(131072),
              })
              .refine((value) => value.endLine >= value.startLine),
          )
          .max(5),
      }),
    )
    .max(20),
});
export type ContextProposal = z.infer<typeof ContextProposal>;
export type ContextField = z.infer<typeof ContextField>;

/** Provenance location validation only. AI statements and cited comments remain unverified. */
export function validateContextProposal(
  value: unknown,
  snapshot: {
    auditId: string;
    revisionId: string;
    inputDigest: string;
    domain: z.infer<typeof Domain>;
    sources: Array<{
      artifactId: string;
      sourceDigest: string;
      lineCount: number;
    }>;
  },
) {
  const proposal = ContextProposal.parse(value);
  if (
    proposal.auditId !== snapshot.auditId ||
    proposal.revisionId !== snapshot.revisionId ||
    proposal.inputDigest !== snapshot.inputDigest ||
    proposal.domain !== snapshot.domain
  )
    throw new Error('Context proposal snapshot mismatch');
  const sources = new Map(
    snapshot.sources.map((source) => [source.artifactId, source]),
  );
  if (sources.size !== snapshot.sources.length)
    throw new Error('Duplicate source provenance');
  for (const candidate of proposal.candidates) {
    for (const citation of candidate.citations) {
      const source = sources.get(citation.artifactId);
      if (
        !source ||
        source.sourceDigest !== citation.sourceDigest ||
        citation.endLine > source.lineCount
      )
        throw new Error('Context citation does not match source snapshot');
    }
  }
  return proposal;
}
