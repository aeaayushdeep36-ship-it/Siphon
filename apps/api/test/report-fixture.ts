import { EvidenceReport, type Domain } from '@siphon/contracts';

/** Complete authored document only; no real audit, release or publication proof. */
export function authoredReport(domain: Domain = 'heat_diffusion') {
  const [
    reportId,
    auditId,
    revisionId,
    metricId,
    experimentId,
    operationId,
    supportId,
  ] = Array.from({ length: 7 }, () => crypto.randomUUID()) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const contextDigest = 'b'.repeat(64),
    adapterDigest = 'c'.repeat(64),
    planDigest = 'd'.repeat(64);
  const checkId = domain === 'heat_diffusion' ? 'H_ENERGY' : 'O_ENERGY';
  const support = {
    value: 1,
    unit: 'J',
    justification: 'Authored policy fixture only.',
    evidenceIds: [supportId],
  };
  return EvidenceReport.parse({
    schemaVersion: '1.0',
    reportId,
    reportVersion: 1,
    auditId,
    revisionId,
    inputDigest: 'a'.repeat(64),
    domain,
    contextDigest,
    adapterDigest,
    planDigest,
    title: 'AUTHORED FIXTURE - NOT A REAL AUDIT',
    scope: 'Authored numeric fixture for report verification.',
    summary:
      'The displayed evidence is within its authored target. This is not scientific release evidence.',
    createdAt: '2026-10-29T00:00:00.000Z',
    expiresAt: '2026-11-28T00:00:00.000Z',
    coverage: 'full',
    incompleteReasons: [],
    assumptions: [],
    unansweredQuestions: [],
    readiness: {
      status: 'ready',
      explanation: 'Authored readiness fixture.',
      evidenceIds: [supportId],
    },
    adapter: {
      status: 'verified',
      explanation: 'Authored adapter fixture.',
      evidenceIds: [supportId],
      comparedElements: 3,
    },
    checks: [
      {
        checkId,
        checkVersion: '0.1.0',
        selection: 'selected',
        reasons: ['Authored selection only.'],
        procedure:
          'Compare an authored energy drift against an authored threshold.',
        requiredObservations: ['times', 'energy'],
        accuracyPolicy:
          'Fixture uses a zero arithmetic bound solely to exercise report plumbing.',
        referenceIds: ['fixture_method'],
        experimentIds: [experimentId],
        metricEvidenceIds: [metricId],
      },
    ],
    experiments: [
      {
        id: experimentId,
        description: 'Authored baseline',
        status: 'completed',
        controls: [{ name: 'step', value: 0.01, unit: 's' }],
        sourceOperationId: operationId,
        resultDigest: 'e'.repeat(64),
      },
    ],
    metrics: [
      {
        schemaVersion: '1.0',
        id: metricId,
        auditId,
        revisionId,
        checkId,
        checkVersion: '0.1.0',
        inputDigest: 'a'.repeat(64),
        contextDigest,
        adapterDigest,
        planDigest,
        experimentIds: [experimentId],
        metric: {
          name: 'energy_drift',
          value: 0.5,
          unit: 'J',
          normalization: 'absolute',
        },
        target: support,
        uncertainty: { ...support, value: 0 },
        interval: { lower: 0.5, upper: 0.5 },
        status: 'passed_within_tolerance',
        reason: 'whole_interval_within_target',
        limitations: [
          'Authored fixture does not validate a scientific method.',
        ],
      },
    ],
    plots: [
      {
        id: crypto.randomUUID(),
        title: 'Authored energy trace',
        kind: 'line',
        xLabel: 'Time',
        xUnit: 's',
        yLabel: 'Energy drift',
        yUnit: 'J',
        evidenceIds: [metricId],
        description: 'Authored plotted data; no downsampling.',
        series: [
          {
            label: 'Baseline',
            experimentId,
            originalPointCount: 3,
            points: [
              { x: 0, y: 0 },
              { x: 0.5, y: 0.25 },
              { x: 1, y: 0.5 },
            ],
          },
        ],
      },
    ],
    narrative: {
      facts: [
        { text: 'The authored drift is 0.5 J.', evidenceIds: [metricId] },
      ],
      hypotheses: [
        {
          text: 'A changed step could affect the drift.',
          evidenceIds: [metricId],
          verification:
            'Repeat the supported experiment at a smaller internal step.',
        },
      ],
      recommendations: [
        {
          text: 'Investigate timestep sensitivity.',
          evidenceIds: [metricId],
          validation:
            'Compare independently computed measurements across at least three levels.',
        },
      ],
    },
    evidenceCatalog: [
      {
        id: metricId,
        kind: 'metric',
        digest: 'f'.repeat(64),
        description: 'Authored metric evidence.',
        expiresAt: null,
      },
      {
        id: supportId,
        kind: 'target',
        digest: 'f'.repeat(64),
        description: 'Authored support evidence.',
        expiresAt: null,
      },
    ],
    references: [
      {
        id: 'fixture_method',
        title: 'Authored reference - not a research citation',
        url: 'https://example.org/authored-fixture',
        accessedAt: '2026-10-29T00:00:00.000Z',
      },
    ],
    artifacts: [],
    software: [
      { name: 'siphon-report-fixture', version: '0.1.0', digest: null },
    ],
    reproduction: {
      instructions: [
        'Use the authored fixture; do not treat this report as a real audit.',
      ],
      artifactIds: [],
      limitations: ['No real source execution was performed.'],
    },
    limitations: [
      'AUTHORED FIXTURE - NOT A REAL AUDIT',
      'A scoped result does not certify simulation correctness.',
    ],
  });
}
