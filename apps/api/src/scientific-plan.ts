import { z } from 'zod';
import {
  AuditPlan,
  Digest,
  EligibilityInput,
  Id,
  Timestamp,
} from '@siphon/contracts';
import { assessEligibility } from './eligibility.js';

// These methods and their limits are documented in docs/TESTING.md. They are
// descriptions of released sampled-state checks, not authority to run code.
const methods = {
  heat_diffusion: {
    id: 'fipy_discretization',
    title: 'FiPy: numerical discretization',
    url: 'https://pages.nist.gov/fipy/en/stable/numerical/discret.html',
    accessedAt: '2026-11-10T17:39:28.000Z',
  },
  orbital_dynamics: {
    id: 'rein_spiegel_ias15',
    title:
      'IAS15: A fast, adaptive, high-order integrator for gravitational dynamics',
    url: 'https://arxiv.org/html/1409.4779v2',
    accessedAt: '2026-11-10T17:39:28.000Z',
  },
} as const;

const profiles = {
  heat_energy_si: ['H_ENERGY'],
  central_orbit_si: ['O_ENERGY', 'O_ANGULAR'],
  isolated_orbits_si: ['O_ENERGY', 'O_ANGULAR', 'O_MOMENTUM'],
} as const;

const descriptions: Record<
  string,
  { procedure: string; observations: string[] }
> = {
  H_ENERGY: {
    procedure:
      'Measure the change in volume-weighted thermal energy at reported samples for the declared closed, source-free model.',
    observations: ['times', 'temperature', 'thermal_weights'],
  },
  H_BALANCE: {
    procedure: 'Thermal balance is not released.',
    observations: [
      'times',
      'temperature',
      'thermal_weights',
      'source_power',
      'outward_power',
    ],
  },
  H_TIME_REF: {
    procedure: 'Time refinement is not released.',
    observations: [],
  },
  H_GRID_REF: {
    procedure: 'Grid refinement is not released.',
    observations: [],
  },
  H_REFERENCE: {
    procedure: 'Reference-solution comparison is not released.',
    observations: [],
  },
  O_ENERGY: {
    procedure:
      'Measure energy drift at the reported orbital states under the declared gravity model.',
    observations: ['times', 'positions', 'velocities'],
  },
  O_ANGULAR: {
    procedure:
      'Measure angular momentum drift at the reported orbital states under the declared coordinate convention.',
    observations: ['times', 'positions', 'velocities'],
  },
  O_MOMENTUM: {
    procedure:
      'Measure linear momentum drift at the reported orbital states for an isolated mutual-gravity model.',
    observations: ['times', 'velocities', 'masses'],
  },
  O_REFINE: {
    procedure: 'Orbital time refinement is not released.',
    observations: [],
  },
  O_REFERENCE: {
    procedure: 'Orbital reference-solution comparison is not released.',
    observations: [],
  },
};

const Input = z.strictObject({
  planId: Id,
  auditId: Id,
  revisionId: Id,
  eligibilityInput: EligibilityInput,
  profile: z.enum(['heat_energy_si', 'central_orbit_si', 'isolated_orbits_si']),
  sourceOperationId: Id,
  sourceOutputDigest: Digest,
  createdAt: Timestamp,
});

/** Internal planner. The caller must resolve the eligibility assertions,
 * resource reservation, source provenance and profile against current server
 * records. This pure function cannot establish those facts or authorize work. */
export function buildScientificPlan(value: unknown): AuditPlan {
  const input = Input.parse(value);
  const assessment = assessEligibility(input.eligibilityInput);
  const allowed = profiles[input.profile] as readonly string[];
  const selected = assessment.decisions.filter(
    (decision) => decision.status === 'eligible',
  );
  if (!selected.length)
    throw new Error('No scientifically eligible checks are ready to plan');
  if (selected.some((decision) => !allowed.includes(decision.checkId)))
    throw new Error(
      'Selected checks do not match the confirmed evaluation profile',
    );
  const reference = methods[assessment.domain];
  const checks = assessment.decisions.map((decision) => {
    const description = descriptions[decision.checkId];
    if (!description) throw new Error('Check definition is unavailable');
    const isSelected = decision.status === 'eligible';
    return {
      checkId: decision.checkId,
      checkVersion: decision.registryVersion,
      selection: isSelected
        ? ('selected' as const)
        : decision.status === 'ineligible'
          ? ('excluded' as const)
          : ('unresolved' as const),
      reasons: isSelected
        ? [
            'Recorded prerequisites are satisfied; applicability remains conditional on the declared model and mappings.',
          ]
        : decision.reasons.map((reason) =>
            reason.requirement
              ? `${reason.requirement}: ${reason.code}`
              : reason.code,
          ),
      procedure: description.procedure,
      requiredObservations:
        isSelected && decision.checkId.startsWith('O_')
          ? [
              ...new Set([
                ...description.observations,
                ...(input.profile === 'central_orbit_si'
                  ? ['central_mu']
                  : ['masses', 'gravity_constant']),
              ]),
            ]
          : description.observations,
      accuracyPolicy: isSelected
        ? 'No accuracy target was provided. Results without a supported target remain inconclusive.'
        : 'No evaluation is scheduled.',
      referenceIds: isSelected ? [reference.id] : [],
      experimentIds: isSelected ? [input.sourceOperationId] : [],
    };
  });
  const accuracyPolicies = Object.fromEntries(
    selected.map((item) => [
      item.checkId,
      { scope: 'reported_samples', target: null },
    ]),
  );
  return AuditPlan.parse({
    schemaVersion: '1.0',
    id: input.planId,
    auditId: input.auditId,
    revisionId: input.revisionId,
    inputDigest: assessment.inputDigest,
    domain: assessment.domain,
    contextDigest: assessment.contextDigest,
    adapterDigest: assessment.adapterDigest,
    registryVersion: '0.1.0',
    assessment,
    checks,
    experiments: [
      {
        id: input.sourceOperationId,
        description:
          'Stored adapted baseline observations compared with the original extraction.',
        status: 'completed',
        controls: [],
        sourceOperationId: input.sourceOperationId,
        resultDigest: input.sourceOutputDigest,
      },
    ],
    accuracyPolicies,
    references: [reference],
    createdAt: input.createdAt,
  });
}
