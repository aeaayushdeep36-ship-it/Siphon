import { z } from 'zod';
import { AuditPlan, Count, Digest, Id, Timestamp } from '@siphon/contracts';
import { type DocumentStore } from './firestore.js';
import {
  authorize,
  DispatchFence,
  requireActiveRevision,
} from './audit-commands.js';
import { canonicalJson, sha256 } from './hashing.js';

export const HeatParameterValues = z.strictObject({
  densityKgM3: z.number().finite().positive(),
  heatCapacityJKgK: z.number().finite().positive(),
});
export const SubmitHeatParameters = z.strictObject({
  schemaVersion: z.literal('1.0'),
  expectedGeneration: Count,
  expectedInputDigest: Digest,
  planDigest: Digest,
  parameters: HeatParameterValues,
});

/** These are explicit user declarations, not values verified from source. */
export class ScientificParameters {
  constructor(
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async submitHeat(
    uid: string,
    auditId: string,
    revisionId: string,
    value: unknown,
  ) {
    Id.parse(auditId);
    Id.parse(revisionId);
    const input = SubmitHeatParameters.parse(value);
    const fence = DispatchFence.parse({
      auditId,
      revisionId,
      generation: input.expectedGeneration,
      inputDigest: input.expectedInputDigest,
    });
    const base = `audits/${auditId}/revisions/${revisionId}`;
    return this.store.transaction(async (tx) => {
      const audit = await authorize(tx, uid, auditId, false);
      const state = await requireActiveRevision(tx, uid, fence);
      const [rawPlan, prior] = await tx.getMany([
        `${base}/plans/current`,
        `${base}/scientificParameters/current`,
      ]);
      const plan = AuditPlan.parse(rawPlan?.plan);
      const digest = await sha256(canonicalJson(input.parameters));
      if (
        state.stage !== 'adapting' ||
        audit.domain !== 'heat_diffusion' ||
        rawPlan?.ownerUid !== uid ||
        rawPlan.auditId !== auditId ||
        rawPlan.revisionId !== revisionId ||
        rawPlan.inputDigest !== fence.inputDigest ||
        plan.auditId !== auditId ||
        plan.revisionId !== revisionId ||
        plan.inputDigest !== fence.inputDigest ||
        plan.domain !== audit.domain ||
        rawPlan.planDigest !== input.planDigest ||
        input.planDigest !== (await sha256(canonicalJson(plan))) ||
        Date.parse(Timestamp.parse(rawPlan.expiresAt)) <=
          this.clock().getTime() ||
        !plan.checks.some(
          (check) =>
            check.checkId === 'H_ENERGY' && check.selection === 'selected',
        )
      )
        throw new Error('Heat parameter plan changed');
      if (prior) {
        if (
          prior.ownerUid !== uid ||
          prior.auditId !== auditId ||
          prior.revisionId !== revisionId ||
          prior.inputDigest !== fence.inputDigest ||
          prior.planDigest !== input.planDigest ||
          prior.parametersDigest !== digest ||
          canonicalJson(prior.parameters) !== canonicalJson(input.parameters)
        )
          throw new Error('Heat parameters are immutable for this plan');
        return { schemaVersion: '1.0' as const, replayed: true };
      }
      tx.set(`${base}/scientificParameters/current`, {
        schemaVersion: '1.0',
        ownerUid: uid,
        auditId,
        revisionId,
        inputDigest: fence.inputDigest,
        planDigest: input.planDigest,
        parameters: input.parameters,
        parametersDigest: digest,
        declaration: 'user_supplied',
        createdAt: this.clock(),
      });
      return { schemaVersion: '1.0' as const, replayed: false };
    });
  }
}
