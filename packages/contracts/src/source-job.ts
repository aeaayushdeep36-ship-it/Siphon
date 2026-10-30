import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion } from './common.js';
import { UploadEntry, preflightUploads } from './uploads.js';
import { ObservationMapping, ObservationKey } from './adapter.js';
import { DEFAULT_POLICY } from './policy.js';

export const SourceJobRequest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    operationId: Id,
    inputDigest: Digest,
    adapterDigest: Digest,
    entryArtifactId: Id,
    files: z
      .array(
        UploadEntry.extend({
          dataBase64: z
            .string()
            .max(Math.ceil(DEFAULT_POLICY.uploadBytes / 3) * 4)
            .regex(
              /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            ),
        }),
      )
      .min(1)
      .max(DEFAULT_POLICY.uploadFiles),
    mappings: z.array(ObservationMapping).min(1).max(10),
    maximumOutputBytes: Count.refine(
      (n) => n > 0 && n <= DEFAULT_POLICY.outputBytes - 32768,
    ),
    maximumElements: Count.refine(
      (n) => n > 0 && n <= Math.floor(DEFAULT_POLICY.outputBytes / 8),
    ),
  })
  .superRefine((value, ctx) => {
    const expectedElements = value.mappings.reduce(
      (sum, mapping) => sum + mapping.expectedShape.reduce((a, b) => a * b, 1),
      0,
    );
    if (
      expectedElements > value.maximumElements ||
      expectedElements * 8 > value.maximumOutputBytes
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Expected observations exceed the requested resource allowance',
      });
    const manifest = value.files.map((file) => ({
      schemaVersion: file.schemaVersion,
      artifactId: file.artifactId,
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
    }));
    if (
      preflightUploads(manifest).status !== 'ready' ||
      !manifest.some(
        (file) =>
          file.artifactId === value.entryArtifactId &&
          file.path.endsWith('.py'),
      ) ||
      new Set(value.mappings.map((mapping) => mapping.key)).size !==
        value.mappings.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid source job manifest or mappings',
      });
    for (const file of value.files) {
      const decodedSize =
        (file.dataBase64.length / 4) * 3 -
        (file.dataBase64.endsWith('==')
          ? 2
          : file.dataBase64.endsWith('=')
            ? 1
            : 0);
      if (decodedSize !== file.bytes)
        ctx.addIssue({
          code: 'custom',
          message: 'Input byte length does not match manifest',
        });
      if (btoa(atob(file.dataBase64)) !== file.dataBase64)
        ctx.addIssue({ code: 'custom', message: 'Noncanonical input base64' });
    }
  });
export const SourceJobResult = z.strictObject({
  schemaVersion: SchemaVersion,
  operationId: Id,
  inputDigest: Digest,
  adapterDigest: Digest,
  executionProfile: z.literal('runpy_main_root_v1'),
  observations: z
    .array(
      z.strictObject({
        key: ObservationKey,
        filename: z.string().regex(/^obs_[a-z][a-z0-9_]{0,63}\.npy$/),
        sha256: Digest,
        bytes: Count,
        shape: z.array(z.number().int().nonnegative()).max(4),
        dtype: z.literal('float64'),
        declaredUnit: z.string().min(1).max(100),
      }),
    )
    .min(1)
    .max(10),
});

export function validateSourceJobResult(value: unknown, requestValue: unknown) {
  const request = SourceJobRequest.parse(requestValue);
  return validateObservationManifest(value, request);
}

/** Data-only boundary: no source bytes are needed in trusted evaluation. */
export function validateObservationManifest(
  value: unknown,
  request: {
    operationId: string;
    inputDigest: string;
    adapterDigest: string;
    mappings: z.infer<typeof ObservationMapping>[];
    maximumOutputBytes: number;
  },
) {
  const result = SourceJobResult.parse(value);
  if (
    result.operationId !== request.operationId ||
    result.inputDigest !== request.inputDigest ||
    result.adapterDigest !== request.adapterDigest ||
    result.observations.length !== request.mappings.length ||
    new Set(result.observations.map((item) => item.key)).size !==
      result.observations.length ||
    result.observations.reduce((sum, item) => sum + item.bytes, 0) >
      request.maximumOutputBytes
  )
    throw new Error('Source job output identity or size mismatch');
  for (const mapping of request.mappings) {
    const output = result.observations.find((item) => item.key === mapping.key);
    if (
      !output ||
      output.filename !== `obs_${mapping.key}.npy` ||
      JSON.stringify(output.shape) !== JSON.stringify(mapping.expectedShape) ||
      output.declaredUnit !== mapping.declaredUnit
    )
      throw new Error('Source job observation does not match its mapping');
  }
  return result;
}

