import { z } from 'zod';
import {
  Answer,
  QuestionSet,
  type ContextField,
  Domain,
  type ContextProposal,
} from '@siphon/contracts';

type Definition = {
  field: ContextField;
  prompt: string;
  reason: string;
  options: Array<readonly [string, string]>;
  checks: Array<
    | 'H_ENERGY'
    | 'H_BALANCE'
    | 'H_TIME_REF'
    | 'H_GRID_REF'
    | 'H_REFERENCE'
    | 'O_ENERGY'
    | 'O_ANGULAR'
    | 'O_MOMENTUM'
    | 'O_REFINE'
    | 'O_REFERENCE'
  >;
};
const heatChecks: Definition['checks'] = [
  'H_ENERGY',
  'H_BALANCE',
  'H_TIME_REF',
  'H_GRID_REF',
  'H_REFERENCE',
];
const orbitChecks: Definition['checks'] = [
  'O_ENERGY',
  'O_ANGULAR',
  'O_MOMENTUM',
  'O_REFINE',
  'O_REFERENCE',
];

function definitions(domain: Domain): Definition[] {
  Domain.parse(domain);
  const checks = domain === 'heat_diffusion' ? heatChecks : orbitChecks;
  return [
    {
      field: 'units',
      prompt: 'Which units does the simulation use?',
      reason:
        'Measurements must have known units before physical quantities can be compared.',
      options: [
        ['si', 'SI units throughout'],
        ['mixed', 'Mixed or custom units; I will describe them below'],
      ],
      checks,
    },
    {
      field: 'dimensions',
      prompt: 'How many spatial dimensions does the model use?',
      reason:
        'Array interpretation and supported model scope depend on spatial dimension.',
      options:
        domain === 'heat_diffusion'
          ? [
              ['one', 'One dimension'],
              ['two', 'Two dimensions'],
              ['other', 'Another geometry or dimension'],
            ]
          : [
              ['two', 'Two dimensions'],
              ['three', 'Three dimensions'],
              ['other', 'Another geometry or dimension'],
            ],
      checks,
    },
    {
      field: 'time_control',
      prompt:
        'Can the numerical integration step be changed independently of saved output times?',
      reason:
        'Saving more output samples does not establish a finer numerical integration.',
      options: [
        [
          'internal',
          'Yes, an internal step or solver accuracy control is available',
        ],
        ['output_only', 'Only the output sampling interval can be changed'],
        ['none', 'No usable control is available'],
      ],
      checks:
        domain === 'heat_diffusion'
          ? ['H_TIME_REF', 'H_REFERENCE']
          : ['O_REFINE', 'O_REFERENCE'],
    },
    ...((domain === 'heat_diffusion'
      ? [
          {
            field: 'thermal_model' as const,
            prompt: 'Which heat model is implemented?',
            reason:
              'The first supported model requires constant positive material properties on a uniform rectangular grid.',
            options: [
              [
                'constant_cartesian',
                'Constant positive properties on a uniform rectangular Cartesian grid',
              ],
              [
                'other',
                'Variable properties, another mesh, phase change or coupled physics',
              ],
            ],
            checks: heatChecks,
          },
          {
            field: 'thermal_boundary' as const,
            prompt: 'What happens at the thermal boundaries?',
            reason:
              'Energy conservation and energy balance require different boundary evidence.',
            options: [
              ['insulated', 'All boundaries are insulated'],
              ['periodic', 'All boundaries are periodic'],
              ['temperature', 'Prescribed temperature boundaries'],
              ['flux', 'Prescribed normal heat flux'],
              ['mixed', 'A mixture; I will describe each boundary below'],
              ['other', 'Another boundary model'],
            ],
            checks: ['H_ENERGY', 'H_BALANCE'] as Definition['checks'],
          },
          {
            field: 'heat_sources' as const,
            prompt: 'Does the model contain heat sources or sinks?',
            reason:
              'An energy change can be physically expected when heat is added or removed.',
            options: [
              ['none', 'No sources or sinks'],
              ['present', 'Sources or sinks are present'],
            ],
            checks: ['H_ENERGY', 'H_BALANCE'] as Definition['checks'],
          },
          {
            field: 'thermal_quadrature' as const,
            prompt:
              'What is the time variation of heat sources and outward boundary flux between reported sample times?',
            reason:
              'Trapezoidal time quadrature is mathematically exact when source and outward power are constant or piecewise-linear between sample times.',
            options: [
              [
                'piecewise_linear_or_constant',
                'Constant or piecewise-linear between sample times (zero quadrature remainder)',
              ],
              [
                'general_or_unknown',
                'Arbitrary or unknown nonlinear variation',
              ],
            ],
            checks: ['H_BALANCE'] as Definition['checks'],
          },
        ]
      : [
          {
            field: 'gravity_profile' as const,
            prompt: 'Which gravitational system is simulated?',
            reason:
              'Mutually interacting bodies and a test particle in a fixed field have different invariants.',
            options: [
              [
                'isolated_mutual',
                'An isolated system of mutually interacting positive point masses',
              ],
              [
                'fixed_central',
                'One test particle orbiting a fixed central gravitational field',
              ],
              ['other', 'Another gravitational model'],
            ],
            checks: orbitChecks,
          },
          {
            field: 'additional_forces' as const,
            prompt:
              'Does the model include forces or effects beyond Newtonian point-mass gravity?',
            reason:
              'Drag, thrust, softening, collisions or relativity change the supported checks.',
            options: [
              ['none', 'Only unsoftened Newtonian point-mass gravity'],
              ['present', 'Additional forces or effects are included'],
            ],
            checks: orbitChecks,
          },
          {
            field: 'reference_frame' as const,
            prompt:
              'In which reference frame are position and velocity reported?',
            reason:
              'Conservation diagnostics require a confirmed frame and compatible origin.',
            options: [
              ['inertial', 'An inertial frame with a declared origin'],
              ['rotating', 'A rotating frame'],
              ['other', 'A different or changing frame'],
            ],
            checks: orbitChecks,
          },
          {
            field: 'gravity_parameters' as const,
            prompt: 'Which gravitational parameters are available?',
            reason:
              'Computing energy requires the same masses and gravitational parameters used by the model.',
            options: [
              [
                'masses_g',
                'Constant positive masses and the gravitational constant G',
              ],
              ['central_mu', 'A fixed central gravitational parameter mu'],
              ['other', 'Another parameterization'],
            ],
            checks: orbitChecks,
          },
        ]) satisfies Definition[]),
  ];
}

