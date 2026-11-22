import { describe, expect, it } from 'vitest';
import { buildContextQuestions } from './context-questions.js';
import {
  buildOrbitalCoordinatesQuestions,
  buildScientificEligibility,
  buildThermalGeometryQuestions,
} from './scientific-context.js';
import type { Domain } from '@siphon/contracts';

function fixture(domain: Domain = 'orbital_dynamics') {
  const snapshot = {
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    adapterDigest: 'c'.repeat(64),
    domain,
  };
  const questionBasis = buildContextQuestions(snapshot);
  const selected: Record<string, string> = {
    units: 'si',
    dimensions: 'two',
    time_control: 'internal',
    thermal_model: 'constant_cartesian',
    thermal_boundary: 'periodic',
    heat_sources: 'none',
    thermal_quadrature: 'piecewise_linear_or_constant',
    gravity_profile: 'fixed_central',
    additional_forces: 'none',
    reference_frame: 'inertial',
    gravity_parameters: 'central_mu',
  };
  const answers = questionBasis.questions.map((question) => ({
    schemaVersion: '1.0' as const,
    questionId: question.id,
    selectedOptionId: selected[question.requiredFacts[0]!]!,
    customText: '',
  }));
  const specs: Array<[string, number[], string]> =
    domain === 'heat_diffusion'
      ? [
          ['times', [3], 's'],
          ['temperature', [3, 2, 2], 'K'],
          ['thermal_weights', [2, 2], 'm^3'],
        ]
      : [
          ['times', [3], 's'],
          ['positions', [3, 1, 2], 'm'],
          ['velocities', [3, 1, 2], 'm/s'],
          ['central_mu', [], 'm^3/s^2'],
        ];
  const adapter = {
    schemaVersion: '1.0',
    auditId: snapshot.auditId,
    revisionId: snapshot.revisionId,
    inputDigest: snapshot.inputDigest,
    contextDigest: snapshot.contextDigest,
    domain: snapshot.domain,
    sourceArtifactId: crypto.randomUUID(),
    sourceDigest: 'd'.repeat(64),
    handler: 'script_globals_v1',
    mappings: specs.map(([key, expectedShape, declaredUnit]) => ({
      key,
      root: key,
      steps: [],
      expectedShape,
      axisOrder: expectedShape.map((_, i) => i),
      declaredUnit,
    })),
  };
  const observations = specs.map(([key, shape, declaredUnit]) => ({
    key,
    shape,
    declaredUnit,
    sha256: 'e'.repeat(64),
    bytes: 100,
    dtype: 'float64',
    originalDtype: '<f8',
    conversion: 'none',
    elements: shape.reduce((a, b) => a * b, 1),
  }));
  const validation = () => ({
    schemaVersion: '1.0',
    evaluationOperationId: crypto.randomUUID(),
    sourceOperationId: crypto.randomUUID(),
    inputDigest: snapshot.inputDigest,
    adapterDigest: snapshot.adapterDigest,
    validation: 'validated_numeric_structure',
    totalBytes: observations.length * 100,
    totalElements: observations.reduce((sum, item) => sum + item.elements, 0),
    observations: structuredClone(observations),
  });
  const original = validation(),
    adapted = validation();
  const geometryQuestions =
    domain === 'heat_diffusion'
      ? buildThermalGeometryQuestions(snapshot)
      : null;
  const coordinatesQuestions =
    domain === 'orbital_dynamics'
      ? buildOrbitalCoordinatesQuestions(snapshot)
      : null;
  const answerSupplement = (
    basis: typeof geometryQuestions,
    selectedOptionId: string,
  ) =>
    basis
      ? [
          {
            schemaVersion: '1.0',
            questionId: basis.questions[0]!.id,
            selectedOptionId,
            customText: '',
          },
        ]
      : [];
  return {
    snapshot,
    questionBasis,
    answers,
    declarationEvidenceId: crypto.randomUUID(),
    adapter,
    baseline: {
      original,
      adapted,
      evidenceId: crypto.randomUUID(),
      comparison: {
        schemaVersion: '1.0',
        status: 'matched',
        comparedElements: adapted.totalElements,
        observations: specs.map(([key]) => ({
          key,
          status: 'matched',
          reason: null as string | null,
        })),
      },
    },
    geometryQuestions,
    geometryAnswers: answerSupplement(
      geometryQuestions,
      'cell_averages_physical_volumes',
    ),
    coordinatesQuestions,
    coordinatesAnswers: answerSupplement(
      coordinatesQuestions,
      'fixed_source_relative',
    ),
  };
}
function states(value: ReturnType<typeof buildScientificEligibility>) {
  return Object.fromEntries(
    value.assertions.map((assertion) => [
      assertion.requirement,
      assertion.state,
    ]),
  );
}

