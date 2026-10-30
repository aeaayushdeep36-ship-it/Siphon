import { z } from 'zod';
import { Count, Digest, Id, SchemaVersion } from './common.js';
import { DEFAULT_POLICY, type ResourcePolicy } from './policy.js';

export const SafeUploadPath = z
  .string()
  .min(1)
  .max(240)
  .superRefine((path, ctx) => {
    const segments = path.split('/');
    const unsafe =
      path !== path.normalize('NFC') ||
      /[\\:]/.test(path) ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      segments.some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^[ ]/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      );
    if (unsafe)
      ctx.addIssue({ code: 'custom', message: 'Unsafe relative upload path' });
    if (!/\.(py|csv|npy)$/.test(path))
      ctx.addIssue({ code: 'custom', message: 'Unsupported extension' });
  });

export const UploadEntry = z.strictObject({
  schemaVersion: SchemaVersion,
  artifactId: Id,
  path: SafeUploadPath,
  bytes: Count,
  sha256: Digest,
});
export const UploadManifest = z.array(UploadEntry).min(1);
export type UploadEntry = z.infer<typeof UploadEntry>;

export type PreflightResult = {
  status: 'ready' | 'unsupported';
  reasons: string[];
  totalBytes: number;
  sourceBytes: number;
};

/** Metadata checks only. Bytes/content, symlinks and numeric arrays require isolated inspection. */
export function preflightUploads(
  input: unknown,
  policy: Readonly<ResourcePolicy> = DEFAULT_POLICY,
): PreflightResult {
  const parsed = UploadManifest.safeParse(input);
  if (!parsed.success)
    return {
      status: 'unsupported',
      reasons: ['invalid_upload_manifest'],
      totalBytes: 0,
      sourceBytes: 0,
    };
  const reasons: string[] = [];
  const paths = new Set<string>();
  const ids = new Set<string>();
  let total = 0n;
  let source = 0n;
  let pythonCount = 0;
  if (parsed.data.length > policy.uploadFiles)
    reasons.push('upload_file_limit');
  for (const file of parsed.data) {
    const path = file.path.toLowerCase();
    if (paths.has(path)) reasons.push('duplicate_upload_path');
    if (ids.has(file.artifactId)) reasons.push('duplicate_artifact');
    paths.add(path);
    ids.add(file.artifactId);
    total += BigInt(file.bytes);
    if (file.path.endsWith('.py')) {
      source += BigInt(file.bytes);
      pythonCount++;
    }
  }
  if (!pythonCount) reasons.push('python_source_required');
  if (total > BigInt(policy.uploadBytes)) reasons.push('upload_byte_limit');
  if (source > BigInt(policy.sourceBytes)) reasons.push('source_byte_limit');
  return {
    status: reasons.length ? 'unsupported' : 'ready',
    reasons: [...new Set(reasons)],
    totalBytes: Number(
      total > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : total,
    ),
    sourceBytes: Number(
      source > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : source,
    ),
  };
}
