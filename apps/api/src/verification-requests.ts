import { z } from 'zod';
import { type Identity } from './auth.js';
import { ApiError } from './errors.js';
import { type DocumentStore } from './firestore.js';

export const ADMIN_EMAIL = 'aeaayushdeep36@gmail.com';

export function isAdminIdentity(identity: Identity): boolean {
  return (
    identity.email?.toLowerCase() === ADMIN_EMAIL &&
    identity.emailVerified === true
  );
}

export const SubmitVerificationRequest = z.strictObject({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^[+0-9()\s-]{5,32}$/, 'Enter a valid phone number.'),
});

export const VerificationRequestRecord = z.strictObject({
  schemaVersion: z.literal('1.0'),
  uid: z.string().min(1).max(128),
  email: z.string().email().max(320),
  name: z.string().min(1).max(120),
  phone: z.string().min(5).max(32),
  emailVerified: z.boolean(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});
export type VerificationRequestRecord = z.infer<typeof VerificationRequestRecord>;

export interface CollectionLister {
  listCollection(
    collection: string,
    pageSize?: number,
  ): Promise<Array<{ id: string; data: Record<string, unknown> }>>;
}

function uidPath(uid: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(uid))
    throw new ApiError(
      403,
      'unsupported_identity',
      'Identity cannot access this service.',
    );
  return uid;
}

export class VerificationRequestRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly lister: CollectionLister,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async submit(
    identity: Identity,
    rawInput: unknown,
  ): Promise<VerificationRequestRecord> {
    const uid = uidPath(identity.uid);
    const input = SubmitVerificationRequest.parse(rawInput);
    if (!identity.email)
      throw new ApiError(
        422,
        'email_required',
        'A verified email address is required.',
      );
    const now = this.clock().toISOString();
    const path = `verificationRequests/${uid}`;
    return this.store.transaction(async (tx) => {
      const existingRaw = await tx.get(path);
      const existing = existingRaw
        ? VerificationRequestRecord.safeParse(existingRaw)
        : null;
      const next: VerificationRequestRecord =
        existing?.success && existing.data.status === 'approved'
          ? {
              ...existing.data,
              name: input.name,
              phone: input.phone,
              email: identity.email!,
              emailVerified: Boolean(identity.emailVerified),
              updatedAt: now,
            }
          : {
              schemaVersion: '1.0',
              uid,
              email: identity.email!,
              name: input.name,
              phone: input.phone,
              emailVerified: Boolean(identity.emailVerified),
              status: 'pending',
              createdAt:
                existing?.success ? existing.data.createdAt : now,
              updatedAt: now,
              reviewedBy: null,
              reviewedAt: null,
            };
      tx.set(path, next);
      return next;
    });
  }

  async getStatus(identity: Identity): Promise<{
    status: 'approved' | 'pending' | 'rejected' | 'unregistered';
    emailVerified: boolean;
    isAdmin: boolean;
    request: VerificationRequestRecord | null;
  }> {
    const uid = uidPath(identity.uid);
    const [tester, reqRaw] = await this.store.getMany([
      `testers/${uid}`,
      `verificationRequests/${uid}`,
    ]);
    const parsedReq = reqRaw
      ? VerificationRequestRecord.safeParse(reqRaw)
      : null;
    const request = parsedReq?.success ? parsedReq.data : null;
    const isAdmin = isAdminIdentity(identity);
    if (tester?.active === true) {
      return {
        status: 'approved',
        emailVerified: Boolean(identity.emailVerified),
        isAdmin,
        request,
      };
    }
    return {
      status: request ? request.status : 'unregistered',
      emailVerified: Boolean(identity.emailVerified),
      isAdmin,
      request,
    };
  }

  async listAll(identity: Identity): Promise<VerificationRequestRecord[]> {
    if (!isAdminIdentity(identity))
      throw new ApiError(
        403,
        'forbidden',
        'Admin access is restricted to the authorized administrator.',
      );
    const rows = await this.lister.listCollection('verificationRequests', 200);
    const records: VerificationRequestRecord[] = [];
    for (const row of rows) {
      const parsed = VerificationRequestRecord.safeParse(row.data);
      if (parsed.success) records.push(parsed.data);
    }
    const order: Record<VerificationRequestRecord['status'], number> = {
      pending: 0,
      approved: 1,
      rejected: 2,
    };
    records.sort((a, b) => {
      if (order[a.status] !== order[b.status])
        return order[a.status] - order[b.status];
      return b.createdAt.localeCompare(a.createdAt);
    });
    return records;
  }

  async review(
    identity: Identity,
    targetUid: string,
    decision: 'approved' | 'rejected',
  ): Promise<VerificationRequestRecord> {
    if (!isAdminIdentity(identity))
      throw new ApiError(
        403,
        'forbidden',
        'Admin access is restricted to the authorized administrator.',
      );
    const uid = uidPath(targetUid);
    const now = this.clock().toISOString();
    return this.store.transaction(async (tx) => {
      const reqPath = `verificationRequests/${uid}`;
      const existingRaw = await tx.get(reqPath);
      if (!existingRaw)
        throw new ApiError(
          404,
          'not_found',
          'Verification request was not found.',
        );
      const existing = VerificationRequestRecord.parse(existingRaw);
      const updated: VerificationRequestRecord = {
        ...existing,
        status: decision,
        reviewedBy: identity.email ?? ADMIN_EMAIL,
        reviewedAt: now,
        updatedAt: now,
      };
      tx.set(reqPath, updated);
      tx.set(`testers/${uid}`, {
        active: decision === 'approved',
        email: existing.email,
        name: existing.name,
        phone: existing.phone,
        reviewedBy: identity.email ?? ADMIN_EMAIL,
        reviewedAt: now,
      });
      return updated;
    });
  }
}
