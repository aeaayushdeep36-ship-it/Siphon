import { z } from 'zod';
import {
  Audit,
  AuditHistoryResponse,
  Id,
  RevisionHistoryResponse,
  Timestamp,
} from '@siphon/contracts';
import { type FirestoreClient, type DocumentStore } from './firestore.js';
import { authorize, stateFrom } from './audit-commands.js';
import { ApiError } from './errors.js';

const Cursor = z.strictObject({
  schemaVersion: z.literal('1.0'),
  uid: z.string(),
  auditId: Id.nullable(),
  createdAt: Timestamp,
  id: Id,
});
export class HistoryRepository {
  constructor(
    private readonly documents: DocumentStore,
    private readonly queries: Pick<FirestoreClient, 'history'>,
  ) {}
  async list(
    uid: string,
    auditId: string | null,
    limitValue: string | undefined,
    cursorValue: string | undefined,
  ) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid))
      throw new ApiError(
        403,
        'unsupported_identity',
        'Identity cannot access this service.',
      );
    if (auditId !== null) Id.parse(auditId);
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new ApiError(422, 'invalid_limit', 'Use a limit between 1 and 20.');
    let cursor: z.infer<typeof Cursor> | null = null;
    if (cursorValue !== undefined) {
      try {
        if (cursorValue.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(cursorValue))
          throw new Error('Invalid cursor');
        cursor = Cursor.parse(
          JSON.parse(
            atob(cursorValue.replaceAll('-', '+').replaceAll('_', '/')),
          ),
        );
        if (cursor.uid !== uid || cursor.auditId !== auditId)
          throw new Error('Wrong cursor scope');
      } catch {
        throw new ApiError(
          422,
          'invalid_cursor',
          'History cursor is not valid for this request.',
        );
      }
    }
    await this.documents.transaction(async (tx) => {
      if (auditId !== null) await authorize(tx, uid, auditId, false);
      else if ((await tx.get(`testers/${uid}`))?.active !== true)
        throw new ApiError(
          403,
          'invitation_required',
          'An active invitation is required.',
        );
    });
    const rows = await this.queries.history(uid, auditId, limit, cursor);
    // Reauthorize after query so a stale invitation/audit snapshot cannot publish history.
    return this.documents.transaction(async (tx) => {
      if (auditId !== null) await authorize(tx, uid, auditId, false);
      else if ((await tx.get(`testers/${uid}`))?.active !== true)
        throw new ApiError(
          403,
          'invitation_required',
          'An active invitation is required.',
        );
      const selected = rows.slice(0, limit),
        last = selected.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? btoa(
              JSON.stringify(
                Cursor.parse({
                  schemaVersion: '1.0',
                  uid,
                  auditId,
                  createdAt: last.createdAt,
                  id: auditId === null ? last.id : last.revisionId,
                }),
              ),
            )
              .replaceAll('+', '-')
              .replaceAll('/', '_')
              .replaceAll('=', '')
          : null;
      if (auditId === null)
        return AuditHistoryResponse.parse({
          schemaVersion: '1.0',
          audits: selected.map((row) => Audit.parse(row)),
          nextCursor,
        });
      return RevisionHistoryResponse.parse({
        schemaVersion: '1.0',
        revisions: selected.map((row) => ({
          revisionId: stateFrom(row).revisionId,
          stage: stateFrom(row).stage,
          status: stateFrom(row).status,
          createdAt: Timestamp.parse(row.createdAt),
          reportId: row.reportId ?? null,
        })),
        nextCursor,
      });
    });
  }
}
