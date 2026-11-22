import { z } from 'zod';
import {
  AdapterProposal,
  Answer,
  BaselineComparison,
  Digest,
  Domain,
  EligibilityInput,
  Id,
  ObservationValidationResult,
  QuestionSet,
  type RequirementAssertion,
} from '@siphon/contracts';
import { interpretContextAnswers } from './context-questions.js';
import { canonicalJson } from './hashing.js';

const Snapshot = z.strictObject({
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  contextDigest: Digest,
  adapterDigest: Digest,
  domain: Domain,
});

const geometryDefinition = {
  schemaVersion: '1.0' as const,
  key: 'scientific.thermal_geometry',
  prompt: 'What do the exported temperatures and thermal weights represent?',
  reason:
    'Thermal energy needs physical volumes and a known temperature representation, including cross-section or thickness and periodic-node handling.',
  options: [
    {
      id: 'cell_averages_physical_volumes',
      label:
        'Cell-average temperatures and physical cell volumes in m³, including cross-section/thickness; no ghost cells or duplicated periodic cells',
      unknown: false,
    },
    {
      id: 'nodal_or_other',
      label:
        'Nodal samples, per-unit-thickness weights, or another representation',
      unknown: false,
    },
    { id: 'unknown', label: 'I am not sure', unknown: true },
  ],
  customTextAllowed: true as const,
  requiredFacts: ['thermal_weight_semantics'],
  affectedChecks: ['H_ENERGY', 'H_BALANCE'] as const,
};

export function buildThermalGeometryQuestions(value: unknown) {
  const snapshot = Snapshot.parse(value);
  if (snapshot.domain !== 'heat_diffusion')
    throw new Error('Thermal geometry requires the heat domain');
  return QuestionSet.parse({
    schemaVersion: '1.0',
    auditId: snapshot.auditId,
    revisionId: snapshot.revisionId,
    inputDigest: snapshot.inputDigest,
    questions: [{ ...geometryDefinition, id: crypto.randomUUID() }],
  });
}

const coordinatesDefinition = {
  schemaVersion: '1.0' as const,
  key: 'scientific.orbital_coordinates',
  prompt:
    'Which origin and velocity convention do the exported orbital arrays use?',
  reason:
    'Central-field invariants need both position and velocity relative to the fixed source. Isolated-system invariants need one common inertial coordinate system for every body.',
  options: [
    {
      id: 'fixed_source_relative',
      label:
        'Position and velocity relative to the same fixed central source in an inertial frame',
      unknown: false,
    },
    {
      id: 'common_inertial',
      label:
        'All bodies share one inertial coordinate system with a fixed origin and matching velocities',
      unknown: false,
    },
    {
      id: 'other',
      label: 'Another origin, moving center, or coordinate/velocity convention',
      unknown: false,
    },
    { id: 'unknown', label: 'I am not sure', unknown: true },
  ],
  customTextAllowed: true as const,
  requiredFacts: ['orbital_coordinate_semantics'],
  affectedChecks: ['O_ENERGY', 'O_ANGULAR', 'O_MOMENTUM'] as const,
};

export function buildOrbitalCoordinatesQuestions(value: unknown) {
  const snapshot = Snapshot.parse(value);
  if (snapshot.domain !== 'orbital_dynamics')
    throw new Error('Orbital coordinates require the orbital domain');
  return QuestionSet.parse({
    schemaVersion: '1.0',
    auditId: snapshot.auditId,
    revisionId: snapshot.revisionId,
    inputDigest: snapshot.inputDigest,
    questions: [{ ...coordinatesDefinition, id: crypto.randomUUID() }],
  });
}

