import { baselineExecutionFixture } from './baseline-execution-fixture.js';
import { FidelityExecutions } from '../src/fidelity-executions.js';
import { canonicalJson, sha256 } from '../src/hashing.js';

export async function fidelityExecutionFixture() {
  const f = await baselineExecutionFixture(),
    original = await f.stage.run('alice', f.fence, 'original'),
    adapted = await f.stage.run('alice', f.fence, 'adapted');
  if (original.status !== 'source_stored' || adapted.status !== 'source_stored')
    throw new Error('Fixture source stage failed');
  const now = f.clock().toISOString(),
    common = {
      ownerUid: 'alice',
      auditId: f.fence.auditId,
      revisionId: f.fence.revisionId,
      inputDigest: f.fence.inputDigest,
    };
  const payload = 'authored unvalidated numeric transport',
    hash = await sha256(payload);
  const make = async (sourceOperationId: string) => {
    const evaluationOperationId = crypto.randomUUID(),
      adapterDigest = await sha256(canonicalJson(f.adapter));
    const observations = f.adapter.mappings.map((mapping) => ({
      key: mapping.key,
      filename: `obs_${mapping.key}.npy`,
      sha256: hash,
      bytes: payload.length,
      shape: mapping.expectedShape,
      dtype: 'float64',
      declaredUnit: mapping.declaredUnit,
    }));
    const manifest = {
      schemaVersion: '1.0',
      operationId: sourceOperationId,
      inputDigest: f.fence.inputDigest,
      adapterDigest,
      executionProfile: 'runpy_main_root_v1',
      observations,
    };
    const request = {
      schemaVersion: '1.0',
      evaluationOperationId,
      sourceOperationId,
      inputDigest: f.fence.inputDigest,
      adapterDigest,
      manifest,
      mappings: f.adapter.mappings,
      maximumBytes: 100000,
      maximumElements: 100,
    };
    const report = {
      schemaVersion: '1.0',
      evaluationOperationId,
      sourceOperationId,
      inputDigest: f.fence.inputDigest,
      adapterDigest,
      validation: 'validated_numeric_structure',
      totalBytes: observations.reduce((n, o) => n + o.bytes, 0),
      totalElements: f.adapter.mappings.reduce(
        (n, m) => n + m.expectedShape.reduce((a, b) => a * b, 1),
        0,
      ),
      observations: observations.map((o) => ({
        key: o.key,
        sha256: o.sha256,
        bytes: o.bytes,
        shape: o.shape,
        dtype: 'float64',
        originalDtype: '<f8',
        conversion: 'none',
        declaredUnit: o.declaredUnit,
        elements: o.shape.reduce((a, b) => a * b, 1),
      })),
    };
    const requestDigest = 'c'.repeat(64),
      sandboxId = `validation-${evaluationOperationId}`;
    f.docs.documents.set(`operations/${evaluationOperationId}`, {
      schemaVersion: '1.0',
      id: evaluationOperationId,
      ...common,
      requestDigest,
      fence: f.fence.generation,
      outcome: 'dispatching',
      usage: null,
      providerHandle: sandboxId,
      charges: [
        {
          counterKey: 'authored',
          unit: 'seconds',
          amount: 1,
          consumeOnDispatch: false,
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    f.docs.documents.set(`sandboxTerminations/${evaluationOperationId}`, {
      schemaVersion: '1.0',
      operationId: evaluationOperationId,
      sandboxId,
      ...common,
      requestDigest,
      outcome: 'killed',
      observedAt: now,
    });
    f.docs.documents.set(`validationExecutions/${evaluationOperationId}`, {
      ownerUid: 'alice',
      operationId: evaluationOperationId,
      inputDigest: f.fence.inputDigest,
      status: 'published',
      request,
    });
    f.docs.documents.set(
      `${f.base}/numericValidations/${evaluationOperationId}`,
      {
        ...common,
        operationId: evaluationOperationId,
        sourceOperationId,
        adapterDigest,
        report,
        reportDigest: await sha256(canonicalJson(report)),
        expiresAt: '2026-10-31T00:00:00.000Z',
      },
    );
    return request;
  };
  const request = {
    schemaVersion: '1.0',
    operationId: crypto.randomUUID(),
    original: await make(original.operationId),
    adapted: await make(adapted.operationId),
  };
  const sandbox = {
    operationId: request.operationId,
    ...{
      auditId: f.fence.auditId,
      revisionId: f.fence.revisionId,
      inputDigest: f.fence.inputDigest,
    },
    role: 'evaluation',
    templateId: 'authored-evaluation',
    templateEvidenceId: crypto.randomUUID(),
    lifetimeSeconds: 60,
  };
  const requestDigest = await sha256(canonicalJson(sandbox));
  f.docs.documents.set(`operations/${request.operationId}`, {
    schemaVersion: '1.0',
    id: request.operationId,
    ...common,
    requestDigest,
    fence: f.fence.generation,
    outcome: 'reserved',
    usage: null,
    providerHandle: null,
    charges: [
      {
        counterKey: 'authored',
        unit: 'seconds',
        amount: 1,
        consumeOnDispatch: false,
      },
    ],
    createdAt: now,
    updatedAt: now,
  });
  f.docs.documents.set(`sandboxJobs/${request.operationId}`, {
    request: sandbox,
    requestDigest,
  });
  const executions = new FidelityExecutions(f.docs, f.clock);
  const dispatch = () => {
    Object.assign(f.docs.documents.get(`operations/${request.operationId}`)!, {
      outcome: 'dispatching',
      providerHandle: 'authored-comparison',
    });
    f.docs.documents.set('sandboxHandles/authored-comparison', {
      operationId: request.operationId,
      ...common,
    });
  };
  const terminate = () =>
    f.docs.documents.set(`sandboxTerminations/${request.operationId}`, {
      schemaVersion: '1.0',
      operationId: request.operationId,
      sandboxId: 'authored-comparison',
      ...common,
      requestDigest,
      outcome: 'killed',
      observedAt: now,
    });
  const result = {
    schemaVersion: '1.0',
    status: 'matched',
    comparedElements: 4,
    observations: f.adapter.mappings.map((m) => ({
      key: m.key,
      status: 'matched',
      reason: null,
    })),
  };
  return { ...f, request, executions, dispatch, terminate, result };
}
