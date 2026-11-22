import { z } from 'zod';
import { CheckId, Digest, Id, SchemaVersion } from './common.js';
import {
  DiagnosticJobRequest,
  DiagnosticJobResult,
  validateDiagnosticJobResult,
} from './diagnostics.js';
import { EligibilityAssessment } from './eligibility.js';
import { MetricEvidence } from './evidence.js';
import { SampledAccuracyPolicy } from './plans.js';

const profileChecks = {
  heat_energy_si: ['H_ENERGY'],
  heat_balance_si: ['H_BALANCE'],
  central_orbit_si: ['O_ENERGY', 'O_ANGULAR'],
  isolated_orbits_si: ['O_ENERGY', 'O_ANGULAR', 'O_MOMENTUM'],
} as const;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

export const ConservationJobRequest = z
  .strictObject({
    schemaVersion: SchemaVersion,
    diagnostic: DiagnosticJobRequest,
    eligibility: EligibilityAssessment,
    planDigest: Digest,
    evidenceIds: z.partialRecord(CheckId, Id),
    policies: z.partialRecord(CheckId, SampledAccuracyPolicy),
  })
  .superRefine((request, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const { diagnostic: d, eligibility: a } = request;
    const heat = d.profile.kind.startsWith('heat_');
    const expectedDomain = heat ? 'heat_diffusion' : 'orbital_dynamics';
    if (
      a.domain !== expectedDomain ||
      a.inputDigest !== d.validation.inputDigest ||
      a.contextDigest !== d.contextDigest ||
      a.adapterDigest !== d.validation.adapterDigest
    )
      fail('Conservation assessment snapshot mismatch');
    if (
      new Set(a.decisions.map((item) => item.checkId)).size !== 5 ||
      a.decisions.some((item) => heat !== item.checkId.startsWith('H_'))
    )
      fail('Conservation assessment domain mismatch');
    for (const decision of a.decisions)
      if (
        decision.status === 'eligible' &&
        (!decision.released ||
          decision.applicability !== 'eligible' ||
          decision.reasons.length)
      )
        fail('Unreleased or unresolved method cannot execute');
    const selected = a.decisions
      .filter(
        (item) =>
          item.status === 'eligible' &&
          (profileChecks[d.profile.kind] as readonly string[]).includes(
            item.checkId,
          ),
      )
      .map((item) => item.checkId)
      .sort();
    if (
      canonical(Object.keys(request.evidenceIds).sort()) !==
        canonical(selected) ||
      canonical(Object.keys(request.policies).sort()) !== canonical(selected) ||
      new Set(Object.values(request.evidenceIds)).size !== selected.length
    )
      fail(
        'Conservation policy/evidence identities must match selected profile checks',
      );
  });
export type ConservationJobRequest = z.infer<typeof ConservationJobRequest>;
export const ConservationJobResult = z.strictObject({
  schemaVersion: SchemaVersion,
  diagnostics: DiagnosticJobResult,
  evidence: z.array(MetricEvidence).max(3),
});
export type ConservationJobResult = z.infer<typeof ConservationJobResult>;

/** Validate exact measured values and supported target/roundoff provenance;
 * ownership, genuine execution and plan release remain server gate obligations.
 */
export function validateConservationJobResult(
  value: unknown,
  requestValue: unknown,
) {
  const request = ConservationJobRequest.parse(requestValue);
  const result = ConservationJobResult.parse(value);
  const d = validateDiagnosticJobResult(result.diagnostics, request.diagnostic);
  const profile = profileChecks[d.profile.kind] as readonly string[];
  const expected = Object.keys(request.evidenceIds);
  if (
    result.evidence.length !== expected.length ||
    new Set(result.evidence.map((item) => item.checkId)).size !==
      expected.length
  )
    throw new Error('Conservation evidence set mismatch');
  for (const evidence of result.evidence) {
    const index = profile.indexOf(evidence.checkId),
      metric = d.metrics[index];
    const policy = request.policies[evidence.checkId];
    if (
      !metric ||
      !policy ||
      evidence.id !== request.evidenceIds[evidence.checkId] ||
      evidence.auditId !== d.auditId ||
      evidence.revisionId !== d.revisionId ||
      evidence.inputDigest !== d.inputDigest ||
      evidence.contextDigest !== d.contextDigest ||
      evidence.adapterDigest !== d.adapterDigest ||
      evidence.planDigest !== request.planDigest ||
      evidence.checkVersion !== '0.1.0' ||
      canonical(evidence.experimentIds) !== canonical([d.sourceOperationId]) ||
      canonical(evidence.metric) !==
        canonical({
          name: metric.name,
          value: metric.value,
          unit: metric.unit,
          normalization: metric.normalization,
        }) ||
      canonical(evidence.target) !== canonical(policy.target)
    )
      throw new Error('Conservation metric snapshot mismatch');
    const quadratureBound = policy.quadratureUncertaintyBound ?? 0;
    const expectedBound =
      metric.arithmetic !== null
        ? metric.arithmetic.absoluteUncertaintyBound + quadratureBound
        : null;
    if (
      metric.arithmetic === null
        ? evidence.uncertainty !== null
        : !evidence.uncertainty ||
          Math.abs(evidence.uncertainty.value - expectedBound!) > 1e-12 ||
          evidence.uncertainty.unit !== metric.unit ||
          canonical(evidence.uncertainty.evidenceIds) !==
            canonical([d.operationId])
    )
      throw new Error('Conservation uncertainty provenance mismatch');
  }
  return result;
}