const ProducerInput = z.strictObject({
  snapshot: Snapshot,
  questionBasis: QuestionSet,
  answers: z.array(Answer).max(20),
  declarationEvidenceId: Id,
  adapter: AdapterProposal,
  adapterVerification: z
    .strictObject({
      status: z.literal('verified'),
      scope: z.literal('conditional_declared_mapping_and_extraction'),
      adapterDigest: Digest,
      comparisonOperationId: Id,
      originalOperationId: Id,
      adaptedOperationId: Id,
      reviewDigest: Digest,
    })
    .nullable()
    .default(null),
  baseline: z.strictObject({
    comparison: BaselineComparison,
    original: ObservationValidationResult,
    adapted: ObservationValidationResult,
    evidenceId: Id,
  }),
  geometryQuestions: QuestionSet.nullable(),
  geometryAnswers: z.array(Answer).max(1),
  coordinatesQuestions: QuestionSet.nullable().default(null),
  coordinatesAnswers: z.array(Answer).max(1).default([]),
});

/** Internal producer after owner/current-generation/provenance resolution.
 * Statements remain conditional user declarations; AI candidates never become
 * verified physics. The caller resolves both evidence IDs to immutable records,
 * including fresh independent source runs and the trusted baseline comparator.
 * This function does not grant a resource reservation or dispatch permission.
 */
