import { z } from 'zod';
import {
  CheckId,
  Digest,
  Domain,
  EligibilityStatus,
  Id,
  SchemaVersion,
} from './common.js';

// Assertions are resolved by trusted context/adapter validation, never accepted
// directly as user/model authority. Unknown and conflicting facts stay explicit.
export const RequirementId = z.enum([
  'supported_model',
  'confirmed_units',
  'verified_adapter',
  'finite_observations',
  'thermal_weights',
  'closed_thermal_boundary',
  'no_heat_sources',
  'boundary_flux_observed',
  'heat_sources_observed',
  'time_quadrature_supported',
  'internal_time_control',
  'three_temporal_levels',
  'same_physical_horizon',
  'nested_grid_control',
  'three_spatial_levels',
  'common_coordinates',
  'temporal_error_separated',
  'matching_validated_reference',
  'reference_accuracy_verified',
  'reference_independent',
  'inertial_frame',
  'gravity_profile_confirmed',
  'positions_velocities',
  'masses_or_central_parameter',
  'complete_gravity_model',
  'isolated_mutual_gravity',
  'compatible_angular_origin',
  'bounded_trajectory_horizon',
  'resource_budget_available',
]);
export const RequirementAssertion = z
  .strictObject({
    requirement: RequirementId,
    state: z.enum(['satisfied', 'violated', 'unknown', 'conflicting']),
    evidenceIds: z.array(Id).max(20),
  })
  .superRefine((value, ctx) => {
    if (
      ['satisfied', 'violated'].includes(value.state) &&
      !value.evidenceIds.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Resolved assertions require evidence references',
      });
    if (new Set(value.evidenceIds).size !== value.evidenceIds.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate evidence reference' });
  });
export const EligibilityInput = z
  .strictObject({
    schemaVersion: SchemaVersion,
    domain: Domain,
    inputDigest: Digest,
    contextDigest: Digest,
    adapterDigest: Digest,
    assertions: z.array(RequirementAssertion).max(RequirementId.options.length),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.assertions.map((item) => item.requirement)).size !==
      value.assertions.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate requirement assertion',
      });
  });
export const EligibilityDecision = z.strictObject({
  checkId: CheckId,
  registryVersion: z.literal('0.1.0'),
  status: EligibilityStatus,
  applicability: EligibilityStatus,
  released: z.boolean(),
  reasons: z
    .array(
      z.strictObject({
        requirement: RequirementId.nullable(),
        code: z.enum([
          'missing',
          'unknown',
          'conflicting',
          'violated',
          'check_not_released',
        ]),
      }),
    )
    .max(RequirementId.options.length + 1),
});
export const EligibilityAssessment = z.strictObject({
  schemaVersion: SchemaVersion,
  domain: Domain,
  inputDigest: Digest,
  contextDigest: Digest,
  adapterDigest: Digest,
  decisions: z.array(EligibilityDecision).length(5),
});
export type RequirementId = z.infer<typeof RequirementId>;
export type RequirementAssertion = z.infer<typeof RequirementAssertion>;
export type EligibilityInput = z.infer<typeof EligibilityInput>;
export type EligibilityDecision = z.infer<typeof EligibilityDecision>;
export type EligibilityAssessment = z.infer<typeof EligibilityAssessment>;
