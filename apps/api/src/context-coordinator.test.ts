import { describe, expect, it, vi } from 'vitest';
import { ContextCoordinator } from './context-coordinator.js';
import { scanContextSource } from './context-source-reviews.js';
import { FirestoreAuditRepository } from './audit-repository.js';
import { TestDocuments } from '../test/document-store.js';

describe('connected context-stage blocking and source disclosure', () => {
  it('reports a missing Meta key without disclosing source, counting, or reserving provider credits', async () => {
    const documents = new TestDocuments();
    documents.documents.set('testers/alice', { active: true });
    const { audit } = await new FirestoreAuditRepository(documents).create(
      'alice',
      {
        schemaVersion: '1.0',
        title: 'Context connection fixture',
        domain: 'heat_diffusion',
      },
      'create',
    );
    const revision = documents.documents.get(
      `audits/${audit.id}/revisions/${audit.currentRevisionId}`,
    )!;
    Object.assign(revision, { stage: 'inspecting', status: 'running' });
    const readBatch = vi.fn(),
      fetcher = vi.fn<typeof fetch>();
    const before = documents.documents.size;
    const result = await new ContextCoordinator(
      documents,
      { readBatch },
      '',
      fetcher,
    ).run(
      'alice',
      {
        auditId: audit.id,
        revisionId: audit.currentRevisionId,
        generation: revision.generation,
        inputDigest: revision.inputDigest,
      },
      {
        countId: crypto.randomUUID(),
        operationId: crypto.randomUUID(),
        tokenEvidenceId: crypto.randomUUID(),
      },
    );
    expect(result).toMatchObject({
      status: 'blocked',
      code: 'meta_credentials_required',
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readBatch).not.toHaveBeenCalled();
    expect(documents.documents.size).toBe(before);
  });
  it('blocks suspicious credential material without returning the private value or claiming universal privacy detection', () => {
    const artifactId = crypto.randomUUID();
    const result = scanContextSource(
      artifactId,
      '# ordinary simulation\napi_key = "AUTHORED_PRIVATE_MARKER"\n-----BEGIN PRIVATE KEY-----\n',
    );
    expect(result).toEqual([
      { artifactId, code: 'credential_literal', line: 2 },
      { artifactId, code: 'private_key', line: 3 },
    ]);
    expect(JSON.stringify(result)).not.toContain('AUTHORED_PRIVATE_MARKER');
    expect(
      scanContextSource(
        artifactId,
        'import numpy as np\npositions = np.zeros((3,1,2))',
      ),
    ).toEqual([]);
  });
});