export function buildScientificEligibility(value: unknown): EligibilityInput {
  const input = ProducerInput.parse(value);
  const { snapshot, adapter, baseline } = input;
  if (
    adapter.auditId !== snapshot.auditId ||
    adapter.revisionId !== snapshot.revisionId ||
    adapter.inputDigest !== snapshot.inputDigest ||
    adapter.contextDigest !== snapshot.contextDigest ||
    adapter.domain !== snapshot.domain ||
    input.questionBasis.auditId !== snapshot.auditId
  )
    throw new Error('Scientific context snapshot mismatch');
  // questionBasis may belong to an unchanged-source parent: the caller resolves
  // the answer-derived successor link and immutable declaration record first.
  const declarations = interpretContextAnswers(
    snapshot.domain,
    input.questionBasis,
    input.answers,
  );
  const facts = new Map(declarations.map((item) => [item.field, item]));
  const assertions: RequirementAssertion[] = [];
  const declared = (key: Parameters<typeof facts.get>[0]) => {
    const fact = facts.get(key);
    return fact?.state === 'declared' ? fact.value : null;
  };
  const add = (
    requirement: RequirementAssertion['requirement'],
    state: RequirementAssertion['state'],
    evidenceIds = [input.declarationEvidenceId],
  ) => assertions.push({ requirement, state, evidenceIds });
  const declaration = (
    requirement: RequirementAssertion['requirement'],
    key: Parameters<typeof facts.get>[0],
    supported: readonly string[],
  ) => {
    const fact = facts.get(key);
    add(
      requirement,
      fact?.state === 'needs_reconciliation'
        ? 'conflicting'
        : declared(key) === null
          ? 'unknown'
          : supported.includes(declared(key)!)
            ? 'satisfied'
            : 'violated',
    );
  };
  const mappingKeys = adapter.mappings.map((item) => item.key).sort();
  const operations = [
    baseline.original.sourceOperationId,
    baseline.original.evaluationOperationId,
    baseline.adapted.sourceOperationId,
    baseline.adapted.evaluationOperationId,
  ];
  if (new Set(operations).size !== operations.length)
    throw new Error('Independent baseline operations required');
  for (const output of [baseline.original, baseline.adapted]) {
    if (
      output.inputDigest !== snapshot.inputDigest ||
      output.adapterDigest !== snapshot.adapterDigest ||
      JSON.stringify(output.observations.map((item) => item.key).sort()) !==
        JSON.stringify(mappingKeys)
    )
      throw new Error('Baseline observation snapshot mismatch');
    for (const observation of output.observations) {
      const mapping = adapter.mappings.find(
        (item) => item.key === observation.key,
      )!;
      if (
        observation.declaredUnit !== mapping.declaredUnit ||
        JSON.stringify(observation.shape) !==
          JSON.stringify(mapping.expectedShape)
      )
        throw new Error('Baseline mapping mismatch');
    }
  }
  if (
    JSON.stringify(
      baseline.comparison.observations.map((item) => item.key).sort(),
    ) !== JSON.stringify(mappingKeys)
  )
    throw new Error('Baseline comparison observations mismatch');
  if (
    baseline.comparison.status === 'matched' &&
    baseline.comparison.comparedElements !== baseline.adapted.totalElements
  )
    throw new Error('Baseline comparison element count mismatch');
  const verified = input.adapterVerification;
  if (
    verified &&
    (verified.adapterDigest !== snapshot.adapterDigest ||
      verified.comparisonOperationId !== baseline.evidenceId ||
      verified.originalOperationId !== baseline.original.sourceOperationId ||
      verified.adaptedOperationId !== baseline.adapted.sourceOperationId)
  )
    throw new Error('Adapter verification snapshot mismatch');
  add(
    'verified_adapter',
    baseline.comparison.status === 'mismatched'
      ? 'violated'
      : verified
        ? 'satisfied'
        : 'unknown',
    [baseline.evidenceId],
  );
  add('finite_observations', 'satisfied', [
    baseline.adapted.evaluationOperationId,
  ]);

  const units: Record<string, string> = {
    times: 's',
    temperature: 'K',
    thermal_weights: 'm^3',
    source_power: 'W',
    outward_power: 'W',
    positions: 'm',
    velocities: 'm/s',
    masses: 'kg',
    central_mu: 'm^3/s^2',
    gravity_constant: 'm^3/(kg*s^2)',
  };
  declaration('confirmed_units', 'units', ['si']);
  if (
    assertions.at(-1)!.state === 'satisfied' &&
    adapter.mappings.some((item) => units[item.key] !== item.declaredUnit)
  )
    assertions.at(-1)!.state = 'violated';
  const observed = (key: string) =>
    adapter.mappings.find((item) => item.key === key);
  const dimensions =
    snapshot.domain === 'heat_diffusion'
      ? (observed('temperature')?.expectedShape.length ?? 1) - 1
      : observed('positions')?.expectedShape[2];
  const dimensionDeclared = declared('dimensions');
  const dimensionMatch =
    dimensionDeclared ===
    (dimensions === 1 ? 'one' : dimensions === 2 ? 'two' : 'three');
  if (snapshot.domain === 'heat_diffusion') {
    declaration('supported_model', 'thermal_model', ['constant_cartesian']);
    if (assertions.at(-1)!.state === 'satisfied')
      assertions.at(-1)!.state =
        dimensionDeclared === null
          ? 'unknown'
          : dimensionMatch
            ? 'satisfied'
            : 'violated';
    declaration('closed_thermal_boundary', 'thermal_boundary', [
      'insulated',
      'periodic',
    ]);
    declaration('no_heat_sources', 'heat_sources', ['none']);
    let geometry: RequirementAssertion['state'] = 'unknown';
    if (input.geometryQuestions) {
      const expected = buildThermalGeometryQuestions(snapshot);
      const question = input.geometryQuestions.questions[0];
      if (
        input.geometryQuestions.auditId !== snapshot.auditId ||
        input.geometryQuestions.questions.length !== 1 ||
        canonicalJson({ ...question, id: null }) !==
          canonicalJson({ ...expected.questions[0], id: null })
      )
        throw new Error('Thermal geometry question mismatch');
      const answer = input.geometryAnswers[0];
      if (answer) {
        if (
          answer.questionId !== question!.id ||
          (answer.selectedOptionId !== null &&
            !question!.options.some(
              (option) => option.id === answer.selectedOptionId,
            ))
        )
          throw new Error('Thermal geometry answer mismatch');
        geometry = answer.customText.trim()
          ? 'conflicting'
          : answer.selectedOptionId === 'cell_averages_physical_volumes'
            ? 'satisfied'
            : answer.selectedOptionId === 'unknown'
              ? 'unknown'
              : 'violated';
      }
    } else if (input.geometryAnswers.length)
      throw new Error('Thermal geometry basis missing');
    add('thermal_weights', observed('thermal_weights') ? geometry : 'unknown');
    const boundary = declared('thermal_boundary');
    add(
      'boundary_flux_observed',
      boundary === null
        ? 'unknown'
        : ['insulated', 'periodic'].includes(boundary)
          ? 'satisfied'
          : ['flux', 'temperature', 'mixed'].includes(boundary) &&
              Boolean(observed('outward_power'))
            ? 'satisfied'
            : 'violated',
    );
    const sources = declared('heat_sources');
    add(
      'heat_sources_observed',
      sources === null
        ? 'unknown'
        : sources === 'none'
          ? 'satisfied'
          : sources === 'present' && Boolean(observed('source_power'))
            ? 'satisfied'
            : 'violated',
    );
    const quadrature = declared('thermal_quadrature');
    add(
      'time_quadrature_supported',
      quadrature === null
        ? 'unknown'
        : quadrature === 'piecewise_linear_or_constant'
          ? 'satisfied'
          : 'violated',
    );
  } else {
    const profile = declared('gravity_profile');
    const bodies = observed('positions')!.expectedShape[1]!;
    const profileMatch =
      profile === 'fixed_central'
        ? bodies === 1
        : profile === 'isolated_mutual'
          ? bodies >= 2
          : false;
    declaration('gravity_profile_confirmed', 'gravity_profile', [
      'fixed_central',
      'isolated_mutual',
    ]);
    if (assertions.at(-1)!.state === 'satisfied' && !profileMatch)
      assertions.at(-1)!.state = 'violated';
    declaration('inertial_frame', 'reference_frame', ['inertial']);
    declaration('complete_gravity_model', 'additional_forces', ['none']);
    declaration('isolated_mutual_gravity', 'gravity_profile', [
      'isolated_mutual',
    ]);
    let coordinates: RequirementAssertion['state'] = 'unknown';
    if (input.coordinatesQuestions) {
      const expected = buildOrbitalCoordinatesQuestions(snapshot);
      const question = input.coordinatesQuestions.questions[0];
      if (
        input.coordinatesQuestions.auditId !== snapshot.auditId ||
        input.coordinatesQuestions.questions.length !== 1 ||
        canonicalJson({ ...question, id: null }) !==
          canonicalJson({ ...expected.questions[0], id: null })
      )
        throw new Error('Orbital coordinate question mismatch');
      const answer = input.coordinatesAnswers[0];
      if (answer) {
        if (
          answer.questionId !== question!.id ||
          (answer.selectedOptionId !== null &&
            !question!.options.some(
              (option) => option.id === answer.selectedOptionId,
            ))
        )
          throw new Error('Orbital coordinate answer mismatch');
        coordinates = answer.customText.trim()
          ? 'conflicting'
          : answer.selectedOptionId === 'unknown' || profile === null
            ? 'unknown'
            : answer.selectedOptionId ===
                (profile === 'fixed_central'
                  ? 'fixed_source_relative'
                  : 'common_inertial')
              ? 'satisfied'
              : 'violated';
      }
    } else if (input.coordinatesAnswers.length)
      throw new Error('Orbital coordinate basis missing');
    add('compatible_angular_origin', coordinates);
    add('positions_velocities', 'satisfied', [
      baseline.adapted.evaluationOperationId,
    ]);
    const parameters = declared('gravity_parameters');
    add(
      'masses_or_central_parameter',
      parameters === null
        ? 'unknown'
        : profile === 'fixed_central' &&
            parameters === 'central_mu' &&
            observed('central_mu')
          ? 'satisfied'
          : profile === 'isolated_mutual' &&
              parameters === 'masses_g' &&
              observed('masses') &&
              observed('gravity_constant')
            ? 'satisfied'
            : 'violated',
    );
    const forces = declared('additional_forces');
    add(
      'supported_model',
      profile === null || forces === null || dimensionDeclared === null
        ? 'unknown'
        : profileMatch && forces === 'none' && dimensionMatch
          ? 'satisfied'
          : 'violated',
    );
    if (assertions.at(-1)!.state === 'satisfied')
      assertions.at(-1)!.state = coordinates;
  }
  return EligibilityInput.parse({
    schemaVersion: '1.0',
    domain: snapshot.domain,
    inputDigest: snapshot.inputDigest,
    contextDigest: snapshot.contextDigest,
    adapterDigest: snapshot.adapterDigest,
    assertions,
  });
}
