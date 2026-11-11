import { z } from 'zod';
import {
  InspectionResult,
  ResourcePolicy,
  UploadManifest,
  Id,
  Timestamp,
  DEFAULT_POLICY,
} from '@siphon/contracts';
import { type DocumentStore, type DocumentTransaction } from './firestore.js';
import { type ArtifactDownloadService } from './artifact-download.js';
import {
  DispatchFence,
  requireActiveRevision,
  nativeTimestamps,
} from './audit-commands.js';
import { SourceContextReview } from './context-tasks.js';
import { type AiConfiguration } from './ai-config.js';
import { canonicalJson, sha256 } from './hashing.js';

type Fence = z.infer<typeof DispatchFence>;
export type SourcePrivacyFinding = {
  artifactId: string;
  code:
    | 'credential_literal'
    | 'private_key'
    | 'credential_token'
    | 'invalid_utf8'
    | 'inspection_incomplete';
  line: number | null;
};
/** Narrow disclosure scan, not a security certificate. It deliberately blocks
 * suspicious literals, including comments, without returning their contents. */
export function scanContextSource(
  artifactId: string,
  text: string,
): SourcePrivacyFinding[] {
  const result: SourcePrivacyFinding[] = [];
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    let code: SourcePrivacyFinding['code'] | undefined;
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(line))
      code = 'private_key';
    else if (
      /(?:\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgsk_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,})/.test(
        line,
      )
    )
      code = 'credential_token';
    else if (
      /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|credential|client[_-]?secret)[\w-]*["']?\s*(?::\s*str\s*)?[:=]\s*(?:[rubf]{0,2})?["'][^"'\r\n]+["']/i.test(
        line,
      )
    )
      code = 'credential_literal';
    if (code) result.push({ artifactId, code, line: index + 1 });
    if (result.length >= 20) break;
  }
  return result;
}

/** Reviews actual accounted source bytes after real isolated parsing. Approval
 * is scoped to exact bytes and Meta context disclosure only; it cannot authorize
 * source execution, physical assumptions or general private-data safety. */
export class ContextSourceReviews {
  constructor(
    private readonly store: DocumentStore,
    private readonly downloads: Pick<ArtifactDownloadService, 'readBatch'>,
    private readonly clock: () => Date = () => new Date(),
    private readonly aiConfig?: AiConfiguration,
  ) {}

  private async inspect(tx: DocumentTransaction, uid: string, fence: Fence) {
    const state = await requireActiveRevision(tx, uid, fence);
    if (!['inspecting', 'clarifying'].includes(state.stage))
      throw new Error('Context review requires inspection stage');
    const base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
    const [revision, inspection] = await tx.getMany([
      base,
      `${base}/inspection/current`,
    ]);
    const manifest = UploadManifest.parse(revision?.sourceManifest).filter(
      (file) => file.path.endsWith('.py'),
    );
    const policy = ResourcePolicy.parse(revision?.policy);
    if (
      !manifest.length ||
      manifest.length > DEFAULT_POLICY.uploadFiles ||
      manifest.reduce((sum, file) => sum + file.bytes, 0) >
        Math.min(policy.sourceBytes, DEFAULT_POLICY.sourceBytes) ||
      inspection?.ownerUid !== uid ||
      inspection.inputDigest !== fence.inputDigest
    )
      throw new Error('Context review source/inspection scope mismatch');
    const operationId = Id.parse(inspection.operationId);
    const claim = await tx.get(`inspectionExecutions/${operationId}`);
    if (
      claim?.status !== 'published' ||
      claim.operationId !== operationId ||
      claim.ownerUid !== uid ||
      claim.auditId !== fence.auditId ||
      claim.revisionId !== fence.revisionId ||
      claim.inputDigest !== fence.inputDigest ||
      claim.resultDigest !== inspection.resultDigest
    )
      throw new Error('Context review lacks published inspection provenance');
    const records = await tx.getMany(
      manifest.map((file) => `${base}/inspectionSources/${file.artifactId}`),
    );
    const parsed = records.map((record, index) => {
      const file = manifest[index]!;
      const result = InspectionResult.parse(record?.inspection);
      if (
        record?.ownerUid !== uid ||
        record.operationId !== operationId ||
        record.inputDigest !== fence.inputDigest ||
        record.artifactId !== file.artifactId ||
        result.sourceDigest !== file.sha256
      )
        throw new Error('Context source inspection binding mismatch');
      return { artifactId: file.artifactId, inspection: result };
    });
    const resultDigest = await sha256(
      canonicalJson({
        schemaVersion: '1.0',
        operationId,
        inputDigest: fence.inputDigest,
        sources: parsed,
      }),
    );
    if (resultDigest !== inspection.resultDigest)
      throw new Error('Context inspection aggregate digest mismatch');
    return { manifest, policy, resultDigest, parsed };
  }

