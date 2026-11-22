import {
  EligibilityAssessment,
  EligibilityInput,
  RequirementId,
  type Domain,
  type EligibilityDecision,
  type RequirementAssertion,
} from '@siphon/contracts';

const common = [
  'supported_model',
  'confirmed_units',
  'verified_adapter',
  'finite_observations',
  'resource_budget_available',
] as const;
const temporal = [
  'internal_time_control',
  'three_temporal_levels',
  'same_physical_horizon',
  'common_coordinates',
] as const;
const orbit = [
  'inertial_frame',
  'gravity_profile_confirmed',
  'positions_velocities',
  'masses_or_central_parameter',
] as const;
const reference = [
  'matching_validated_reference',
  'reference_accuracy_verified',
  'reference_independent',
] as const;

type Definition = Readonly<{
  checkId: EligibilityDecision['checkId'];
  domain: Domain;
  requirements: readonly RequirementId[];
  released: boolean;
}>;

// Four data-only sampled-state conservation evaluators are validated. Their
// criterion is drift at reported samples, not physical or trajectory accuracy.
// The remaining check families retain their scientific release gates.
const definitions: readonly Definition[] = [
  {
    checkId: 'H_ENERGY',
    domain: 'heat_diffusion',
    released: true,
    requirements: [
      ...common,
      'thermal_weights',
      'closed_thermal_boundary',
      'no_heat_sources',
    ],
  },
  {
    checkId: 'H_BALANCE',
    domain: 'heat_diffusion',
    released: true,
    requirements: [
      ...common,
      'thermal_weights',
      'boundary_flux_observed',
      'heat_sources_observed',
      'time_quadrature_supported',
    ],
  },
  {
    checkId: 'H_TIME_REF',
    domain: 'heat_diffusion',
    released: false,
    requirements: [...common, ...temporal],
  },
  {
    checkId: 'H_GRID_REF',
    domain: 'heat_diffusion',
    released: false,
    requirements: [
      ...common,
      'nested_grid_control',
      'three_spatial_levels',
      'common_coordinates',
      'same_physical_horizon',
      'temporal_error_separated',
    ],
  },
  {
    checkId: 'H_REFERENCE',
    domain: 'heat_diffusion',
    released: false,
    requirements: [
      ...common,
      ...reference,
      'common_coordinates',
      'same_physical_horizon',
    ],
  },
  {
    checkId: 'O_ENERGY',
    domain: 'orbital_dynamics',
    released: true,
    requirements: [...common, ...orbit, 'complete_gravity_model'],
  },
  {
    checkId: 'O_ANGULAR',
    domain: 'orbital_dynamics',
    released: true,
    requirements: [
      ...common,
      ...orbit,
      'complete_gravity_model',
      'compatible_angular_origin',
    ],
  },
  {
    checkId: 'O_MOMENTUM',
    domain: 'orbital_dynamics',
    released: true,
    requirements: [
      ...common,
      ...orbit,
      'complete_gravity_model',
      'isolated_mutual_gravity',
    ],
  },
  {
    checkId: 'O_REFINE',
    domain: 'orbital_dynamics',
    released: false,
    requirements: [
      ...common,
      ...orbit,
      ...temporal,
      'bounded_trajectory_horizon',
    ],
  },
  {
    checkId: 'O_REFERENCE',
    domain: 'orbital_dynamics',
    released: false,
    requirements: [
      ...common,
      ...orbit,
      ...reference,
      'same_physical_horizon',
      'common_coordinates',
      'bounded_trajectory_horizon',
    ],
  },
];

/** Pure conjunction with three-valued outcomes; no AI, thresholds or I/O.
 * An explicit violation outweighs unknowns, but every reason is retained.
 */
export function evaluateRequirements(
  requirements: readonly RequirementId[],
  assertions: readonly RequirementAssertion[],
): Pick<EligibilityDecision, 'applicability' | 'reasons'> {
  // Validate through the same boundary even when invoked independently.
  const validated = EligibilityInput.shape.assertions.parse(assertions);
  if (
    new Set(validated.map((item) => item.requirement)).size !== validated.length
  )
    throw new Error('Duplicate requirement assertion');
  const facts = new Map(validated.map((item) => [item.requirement, item]));
  const reasons: EligibilityDecision['reasons'] = [];
  for (const requirement of new Set(requirements)) {
    RequirementId.parse(requirement);
    const assertion = facts.get(requirement);
    if (!assertion) reasons.push({ requirement, code: 'missing' });
    else if (assertion.state !== 'satisfied')
      reasons.push({ requirement, code: assertion.state });
  }
  return {
    applicability: reasons.some((reason) => reason.code === 'violated')
      ? 'ineligible'
      : reasons.length
        ? 'unresolved'
        : 'eligible',
    reasons,
  };
}

/** Internal-only: callers must resolve every evidence ID against this exact
 * owner/revision/context/adapter snapshot. Schema validity is not provenance.
 * This assessment is not an executable CheckPlan or a dispatch authorization.
 */
export function assessEligibility(value: unknown): EligibilityAssessment {
  const input = EligibilityInput.parse(value);
  const decisions = definitions
    .filter((entry) => entry.domain === input.domain)
    .map((entry) => {
      const result = evaluateRequirements(entry.requirements, input.assertions);
      return {
        checkId: entry.checkId,
        registryVersion: '0.1.0' as const,
        applicability: result.applicability,
        status: entry.released ? result.applicability : ('ineligible' as const),
        released: entry.released,
        reasons: entry.released
          ? result.reasons
          : [
              ...result.reasons,
              {
                requirement: null,
                code: 'check_not_released' as const,
              },
            ],
      };
    });
  return EligibilityAssessment.parse({
    schemaVersion: '1.0',
    domain: input.domain,
    inputDigest: input.inputDigest,
    contextDigest: input.contextDigest,
    adapterDigest: input.adapterDigest,
    decisions,
  });
}
