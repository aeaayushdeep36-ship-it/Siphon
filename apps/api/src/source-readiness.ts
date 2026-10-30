import {
  AdapterProposal,
  ContextProposal,
  Id,
  InspectionResult,
  ResourcePolicy,
  SourceJobRequest,
  Timestamp,
  UploadManifest,
} from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import { DispatchFence, requireActiveRevision } from './audit-commands.js';
import {
  ExecutionReadiness,
  SourceExecutionApproval,
} from './source-executions.js';
import { Operation } from './accounting.js';
import { SandboxRequest } from './e2b-client.js';
import { SandboxTermination } from './sandbox-termination.js';
import { AdapterTask } from './adapter-tasks.js';
import { canonicalJson, sha256 } from './hashing.js';

const approvedImports = new Set([
  'numpy',
  'scipy',
  'matplotlib',
  'pint',
  'rebound',
  'math',
  'cmath',
  'collections',
  'itertools',
  'functools',
  'statistics',
  'dataclasses',
  'typing',
  'enum',
  'array',
  'numbers',
  'decimal',
  'fractions',
]);

/** Deterministic admission for a faithful isolated baseline attempt only.
 * This does not certify code safety, correct units, physical assumptions or
 * adapter fidelity. All source still runs in fresh gated untrusted E2B VMs.
 */