describe('scientific declaration producer', () => {
  it('uses explicit declarations and matched numeric evidence, without inventing resource authorization', () => {
    const result = buildScientificEligibility(fixture());
    expect(states(result)).toMatchObject({
      supported_model: 'satisfied',
      verified_adapter: 'unknown',
      confirmed_units: 'satisfied',
      gravity_profile_confirmed: 'satisfied',
      inertial_frame: 'satisfied',
      complete_gravity_model: 'satisfied',
      isolated_mutual_gravity: 'violated',
      compatible_angular_origin: 'satisfied',
      masses_or_central_parameter: 'satisfied',
    });
    expect(
      result.assertions.some(
        (item) => item.requirement === 'resource_budget_available',
      ),
    ).toBe(false);
  });
  it('requires a snapshot-matched conditional adapter verification beyond a matching baseline', () => {
    const input = fixture();
    expect(states(buildScientificEligibility(input)).verified_adapter).toBe(
      'unknown',
    );
    const verification = {
      status: 'verified',
      scope: 'conditional_declared_mapping_and_extraction',
      adapterDigest: input.snapshot.adapterDigest,
      comparisonOperationId: input.baseline.evidenceId,
      originalOperationId: input.baseline.original.sourceOperationId,
      adaptedOperationId: input.baseline.adapted.sourceOperationId,
      reviewDigest: 'a'.repeat(64),
    };
    expect(
      states(
        buildScientificEligibility({
          ...input,
          adapterVerification: verification,
        }),
      ).verified_adapter,
    ).toBe('satisfied');
    expect(() =>
      buildScientificEligibility({
        ...input,
        adapterVerification: { ...verification, adapterDigest: 'b'.repeat(64) },
      }),
    ).toThrow('verification snapshot mismatch');
  });
  it('requires thermal cell-average/physical-volume semantics beyond a unit token', () => {
    const input = fixture('heat_diffusion');
    expect(states(buildScientificEligibility(input))).toMatchObject({
      supported_model: 'satisfied',
      thermal_weights: 'satisfied',
      closed_thermal_boundary: 'satisfied',
      no_heat_sources: 'satisfied',
    });
    input.geometryQuestions = null;
    input.geometryAnswers = [];
    expect(states(buildScientificEligibility(input)).thermal_weights).toBe(
      'unknown',
    );
  });
  it('keeps custom statements unresolved and does not silently prefer an option', () => {
    const input = fixture();
    input.answers.find(
      (answer) =>
        answer.questionId ===
        input.questionBasis.questions.find(
          (question) => question.key === 'context.additional_forces',
        )!.id,
    )!.customText = 'There may also be drag';
    expect(states(buildScientificEligibility(input))).toMatchObject({
      complete_gravity_model: 'conflicting',
      supported_model: 'unknown',
    });
    input.coordinatesAnswers[0]!.customText = 'I use another origin';
    expect(
      states(buildScientificEligibility(input)).compatible_angular_origin,
    ).toBe('conflicting');
  });
  it('does not compute central invariants in coordinates about another inertial origin', () => {
    const input = fixture();
    input.coordinatesAnswers[0]!.selectedOptionId = 'common_inertial';
    expect(states(buildScientificEligibility(input))).toMatchObject({
      supported_model: 'violated',
      compatible_angular_origin: 'violated',
    });
  });
  it('blocks mismatched baseline and refuses stale evidence or duplicate source operations', () => {
    const input = fixture();
    input.baseline.comparison.status = 'mismatched';
    input.baseline.comparison.observations[0]!.status = 'mismatched';
    input.baseline.comparison.observations[0]!.reason = 'value_mismatch';
    expect(states(buildScientificEligibility(input)).verified_adapter).toBe(
      'violated',
    );
    const stale = fixture();
    stale.baseline.adapted.inputDigest = 'f'.repeat(64);
    expect(() => buildScientificEligibility(stale)).toThrow('snapshot');
    const replay = fixture();
    replay.baseline.adapted.sourceOperationId =
      replay.baseline.original.sourceOperationId;
    expect(() => buildScientificEligibility(replay)).toThrow('Independent');
  });
  it('rejects altered question definitions and inconsistent reported array dimensions', () => {
    const input = fixture('heat_diffusion');
    input.geometryQuestions!.questions[0]!.options[0]!.label =
      'Trust arbitrary weights';
    expect(() => buildScientificEligibility(input)).toThrow('geometry');
    const wrong = fixture();
    wrong.answers.find(
      (answer) =>
        answer.questionId ===
        wrong.questionBasis.questions.find(
          (question) => question.key === 'context.dimensions',
        )!.id,
    )!.selectedOptionId = 'three';
    expect(states(buildScientificEligibility(wrong)).supported_model).toBe(
      'violated',
    );
  });
});