export const ObservationValidationRequest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    evaluationOperationId: Id,
    sourceOperationId: Id,
    inputDigest: Digest,
    adapterDigest: Digest,
    manifest: SourceJobResult,
    mappings: z.array(ObservationMapping).min(1).max(10),
    maximumBytes: Count.refine((n) => n > 0 && n <= DEFAULT_POLICY.outputBytes),
    maximumElements: Count.refine(
      (n) => n > 0 && n <= Math.floor(DEFAULT_POLICY.outputBytes / 8),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.evaluationOperationId === value.sourceOperationId)
      ctx.addIssue({
        code: 'custom',
        message: 'Evaluation must be a distinct operation',
      });
    try {
      validateObservationManifest(value.manifest, {
        operationId: value.sourceOperationId,
        inputDigest: value.inputDigest,
        adapterDigest: value.adapterDigest,
        mappings: value.mappings,
        maximumOutputBytes: value.maximumBytes,
      });
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Validation manifest does not match the approved mapping',
      });
    }
    const elements = value.mappings.reduce(
      (sum, item) => sum + item.expectedShape.reduce((a, b) => a * b, 1),
      0,
    );
    if (
      new Set(value.mappings.map((item) => item.key)).size !==
        value.mappings.length ||
      elements > value.maximumElements
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Validation mappings exceed their element budget or are duplicated',
      });
  });

export const ObservationValidationResult = z
  .strictObject({
    schemaVersion: SchemaVersion,
    evaluationOperationId: Id,
    sourceOperationId: Id,
    inputDigest: Digest,
    adapterDigest: Digest,
    validation: z.literal('validated_numeric_structure'),
    totalBytes: Count,
    totalElements: Count,
    observations: z
      .array(
        z.strictObject({
          key: ObservationKey,
          sha256: Digest,
          bytes: Count,
          shape: z.array(z.number().int().positive().max(65536)).max(4),
          dtype: z.literal('float64'),
          originalDtype: z.string().regex(/^[<>=]f8$/),
          conversion: z.enum(['none', 'exact_to_float64']),
          declaredUnit: z.string().min(1).max(100),
          elements: Count,
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((value, ctx) => {
    if (
      value.evaluationOperationId === value.sourceOperationId ||
      new Set(value.observations.map((item) => item.key)).size !==
        value.observations.length ||
      value.observations.some(
        (item) => item.elements !== item.shape.reduce((a, b) => a * b, 1),
      ) ||
      value.totalElements !==
        value.observations.reduce((sum, item) => sum + item.elements, 0) ||
      value.totalBytes !==
        value.observations.reduce((sum, item) => sum + item.bytes, 0)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Validation summary identities/counts are inconsistent',
      });
  });

export function validateObservationValidationResult(
  value: unknown,
  requestValue: unknown,
) {
  const request = ObservationValidationRequest.parse(requestValue);
  const result = ObservationValidationResult.parse(value);
  if (
    result.evaluationOperationId !== request.evaluationOperationId ||
    result.sourceOperationId !== request.sourceOperationId ||
    result.inputDigest !== request.inputDigest ||
    result.adapterDigest !== request.adapterDigest ||
    result.observations.length !== request.manifest.observations.length ||
    result.totalBytes > request.maximumBytes ||
    result.totalElements > request.maximumElements
  )
    throw new Error('Validation result snapshot mismatch');
  for (const output of result.observations) {
    const source = request.manifest.observations.find(
      (item) => item.key === output.key,
    );
    if (
      !source ||
      source.sha256 !== output.sha256 ||
      source.bytes !== output.bytes ||
      source.declaredUnit !== output.declaredUnit ||
      JSON.stringify(source.shape) !== JSON.stringify(output.shape)
    )
      throw new Error('Validation result observation mismatch');
  }
  return result;
}