export class SourceReadiness {
  constructor(
    private readonly documents: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async approve(
    uid: string,
    expected: unknown,
    value: unknown,
    kind: 'original' | 'adapted' = 'adapted',
  ) {
    if (kind !== 'original' && kind !== 'adapted')
      throw new Error('Invalid baseline kind');
    const fence = DispatchFence.parse(expected),
      request = SourceJobRequest.parse(value);
    const payloadDigest = await sha256(JSON.stringify(request));
    for (const file of request.files) {
      const bytes = Uint8Array.from(atob(file.dataBase64), (character) =>
        character.charCodeAt(0),
      );
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (n) => n.toString(16).padStart(2, '0'),
      ).join('');
      if (hash !== file.sha256)
        throw new Error('Baseline input bytes do not match immutable source');
    }
    return this.documents.transaction(async (tx) => {
      const state = await requireActiveRevision(tx, uid, fence),
        base = `audits/${fence.auditId}/revisions/${fence.revisionId}`;
      const [
        revision,
        context,
        savedAdapter,
        inspection,
        rawOperation,
        rawSandbox,
        priorReadiness,
        priorApproval,
      ] = await tx.getMany([
        base,
        `${base}/context/current`,
        `${base}/adapterProposals/current`,
        `${base}/inspection/current`,
        `operations/${request.operationId}`,
        `sandboxJobs/${request.operationId}`,
        `${base}/readiness/current`,
        `sourceExecutionApprovals/${request.operationId}`,
      ]);
      const adapter = AdapterProposal.parse(savedAdapter?.proposal),
        proposal = ContextProposal.parse(context?.proposal),
        operation = Operation.parse(rawOperation),
        sandbox = SandboxRequest.parse(rawSandbox?.request);
      const manifest = UploadManifest.parse(revision?.sourceManifest),
        policy = ResourcePolicy.parse(revision?.policy),
        now = this.clock();
      const adapterDigest = await sha256(canonicalJson(adapter));
      const files = request.files.map((file) => ({
        schemaVersion: file.schemaVersion,
        artifactId: file.artifactId,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      }));
      if (
        state.stage !== 'adapting' ||
        request.inputDigest !== fence.inputDigest ||
        operation.id !== request.operationId ||
        operation.ownerUid !== uid ||
        operation.auditId !== fence.auditId ||
        operation.revisionId !== fence.revisionId ||
        operation.inputDigest !== fence.inputDigest ||
        operation.fence !== fence.generation ||
        operation.outcome !== 'reserved' ||
        operation.providerHandle !== null ||
        sandbox.role !== 'source' ||
        sandbox.operationId !== operation.id ||
        sandbox.auditId !== fence.auditId ||
        sandbox.revisionId !== fence.revisionId ||
        sandbox.inputDigest !== fence.inputDigest ||
        operation.requestDigest !== (await sha256(canonicalJson(sandbox))) ||
        rawSandbox?.requestDigest !== operation.requestDigest ||
        canonicalJson(files) !== canonicalJson(manifest) ||
        request.entryArtifactId !== adapter.sourceArtifactId ||
        request.adapterDigest !== adapterDigest ||
        canonicalJson(request.mappings) !== canonicalJson(adapter.mappings) ||
        request.maximumOutputBytes > policy.outputBytes - 32768 ||
        savedAdapter?.ownerUid !== uid ||
        savedAdapter.inputDigest !== fence.inputDigest ||
        savedAdapter.adapterDigest !== adapterDigest ||
        savedAdapter.status !== 'proposed' ||
        adapter.auditId !== fence.auditId ||
        adapter.revisionId !== fence.revisionId ||
        adapter.inputDigest !== fence.inputDigest ||
        context?.ownerUid !== uid ||
        proposal.auditId !== fence.auditId ||
        proposal.revisionId !== fence.revisionId ||
        proposal.inputDigest !== fence.inputDigest ||
        proposal.domainMismatchSuspected ||
        adapter.contextDigest !== (await sha256(canonicalJson(proposal))) ||
        context.proposalDigest !== adapter.contextDigest
      )
        throw new Error('Baseline readiness snapshot/operation mismatch');
      if (
        !manifest.some(
          (file) =>
            file.artifactId === adapter.sourceArtifactId &&
            file.sha256 === adapter.sourceDigest &&
            file.path.endsWith('.py'),
        )
      )
        throw new Error('Baseline entry source mismatch');
      const adapterOperationId = Id.parse(savedAdapter.operationId),
        inspectionOperationId = Id.parse(inspection?.operationId);
      const [
        adapterOperationRaw,
        taskRaw,
        claim,
        inspectionOperationRaw,
        terminationRaw,
        adapterJob,
      ] = await tx.getMany([
        `operations/${adapterOperationId}`,
        `adapterTasks/${adapterOperationId}`,
        `inspectionExecutions/${inspectionOperationId}`,
        `operations/${inspectionOperationId}`,
        `sandboxTerminations/${inspectionOperationId}`,
        `modelJobs/${adapterOperationId}`,
      ]);
      const adapterOperation = Operation.parse(adapterOperationRaw),
        task = AdapterTask.parse(taskRaw),
        inspectionOperation = Operation.parse(inspectionOperationRaw),
        termination = SandboxTermination.parse(terminationRaw);
      if (
        adapterOperation.id !== adapterOperationId ||
        adapterOperation.outcome !== 'succeeded' ||
        !adapterOperation.usage ||
        adapterOperation.ownerUid !== uid ||
        adapterOperation.auditId !== fence.auditId ||
        adapterOperation.revisionId !== fence.revisionId ||
        adapterOperation.inputDigest !== fence.inputDigest ||
        adapterOperation.requestDigest !== task.requestDigest ||
        task.operationId !== adapterOperationId ||
        task.ownerUid !== uid ||
        task.auditId !== fence.auditId ||
        task.revisionId !== fence.revisionId ||
        task.inputDigest !== fence.inputDigest ||
        task.contextDigest !== adapter.contextDigest ||
        task.generation !== adapterOperation.fence ||
        adapterJob?.operationId !== adapterOperationId ||
        adapterJob.requestDigest !== task.requestDigest ||
        inspection?.ownerUid !== uid ||
        inspection.inputDigest !== fence.inputDigest ||
        claim?.status !== 'published' ||
        claim.ownerUid !== uid ||
        claim.auditId !== fence.auditId ||
        claim.revisionId !== fence.revisionId ||
        claim.inputDigest !== fence.inputDigest ||
        claim.resultDigest !== inspection.resultDigest ||
        inspectionOperation.id !== inspectionOperationId ||
        inspectionOperation.ownerUid !== uid ||
        inspectionOperation.auditId !== fence.auditId ||
        inspectionOperation.revisionId !== fence.revisionId ||
        inspectionOperation.inputDigest !== fence.inputDigest ||
        termination.operationId !== inspectionOperationId ||
        termination.ownerUid !== uid ||
        termination.auditId !== fence.auditId ||
        termination.revisionId !== fence.revisionId ||
        termination.inputDigest !== fence.inputDigest ||
        termination.requestDigest !== inspectionOperation.requestDigest ||
        termination.sandboxId !== inspectionOperation.providerHandle ||
        termination.sandboxId !== claim.sandboxId
      )
        throw new Error(
          'Baseline readiness lacks completed adapter/inspection provenance',
        );
      const artifacts = await tx.getMany(
        manifest.map(
          (file) => `audits/${fence.auditId}/artifacts/${file.artifactId}`,
        ),
      );
      const py = manifest.filter((file) => file.path.endsWith('.py'));
      const inspected = await tx.getMany(
        py.map((file) => `${base}/inspectionSources/${file.artifactId}`),
      );
      const reasons: Array<{
        artifactId: string;
        code: string;
        line: number | null;
      }> = [];
      let expiry = Math.min(
        Date.parse(Timestamp.parse(savedAdapter.expiresAt)),
        now.getTime() + 86400_000,
      );
      for (const [index, file] of manifest.entries()) {
        const artifact = artifacts[index];
        if (
          !artifact ||
          artifact.ownerUid !== uid ||
          artifact.auditId !== fence.auditId ||
          artifact.artifactId !== file.artifactId ||
          artifact.lifecycle !== 'ready' ||
          artifact.path !== file.path ||
          artifact.sha256 !== file.sha256 ||
          artifact.bytes !== file.bytes
        )
          throw new Error('Baseline artifact integrity mismatch');
        expiry = Math.min(
          expiry,
          Date.parse(Timestamp.parse(artifact.expiresAt)),
        );
        if (!file.path.endsWith('.py'))
          reasons.push({
            artifactId: file.artifactId,
            code: 'numeric_input_validation_required',
            line: null,
          });
      }
      const parsed = py.map((file, index) => {
        const record = inspected[index],
          result = InspectionResult.parse(record?.inspection);
        if (
          record?.ownerUid !== uid ||
          record.operationId !== inspectionOperationId ||
          record.inputDigest !== fence.inputDigest ||
          record.artifactId !== file.artifactId ||
          result.sourceDigest !== file.sha256
        )
          throw new Error('Baseline source inspection mismatch');
        if (!result.parsed || result.truncated || result.findings.length)
          reasons.push({
            artifactId: file.artifactId,
            code: 'source_inspection_requires_review',
            line: result.findings[0]?.line ?? null,
          });
        for (const dependency of result.dependencies) {
          const root = dependency.name.split('.')[0]!,
            local = manifest.some(
              (item) =>
                item.path === `${root}.py` ||
                item.path === `${root}/__init__.py`,
            );
          if (
            dependency.kind !== 'absolute_import' ||
            (!approvedImports.has(root) && !local)
          )
            reasons.push({
              artifactId: file.artifactId,
              code: 'dependency_not_supported',
              line: dependency.line,
            });
        }
        return { artifactId: file.artifactId, inspection: result };
      });
      if (
        inspection.resultDigest !==
        (await sha256(
          canonicalJson({
            schemaVersion: '1.0',
            operationId: inspectionOperationId,
            inputDigest: fence.inputDigest,
            sources: parsed,
          }),
        ))
      )
        throw new Error('Baseline inspection aggregate changed');
      if (expiry <= now.getTime() + sandbox.lifetimeSeconds * 1000)
        reasons.push({
          artifactId: adapter.sourceArtifactId,
          code: 'input_retention_too_short',
          line: null,
        });
      if (reasons.length) return { status: 'needs_input' as const, reasons };
      const assessment = ExecutionReadiness.parse({
        schemaVersion: '1.0',
        auditId: fence.auditId,
        revisionId: fence.revisionId,
        inputDigest: fence.inputDigest,
        contextDigest: adapter.contextDigest,
        sourceManifestDigest: await sha256(canonicalJson(manifest)),
        status: 'ready',
        evidenceIds: [inspectionOperationId, adapterOperationId],
      });
      const readinessDigest = await sha256(canonicalJson(assessment));
      if (
        priorReadiness &&
        canonicalJson(ExecutionReadiness.parse(priorReadiness.assessment)) !==
          canonicalJson(assessment)
      )
        throw new Error('Baseline readiness is immutable');
      if (priorApproval) {
        const prior = SourceExecutionApproval.parse(priorApproval);
        if (
          prior.ownerUid !== uid ||
          prior.payloadDigest !== payloadDigest ||
          prior.readinessDigest !== readinessDigest ||
          canonicalJson(prior.adapter) !== canonicalJson(adapter) ||
          prior.extractionProfile !==
            (kind === 'original' ? 'reference_v1' : 'adapter_v1') ||
          Date.parse(prior.expiresAt) <= now.getTime()
        )
          throw new Error('Baseline approval conflict');
      } else {
        const approval = SourceExecutionApproval.parse({
          schemaVersion: '1.0',
          id: operation.id,
          ownerUid: uid,
          payloadDigest,
          readinessDigest,
          adapter,
          executionProfile: 'runpy_main_root_v1',
          extractionProfile:
            kind === 'original' ? 'reference_v1' : 'adapter_v1',
          purpose: 'baseline_observation',
          verifiedAt: now.toISOString(),
          expiresAt: new Date(expiry).toISOString(),
        });
        tx.set(`sourceExecutionApprovals/${operation.id}`, {
          ...approval,
          verifiedAt: now,
          expiresAt: new Date(expiry),
        });
      }
      if (!priorReadiness)
        tx.set(`${base}/readiness/current`, {
          schemaVersion: '1.0',
          ownerUid: uid,
          assessment,
          readinessDigest,
          scope: 'isolated_baseline_attempt',
          limitations: [
            'Ready to attempt isolated extraction; physical meaning, dependency runtime success and adapter fidelity are not certified.',
          ],
          createdAt: now,
          updatedAt: now,
        });
      return {
        status: 'ready' as const,
        approvalId: operation.id,
        readinessDigest,
      };
    });
  }
}
