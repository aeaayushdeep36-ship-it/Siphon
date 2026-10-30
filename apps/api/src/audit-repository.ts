import { Audit, CreateAudit, DEFAULT_POLICY } from '@siphon/contracts';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { type DocumentStore } from './firestore.js';
import { canonicalJson, sha256 } from './hashing.js';

export interface AuditRepository {
  isInvited(uid: string): Promise<boolean>;
  create(
    uid: string,
    input: CreateAudit,
    idempotencyKey: string,
  ): Promise<{ audit: Audit; replayed: boolean }>;
  getOwned(uid: string, id: string): Promise<Audit>;
}

function uidPath(uid: string): string {
  // Google-generated Firebase UIDs use these characters; reject path-bearing custom UIDs.
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid))
    throw new ApiError(
      403,
      'unsupported_identity',
      'Identity cannot access this service.',
    );
  return uid;
}

export class FirestoreAuditRepository implements AuditRepository {
  constructor(
    private readonly client: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async isInvited(uid: string): Promise<boolean> {
    const tester = await this.client.get(`testers/${uidPath(uid)}`);
    return tester?.active === true;
  }

  async getOwned(uid: string, id: string): Promise<Audit> {
    if (!(await this.isInvited(uid)))
      throw new ApiError(
        403,
        'invitation_required',
        'An active invitation is required.',
      );
    const record = await this.client.get(`audits/${id}`);
    if (
      !record ||
      record.ownerUid !== uid ||
      record.deletionRequestedAt !== null
    )
      throw new ApiError(404, 'not_found', 'Audit was not found.');
    return Audit.parse(record);
  }

  async create(
    uid: string,
    value: CreateAudit,
    idempotencyKey: string,
  ): Promise<{ audit: Audit; replayed: boolean }> {
    uidPath(uid);
    const input = CreateAudit.parse(value);
    const digest = await sha256(canonicalJson(input));
    // Scope the key by owner and route. No raw authorization token or idempotency key is stored.
    const requestId = await sha256(
      canonicalJson({ uid, route: 'POST /audits', key: idempotencyKey }),
    );
    const id = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = this.clock();
    const emptyInputDigest = await sha256(
      canonicalJson({ uploads: [], answers: [] }),
    );
    return this.client.transaction(async (tx) => {
      const tester = await tx.get(`testers/${uid}`);
      if (tester?.active !== true)
        throw new ApiError(
          403,
          'invitation_required',
          'An active invitation is required.',
        );
      const previous = await tx.get(`requests/${requestId}`);
      if (previous) {
        if (previous.requestDigest !== digest)
          throw new ApiError(
            409,
            'idempotency_conflict',
            'This key was already used with different input.',
          );
        const auditId = z.string().uuid().parse(previous.auditId);
        const record = await tx.get(`audits/${auditId}`);
        if (
          !record ||
          record.ownerUid !== uid ||
          record.deletionRequestedAt !== null
        )
          throw new ApiError(404, 'not_found', 'Audit was not found.');
        return { audit: Audit.parse(record), replayed: true };
      }
      const audit: Audit = {
        schemaVersion: '1.0',
        id,
        ownerUid: uid,
        title: input.title,
        domain: input.domain,
        currentRevisionId: revisionId,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        deletionRequestedAt: null,
      };
      tx.set(`audits/${id}`, { ...audit, createdAt: now, updatedAt: now });
      tx.set(`audits/${id}/revisions/${revisionId}`, {
        schemaVersion: '1.0',
        auditId: id,
        revisionId,
        parentRevisionId: null,
        ownerUid: uid,
        stage: 'draft',
        status: 'idle',
        generation: 0,
        inputDigest: emptyInputDigest,
        sourceManifest: [],
        answers: [],
        policy: DEFAULT_POLICY,
        cancellationRequestedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      tx.set(`requests/${requestId}`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        requestDigest: digest,
        auditId: id,
        createdAt: now,
        updatedAt: now,
      });
      return { audit, replayed: false };
    });
  }
}
