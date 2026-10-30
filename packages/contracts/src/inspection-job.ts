import { z } from 'zod';
import { Digest, Id, SchemaVersion } from './common.js';
import { DEFAULT_POLICY } from './policy.js';
import { InspectionResult, validateInspectionResult } from './inspection.js';

export const InspectionJobRequest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    operationId: Id,
    inputDigest: Digest,
    maximumSourceBytes: z
      .number()
      .int()
      .positive()
      .max(DEFAULT_POLICY.sourceBytes),
    sources: z
      .array(
        z.strictObject({
          artifactId: Id,
          sourceDigest: Digest,
          sourceBase64: z
            .string()
            .max(Math.ceil(DEFAULT_POLICY.sourceBytes / 3) * 4)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        }),
      )
      .min(1)
      .max(DEFAULT_POLICY.uploadFiles),
  })
  .superRefine((value, ctx) => {
    for (const source of value.sources) {
      // Reject nonzero unused padding bits, matching Python's canonical decoder.
      const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const encoded = source.sourceBase64;
      if (
        (encoded.endsWith('==') &&
          (alphabet.indexOf(encoded.at(-3)!) & 15) !== 0) ||
        (encoded.endsWith('=') &&
          !encoded.endsWith('==') &&
          (alphabet.indexOf(encoded.at(-2)!) & 3) !== 0)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Source encoding is not canonical base64',
        });
    }
    if (
      new Set(value.sources.map((s) => s.artifactId)).size !==
      value.sources.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate source artifact' });
    const bytes = value.sources.reduce(
      (sum, source) =>
        sum +
        (source.sourceBase64.length / 4) * 3 -
        (source.sourceBase64.endsWith('==')
          ? 2
          : source.sourceBase64.endsWith('=')
            ? 1
            : 0),
      0,
    );
    if (bytes > value.maximumSourceBytes)
      ctx.addIssue({
        code: 'custom',
        message: 'Combined source limit exceeded',
      });
  });
export const InspectionJobResult = z.strictObject({
  schemaVersion: SchemaVersion,
  operationId: Id,
  inputDigest: Digest,
  sources: z
    .array(z.strictObject({ artifactId: Id, inspection: InspectionResult }))
    .min(1)
    .max(DEFAULT_POLICY.uploadFiles),
});

export type InspectionJobRequest = z.infer<typeof InspectionJobRequest>;

export function validateInspectionJobResult(
  value: unknown,
  requestValue: unknown,
) {
  const request = InspectionJobRequest.parse(requestValue);
  const result = InspectionJobResult.parse(value);
  if (
    request.operationId !== result.operationId ||
    request.inputDigest !== result.inputDigest ||
    request.sources.length !== result.sources.length ||
    new Set(result.sources.map((s) => s.artifactId)).size !==
      result.sources.length
  )
    throw new Error('Inspection job response identity mismatch');
  for (const source of request.sources) {
    const inspected = result.sources.find(
      (item) => item.artifactId === source.artifactId,
    );
    if (!inspected) throw new Error('Inspection job response omitted source');
    validateInspectionResult(inspected.inspection, source.sourceDigest);
  }
  return result;
}
