import { z } from 'zod';
import { Digest, SchemaVersion } from './common.js';

const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const symbol = z.strictObject({
  kind: z.string(),
  name: z.string().min(1).max(200),
  line,
});
export const InspectionResult = z
  .strictObject({
    schemaVersion: SchemaVersion,
    sourceDigest: Digest,
    parsed: z.boolean(),
    truncated: z.boolean(),
    dependencies: z
      .array(
        symbol.extend({ kind: z.enum(['absolute_import', 'relative_import']) }),
      )
      .max(200),
    definitions: z
      .array(
        symbol.extend({
          kind: z.enum([
            'FunctionDef',
            'AsyncFunctionDef',
            'ClassDef',
            'assignment',
          ]),
        }),
      )
      .max(200),
    findings: z
      .array(
        z.strictObject({
          code: z.enum([
            'source_byte_limit',
            'null_byte',
            'invalid_source_encoding',
            'syntax_error',
            'parser_resource_or_input_error',
            'dynamic_code_requires_review',
            'dynamic_import_requires_review',
          ]),
          line: line.nullable(),
        }),
      )
      .max(200),
  })
  .superRefine((result, ctx) => {
    if (
      result.dependencies.length +
        result.definitions.length +
        result.findings.length >
      200
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inspection record budget exceeded',
      });
    const parseFailures = result.findings.filter(
      (finding) => !finding.code.endsWith('_requires_review'),
    );
    if (result.parsed && parseFailures.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Parsed result contains a parse failure',
      });
    if (
      !result.parsed &&
      (parseFailures.length !== 1 ||
        result.dependencies.length ||
        result.definitions.length ||
        result.truncated)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Parse failure must contain one failure and no extracted observations',
      });
  });
export type InspectionResult = z.infer<typeof InspectionResult>;

export function validateInspectionResult(
  value: unknown,
  expectedSourceDigest: string,
): InspectionResult {
  const expected = Digest.parse(expectedSourceDigest);
  const result = InspectionResult.parse(value);
  if (result.sourceDigest !== expected)
    throw new Error('Inspection belongs to different source bytes');
  return result;
}