  async loadAndReview(
    uid: string,
    expected: unknown,
    callerSignal?: AbortSignal,
  ) {
    const fence = DispatchFence.parse(expected);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, AbortSignal.timeout(60000)])
      : AbortSignal.timeout(60000);
    const snapshot = await this.store.transaction((tx) =>
      this.inspect(tx, uid, fence),
    );
    const incomplete: SourcePrivacyFinding[] = snapshot.parsed
      .filter((item) => !item.inspection.parsed || item.inspection.truncated)
      .map((item) => ({
        artifactId: item.artifactId,
        code: 'inspection_incomplete',
        line: null,
      }));
    if (incomplete.length)
      return { status: 'blocked' as const, findings: incomplete };
    const loaded = await this.downloads.readBatch(
      uid,
      fence,
      snapshot.manifest.map((file) => file.artifactId),
      Math.min(snapshot.policy.sourceBytes, DEFAULT_POLICY.sourceBytes),
      signal,
    );
    if (
      loaded.length !== snapshot.manifest.length ||
      new Set(loaded.map((file) => file.artifactId)).size !== loaded.length
    )
      throw new Error('Context source collection mismatch');
    const sources: Array<{
      artifactId: string;
      sourceDigest: string;
      reviewId: string;
      text: string;
    }> = [];
    const findings: SourcePrivacyFinding[] = [];
    for (const file of snapshot.manifest) {
      const item = loaded.find((value) => value.artifactId === file.artifactId);
      if (
        !item ||
        item.bytes.length !== file.bytes ||
        item.sha256 !== file.sha256
      )
        throw new Error('Context source byte snapshot mismatch');
      let text: string;
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(item.bytes);
      } catch {
        findings.push({
          artifactId: file.artifactId,
          code: 'invalid_utf8',
          line: null,
        });
        continue;
      }
      if ((await sha256(text)) !== file.sha256)
        throw new Error('Context source UTF-8 hash mismatch');
      findings.push(...scanContextSource(file.artifactId, text));
      const digest = await sha256(
        canonicalJson({
          purpose: this.aiConfig ? 'groq_context' : 'meta_context',
          ...(this.aiConfig
            ? { model: this.aiConfig.model, endpoint: this.aiConfig.endpoint }
            : {}),
          profile: 'credential_literal_scan.v1',
          ownerUid: uid,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          artifactId: file.artifactId,
          sourceDigest: file.sha256,
          inspectionDigest: snapshot.resultDigest,
        }),
      );
      const reviewId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      sources.push({
        artifactId: file.artifactId,
        sourceDigest: file.sha256,
        reviewId,
        text,
      });
    }
    signal.throwIfAborted();
    await this.store.transaction(async (tx) => {
      const current = await this.inspect(tx, uid, fence);
      if (
        canonicalJson(current.manifest) !== canonicalJson(snapshot.manifest) ||
        current.resultDigest !== snapshot.resultDigest
      )
        throw new Error('Context review changed during transfer');
      const artifacts = await tx.getMany(
        sources.map(
          (source) => `audits/${fence.auditId}/artifacts/${source.artifactId}`,
        ),
      );
      const now = this.clock();
      const reviews = sources.map((source, index) => {
        const artifact = artifacts[index];
        if (
          artifact?.ownerUid !== uid ||
          artifact.auditId !== fence.auditId ||
          artifact.sha256 !== source.sourceDigest ||
          artifact.lifecycle !== 'ready'
        )
          throw new Error('Context review artifact access changed');
        const expiresAt = new Date(
          Math.min(
            Date.parse(Timestamp.parse(artifact.expiresAt)),
            now.getTime() + 3600000,
          ),
        ).toISOString();
        if (Date.parse(expiresAt) <= now.getTime() + 60000)
          throw new Error('Context review retention too short');
        return SourceContextReview.parse({
          schemaVersion: '1.0',
          id: source.reviewId,
          ownerUid: uid,
          auditId: fence.auditId,
          artifactId: source.artifactId,
          sourceDigest: source.sourceDigest,
          purpose: this.aiConfig ? 'groq_context' : 'meta_context',
          ...(this.aiConfig
            ? { model: this.aiConfig.model, endpoint: this.aiConfig.endpoint }
            : {}),
          approved: true,
          verifiedAt: now.toISOString(),
          expiresAt,
        });
      });
      // No approved review is produced if ANY source in the disclosed batch is blocked.
      for (const source of sources)
        tx.set(`sourceContextScans/${source.reviewId}`, {
          schemaVersion: '1.0',
          id: source.reviewId,
          ownerUid: uid,
          auditId: fence.auditId,
          revisionId: fence.revisionId,
          inputDigest: fence.inputDigest,
          artifactId: source.artifactId,
          sourceDigest: source.sourceDigest,
          inspectionDigest: snapshot.resultDigest,
          profile: 'credential_literal_scan.v1',
          status: findings.length ? 'blocked' : 'passed',
          findings: findings.filter(
            (item) => item.artifactId === source.artifactId,
          ),
          limitations: [
            'Pattern scan cannot prove absence of all credentials or sensitive information. No source is executed by this scan.',
          ],
          createdAt: now,
        });
      if (!findings.length)
        for (const review of reviews)
          tx.set(`sourceContextReviews/${review.id}`, nativeTimestamps(review));
    });
    signal.throwIfAborted();
    return findings.length
      ? { status: 'blocked' as const, findings }
      : { status: 'approved' as const, sources };
  }
}
