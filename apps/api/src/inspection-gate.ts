import { z } from 'zod';
import {
  DEFAULT_POLICY,
  InspectedSource,
  InspectionGate,
  ReadinessFinding,
  UploadManifest,
  preflightUploads,
  validateInspectionResult,
  type ResourcePolicy,
} from '@siphon/contracts';

/** Deterministic parser-evidence gate, not the final physical/execution readiness decision.
 * No user/model flag can certify dependencies, numeric assets or privacy review here.
 */
export function evaluateInspectionGate(
  manifestValue: unknown,
  resultsValue: unknown,
  policy: Readonly<ResourcePolicy> = DEFAULT_POLICY,
): InspectionGate {
  const manifest = UploadManifest.parse(manifestValue);
  const results = z
    .array(InspectedSource)
    .max(policy.uploadFiles)
    .parse(resultsValue);
  const byId = new Map(results.map((item) => [item.artifactId, item.result]));
  if (byId.size !== results.length)
    throw new Error('Duplicate inspection result');
  for (const item of results) {
    const file = manifest.find(
      (entry) =>
        entry.artifactId === item.artifactId && entry.path.endsWith('.py'),
    );
    if (!file)
      throw new Error(
        'Inspection does not belong to a Python source in this revision',
      );
    validateInspectionResult(item.result, file.sha256);
  }
  const findings: z.infer<typeof ReadinessFinding>[] = [];
  const sourceDigests = manifest
    .filter((file) => file.path.endsWith('.py'))
    .map(({ artifactId, sha256 }) => ({ artifactId, sha256 }));
  if (preflightUploads(manifest, policy).status !== 'ready')
    return {
      schemaVersion: '1.0',
      status: 'unsupported',
      sourceDigests,
      findings: [{ artifactId: null, code: 'upload_policy', line: null }],
      next: 'unsupported',
    };
  let parseFailure = false;
  let incomplete = false;
  for (const file of manifest) {
    if (!file.path.endsWith('.py')) {
      findings.push({
        artifactId: file.artifactId,
        code: 'numeric_input_review',
        line: null,
      });
      continue;
    }
    const result = byId.get(file.artifactId);
    if (!result) {
      incomplete = true;
      findings.push({
        artifactId: file.artifactId,
        code: 'missing_inspection',
        line: null,
      });
      continue;
    }
    if (!result.parsed) {
      parseFailure = true;
      findings.push({
        artifactId: file.artifactId,
        code: 'parse_failure',
        line: result.findings[0]?.line ?? null,
      });
      continue;
    }
    if (result.truncated) {
      incomplete = true;
      findings.push({
        artifactId: file.artifactId,
        code: 'inspection_incomplete',
        line: null,
      });
    }
    // A parse tree never proves that source is suitable to send to a model.
    findings.push({
      artifactId: file.artifactId,
      code: 'source_privacy_review',
      line: null,
    });
    if (result.dependencies.length)
      findings.push({
        artifactId: file.artifactId,
        code: 'dependency_review',
        line: null,
      });
    for (const finding of result.findings)
      findings.push({
        artifactId: file.artifactId,
        code: 'dynamic_code_review',
        line: finding.line,
      });
  }
  return InspectionGate.parse({
    schemaVersion: '1.0',
    sourceDigests,
    findings,
    status: parseFailure ? 'unsupported' : 'needs_input',
    next: parseFailure
      ? 'unsupported'
      : incomplete
        ? 'resolve_inspection'
        : 'review_requirements',
  });
}
