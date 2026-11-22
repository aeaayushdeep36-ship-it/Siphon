import { z } from 'zod';
import {
  CheckId,
  Digest,
  Domain,
  Finite,
  Id,
  SchemaVersion,
  Timestamp,
} from './common.js';
import { EligibilityAssessment } from './eligibility.js';
import { MetricEvidence } from './evidence.js';
import { EvidenceReport, ReportCheck, ReportExperiment } from './reports.js';

export const SampledAccuracyPolicy = z.strictObject({
  scope: z.literal('reported_samples'),
  target: MetricEvidence.shape.target,
  quadratureUncertaintyBound: Finite.nonnegative().optional(),
});

/** Reviewed deterministic plan. Schema validation does not establish the truth
 * of assertions or release a method; the server resolves those prerequisites.
 */
export const AuditPlan = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: Id,
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    domain: Domain,
    contextDigest: Digest,
    adapterDigest: Digest,
    registryVersion: z.literal('0.1.0'),
    assessment: EligibilityAssessment,
    checks: z.array(ReportCheck.omit({ metricEvidenceIds: true })).length(5),
    experiments: z.array(ReportExperiment).max(8),
    accuracyPolicies: z.partialRecord(CheckId, SampledAccuracyPolicy),
    references: EvidenceReport.shape.references,
    createdAt: Timestamp,
  })
  .superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (
      plan.assessment.domain !== plan.domain ||
      plan.assessment.inputDigest !== plan.inputDigest ||
      plan.assessment.contextDigest !== plan.contextDigest ||
      plan.assessment.adapterDigest !== plan.adapterDigest
    )
      fail('Plan assessment snapshot mismatch');
    if (
      new Set(plan.checks.map((item) => item.checkId)).size !==
        plan.checks.length ||
      new Set(plan.assessment.decisions.map((item) => item.checkId)).size !==
        plan.checks.length ||
      new Set(plan.experiments.map((item) => item.id)).size !==
        plan.experiments.length ||
      new Set(plan.references.map((item) => item.id)).size !==
        plan.references.length
    )
      fail('Duplicate plan identity');
    const experiments = new Set(plan.experiments.map((item) => item.id));
    const methods = new Set(plan.references.map((item) => item.id));
    for (const check of plan.checks) {
      const decision = plan.assessment.decisions.find(
        (item) => item.checkId === check.checkId,
      );
      if (
        !decision ||
        decision.registryVersion !== plan.registryVersion ||
        (plan.domain === 'heat_diffusion') !== check.checkId.startsWith('H_') ||
        (check.selection === 'selected' && decision.status !== 'eligible') ||
        (check.selection === 'unresolved' && decision.status !== 'unresolved') ||
        (check.selection === 'excluded' && decision.status === 'unresolved') ||
        (check.selection === 'selected' &&
          (!decision.released ||
            !check.experimentIds.length ||
            !check.referenceIds.length))
      )
        fail('Plan selection contradicts eligibility');
      if (check.selection !== 'selected' && check.experimentIds.length)
        fail('Unselected check cannot schedule experiments');
      if (
        check.experimentIds.some((id) => !experiments.has(id)) ||
        check.referenceIds.some((id) => !methods.has(id))
      )
        fail('Unresolved plan reference');
    }
  });
export type AuditPlan = z.infer<typeof AuditPlan>;