/** AI candidates never suppress a consequential question or create confirmed facts.
 * Later trusted context validation can supply user declarations already resolved
 * for this exact snapshot; this initial builder deliberately confirms each field.
 */
export function buildContextQuestions(
  snapshot: Pick<
    ContextProposal,
    'auditId' | 'revisionId' | 'inputDigest' | 'domain'
  >,
) {
  return QuestionSet.parse({
    schemaVersion: '1.0',
    auditId: snapshot.auditId,
    revisionId: snapshot.revisionId,
    inputDigest: snapshot.inputDigest,
    questions: definitions(snapshot.domain).map((definition) => ({
      schemaVersion: '1.0',
      id: crypto.randomUUID(),
      key: `context.${definition.field}`,
      prompt: definition.prompt,
      reason: definition.reason,
      options: [
        ...definition.options.map(([id, label]) => ({
          id,
          label,
          unknown: false,
        })),
        { id: 'unknown', label: 'I am not sure', unknown: true },
      ],
      customTextAllowed: true,
      requiredFacts: [definition.field],
      affectedChecks: definition.checks,
    })),
  });
}

/** Deterministically interpret fixed option-only declarations. These describe
 * user intent, not independently verified implementation or check eligibility.
 */
export function interpretContextAnswers(
  domain: Domain,
  questionsValue: unknown,
  answersValue: unknown,
) {
  const questions = QuestionSet.parse(questionsValue);
  const answers = z.array(Answer).max(20).parse(answersValue);
  if (
    new Set(answers.map((answer) => answer.questionId)).size !== answers.length
  )
    throw new Error('Duplicate context answer');
  const registry = new Map(
    definitions(domain).map((definition) => [
      `context.${definition.field}`,
      definition,
    ]),
  );
  return answers.map((answer) => {
    const question = questions.questions.find(
      (item) => item.id === answer.questionId,
    );
    const definition = question && registry.get(question.key);
    if (!question || !definition)
      throw new Error('Answer does not belong to this domain question set');
    const expectedOptions = [
      ...definition.options.map(([id, label]) => ({
        id,
        label,
        unknown: false,
      })),
      { id: 'unknown', label: 'I am not sure', unknown: true },
    ];
    if (
      JSON.stringify(question.options) !== JSON.stringify(expectedOptions) ||
      question.prompt !== definition.prompt ||
      question.reason !== definition.reason ||
      JSON.stringify(question.requiredFacts) !==
        JSON.stringify([definition.field]) ||
      JSON.stringify(question.affectedChecks) !==
        JSON.stringify(definition.checks)
    )
      throw new Error(
        'Context question does not match the reviewed definition',
      );
    const option = question.options.find(
      (item) => item.id === answer.selectedOptionId,
    );
    if (answer.selectedOptionId !== null && !option)
      throw new Error('Unknown answer option');
    if (
      option &&
      option.id !== 'unknown' &&
      !definition.options.some(([id]) => id === option.id)
    )
      throw new Error('Unrecognized context option mapping');
    const state = answer.customText.trim()
      ? 'needs_reconciliation'
      : !option || option.id === 'unknown'
        ? 'unknown'
        : ['mixed', 'other'].includes(option.id)
          ? 'needs_reconciliation'
          : 'declared';
    return {
      field: definition.field,
      answer,
      state,
      value: state === 'declared' ? option!.id : null,
      provenance: 'user_declaration' as const,
    };
  });
}

export function unresolvedContextQuestions(
  domain: Domain,
  questionsValue: unknown,
  answersValue: unknown,
) {
  const questions = QuestionSet.parse(questionsValue);
  const interpreted = interpretContextAnswers(domain, questions, answersValue);
  const declared = new Set(
    interpreted
      .filter((item) => item.state === 'declared')
      .map((item) => item.answer.questionId),
  );
  const remaining = questions.questions.filter(
    (question) => !declared.has(question.id),
  );
  return remaining.length
    ? QuestionSet.parse({ ...questions, questions: remaining })
    : null;
}
