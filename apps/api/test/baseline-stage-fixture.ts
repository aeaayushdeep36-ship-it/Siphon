import { adapterStageFixture } from './adapter-stage-fixture.js';
import { SourceReadiness } from '../src/source-readiness.js';
import { InspectionResult, SourceJobRequest } from '@siphon/contracts';
import { canonicalJson, sha256 } from '../src/hashing.js';

export async function baselineStageFixture(dependency = 'numpy') {
  const f = await adapterStageFixture();
  const proposed = await f.coordinator.run('alice', f.fence);
  if (proposed.status !== 'proposal_ready')
    throw new Error('Authored proposal failed');
  const revision = f.docs.documents.get(f.base)!;
  const files = revision.sourceManifest as Array<Record<string, unknown>>;
  const file = files[0]!;
  const operationId = crypto.randomUUID(),
    inspectionId = crypto.randomUUID();
  // Authored inspection/provider receipts: no uploaded source runs on the host.
  const inspection = InspectionResult.parse({
    schemaVersion: '1.0',
    sourceDigest: file.sha256,
    parsed: true,
    truncated: false,
    dependencies: [{ kind: 'absolute_import', name: dependency, line: 1 }],
    definitions: [],
    findings: [],
  });
  const resultDigest = await sha256(
    canonicalJson({
      schemaVersion: '1.0',
      operationId: inspectionId,
      inputDigest: f.fence.inputDigest,
      sources: [{ artifactId: file.artifactId, inspection }],
    }),
  );
  const common = {
    ownerUid: 'alice',
    auditId: f.fence.auditId,
    revisionId: f.fence.revisionId,
    inputDigest: f.fence.inputDigest,
  };
  f.docs.documents.set(`${f.base}/inspection/current`, {
    ...common,
    operationId: inspectionId,
    resultDigest,
  });
  f.docs.documents.set(`${f.base}/inspectionSources/${file.artifactId}`, {
    ...common,
    operationId: inspectionId,
    artifactId: file.artifactId,
    inspection,
  });
  f.docs.documents.set(`inspectionExecutions/${inspectionId}`, {
    ...common,
    status: 'published',
    sandboxId: 'authored-inspection',
    resultDigest,
  });
  const now = f.clock().toISOString();
  const operation = {
    schemaVersion: '1.0',
    ...common,
    fence: proposed.fence.generation,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges: [
      {
        counterKey: 'authored_seconds',
        unit: 'seconds',
        amount: 60,
        consumeOnDispatch: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  f.docs.documents.set(`operations/${inspectionId}`, {
    ...operation,
    id: inspectionId,
    requestDigest: 'b'.repeat(64),
    providerHandle: 'authored-inspection',
    outcome: 'succeeded',
    usage: { authored_seconds: 1 },
  });
  f.docs.documents.set(`sandboxTerminations/${inspectionId}`, {
    schemaVersion: '1.0',
    ...common,
    operationId: inspectionId,
    sandboxId: 'authored-inspection',
    requestDigest: 'b'.repeat(64),
    outcome: 'killed',
    observedAt: now,
  });
  const sandbox = {
    operationId,
    auditId: f.fence.auditId,
    revisionId: f.fence.revisionId,
    inputDigest: f.fence.inputDigest,
    role: 'source',
    templateId: 'authored-source',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const requestDigest = await sha256(canonicalJson(sandbox));
  f.docs.documents.set(`operations/${operationId}`, {
    ...operation,
    id: operationId,
    requestDigest,
  });
  f.docs.documents.set(`sandboxJobs/${operationId}`, {
    request: sandbox,
    requestDigest,
  });
  for (const key of [
    'r2_storage_bytes',
    `revision_output_bytes_${f.fence.revisionId}`,
  ])
    f.docs.documents.set(`budgets/${key}`, {
      schemaVersion: '1.0',
      limit: 100000,
      reserved: 0,
      spent: 0,
      halted: false,
    });
  const request = SourceJobRequest.parse({
    schemaVersion: '1.0',
    operationId,
    inputDigest: f.fence.inputDigest,
    adapterDigest: proposed.adapterDigest,
    entryArtifactId: file.artifactId,
    files: [{ ...file, dataBase64: btoa(f.source.text) }],
    mappings: proposed.proposal.mappings,
    maximumOutputBytes: 4096,
    maximumElements: 100,
  });
  return {
    ...f,
    fence: proposed.fence,
    request,
    inspectionId,
    readiness: new SourceReadiness(f.docs, f.clock),
  };
}
