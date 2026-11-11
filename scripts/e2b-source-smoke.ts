import { createHash, randomUUID } from 'node:crypto';
import { Sandbox, Template } from 'e2b';
import {
  E2bSourceSession,
  SourceRunner,
} from '../apps/api/src/source-runner.js';
import {
  E2bValidationSession,
  ValidationRunner,
} from '../apps/api/src/validation-runner.js';
import {
  ConservationRunner,
  E2bConservationSession,
} from '../apps/api/src/conservation-runner.js';

const templateId = process.env.SIPHON_SOURCE_TEMPLATE_ID;
const templateBuildId = process.env.SIPHON_SOURCE_TEMPLATE_BUILD_ID;
const templateTag = process.env.SIPHON_SOURCE_TEMPLATE_TAG;
const evaluationTemplateId = process.env.SIPHON_EVALUATION_TEMPLATE_ID;
const evaluationTemplateBuildId =
  process.env.SIPHON_EVALUATION_TEMPLATE_BUILD_ID;
const evaluationTemplateTag = process.env.SIPHON_EVALUATION_TEMPLATE_TAG;
const apiKey = process.env.E2B_API_KEY;
if (
  !templateId ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) ||
  !templateBuildId ||
  !/^[a-f0-9-]{36}$/.test(templateBuildId) ||
  !templateTag ||
  !/^siphon-[a-f0-9]{32}$/.test(templateTag) ||
  !evaluationTemplateId ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(evaluationTemplateId) ||
  !evaluationTemplateBuildId ||
  !/^[a-f0-9-]{36}$/.test(evaluationTemplateBuildId) ||
  !evaluationTemplateTag ||
  !/^siphon-[a-f0-9]{32}$/.test(evaluationTemplateTag) ||
  !apiKey
)
  throw new Error(
    'Provide source and evaluation template IDs, build IDs, tags and E2B_API_KEY',
  );

async function verifyTemplate(
  key: string,
  id: string,
  tag: string,
  buildId: string,
): Promise<string> {
  const tags = await Template.getTags(id, { apiKey: key, retries: 0 });
  if (tags.find((item) => item.tag === tag)?.buildId !== buildId)
    throw new Error('Pinned smoke template build mismatch');
  return `${id}:${tag}`;
}
const sourceSelector = await verifyTemplate(
  apiKey,
  templateId,
  templateTag,
  templateBuildId,
);
const evaluationSelector = await verifyTemplate(
  apiKey,
  evaluationTemplateId,
  evaluationTemplateTag,
  evaluationTemplateBuildId,
);

// Authored fixtures only; this bypasses production admission.
const mode = process.argv[2] ?? 'heat';
if (!['heat', 'heat-csv', 'orbit'].includes(mode))
  throw new Error('Expected heat, heat-csv or orbit');
const heat = mode === 'heat' || mode === 'heat-csv';
const supportingCsv =
  mode === 'heat-csv' ? Buffer.from('0\n0\n1\n0\n0\n') : null;
const source = Buffer.from(
  (heat
    ? [
        'import numpy as np',
        supportingCsv
          ? 'u = np.loadtxt("initial.csv", delimiter=",", dtype=np.float64)'
          : 'u = np.array([0., 0., 1., 0., 0.], dtype=np.float64)',
        'initial = u.copy()',
        'for _ in range(100):',
        '    u = u + 0.1 * (np.roll(u, 1) - 2 * u + np.roll(u, -1))',
        'times = np.array([0., 100.], dtype=np.float64)',
        'temperature = np.stack([initial, u])',
        'thermal_weights = np.ones(5, dtype=np.float64)',
        '',
      ]
    : [
        'import numpy as np',
        'times = np.linspace(0., 1., 21, dtype=np.float64)',
        'positions = np.stack((np.cos(times), np.sin(times)), axis=1)[:, None, :]',
        'velocities = np.stack((-np.sin(times), np.cos(times)), axis=1)[:, None, :]',
        'central_mu = np.array(1., dtype=np.float64)',
        '',
      ]
  ).join('\n'),
);
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const artifactId = randomUUID();
const mappings = heat
  ? [
      {
        key: 'times',
        root: 'times',
        steps: [],
        expectedShape: [2],
        axisOrder: [0],
        declaredUnit: 's',
      },
      {
        key: 'temperature',
        root: 'temperature',
        steps: [],
        expectedShape: [2, 5],
        axisOrder: [0, 1],
        declaredUnit: 'K',
      },
      {
        key: 'thermal_weights',
        root: 'thermal_weights',
        steps: [],
        expectedShape: [5],
        axisOrder: [0],
        declaredUnit: 'm^3',
      },
    ]
  : [
      {
        key: 'times',
        root: 'times',
        steps: [],
        expectedShape: [21],
        axisOrder: [0],
        declaredUnit: 's',
      },
      {
        key: 'positions',
        root: 'positions',
        steps: [],
        expectedShape: [21, 1, 2],
        axisOrder: [0, 1, 2],
        declaredUnit: 'm',
      },
      {
        key: 'velocities',
        root: 'velocities',
        steps: [],
        expectedShape: [21, 1, 2],
        axisOrder: [0, 1, 2],
        declaredUnit: 'm/s',
      },
      {
        key: 'central_mu',
        root: 'central_mu',
        steps: [],
        expectedShape: [],
        axisOrder: [],
        declaredUnit: 'm^3/s^2',
      },
    ];
let sourceResult: Awaited<ReturnType<SourceRunner['run']>> | undefined;
let sandbox: Sandbox | undefined;
let sourceTerminated = false;
try {
  sandbox = await Sandbox.create(sourceSelector, {
    timeoutMs: 60000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    retries: 0,
  });
  const runner = new SourceRunner(new E2bSourceSession(sandbox), {
    async claim() {},
    async authorizeCollection() {},
  });
  const result = await runner.run({
    schemaVersion: '1.0',
    operationId: randomUUID(),
    inputDigest: digest(`authored ${mode} fixture`),
    adapterDigest: digest('authored fixture mapping'),
    entryArtifactId: artifactId,
    files: [
      {
        schemaVersion: '1.0',
        artifactId,
        path: 'fixture.py',
        bytes: source.length,
        sha256: digest(source),
        dataBase64: source.toString('base64'),
      },
      ...(supportingCsv
        ? [
            {
              schemaVersion: '1.0' as const,
              artifactId: randomUUID(),
              path: 'initial.csv',
              bytes: supportingCsv.length,
              sha256: digest(supportingCsv),
              dataBase64: supportingCsv.toString('base64'),
            },
          ]
        : []),
    ],
    mappings,
    maximumOutputBytes: 65536,
    maximumElements: 1000,
  });
  sourceResult = result;
  console.log(
    JSON.stringify({
      validation: result.validation,
      observations: result.manifest.observations.map(({ key, shape }) => ({
        key,
        shape,
      })),
    }),
  );
} finally {
  if (sandbox) sourceTerminated = await sandbox.kill();
}
if (!sourceTerminated) throw new Error('Source termination not confirmed');
if (!sourceResult) throw new Error('Source fixture did not complete');
let evaluator: Sandbox | undefined;
let evaluatorTerminated = false;
const manifest = sourceResult.manifest;
const validation = {
  schemaVersion: '1.0',
  evaluationOperationId: randomUUID(),
  sourceOperationId: manifest.operationId,
  inputDigest: manifest.inputDigest,
  adapterDigest: manifest.adapterDigest,
  manifest,
  mappings,
  maximumBytes: 65536,
  maximumElements: 1000,
};
try {
  evaluator = await Sandbox.create(evaluationSelector, {
    timeoutMs: 60000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    retries: 0,
  });
  const runner = new ValidationRunner(new E2bValidationSession(evaluator), {
    async claim() {},
    async authorizeResult() {},
  });
  const result = await runner.run(validation, sourceResult.payloads);
  console.log(
    JSON.stringify({
      validation: result.validation,
      observations: result.observations.length,
      totalElements: result.totalElements,
    }),
  );
} finally {
  if (evaluator) evaluatorTerminated = await evaluator.kill();
}
if (!evaluatorTerminated)
  throw new Error('Evaluator termination not confirmed');
let scientific: Sandbox | undefined;
try {
  scientific = await Sandbox.create(evaluationSelector, {
    timeoutMs: 60000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    retries: 0,
  });
  const contextDigest = digest('authored fixture context');
  const runner = new ConservationRunner(
    new E2bConservationSession(scientific),
    {
      async claim() {},
      async authorizeResult() {},
    },
  );
  const checks = heat
    ? ['H_ENERGY', 'H_BALANCE', 'H_TIME_REF', 'H_GRID_REF', 'H_REFERENCE']
    : ['O_ENERGY', 'O_ANGULAR', 'O_MOMENTUM', 'O_REFINE', 'O_REFERENCE'];
  const selected = heat ? ['H_ENERGY'] : ['O_ENERGY', 'O_ANGULAR'];
  const result = await runner.run(
    {
      schemaVersion: '1.0',
      diagnostic: {
        schemaVersion: '1.0',
        auditId: randomUUID(),
        revisionId: randomUUID(),
        operationId: randomUUID(),
        contextDigest,
        validation,
        profile: heat
          ? {
              kind: 'heat_energy_si',
              densityKgM3: 2,
              heatCapacityJKgK: 3,
            }
          : { kind: 'central_orbit_si' },
      },
      eligibility: {
        schemaVersion: '1.0',
        domain: heat ? 'heat_diffusion' : 'orbital_dynamics',
        inputDigest: manifest.inputDigest,
        contextDigest,
        adapterDigest: manifest.adapterDigest,
        decisions: checks.map((checkId) => ({
          checkId,
          registryVersion: '0.1.0',
          status: selected.includes(checkId) ? 'eligible' : 'ineligible',
          applicability: selected.includes(checkId) ? 'eligible' : 'ineligible',
          released: selected.includes(checkId),
          reasons: [],
        })),
      },
      planDigest: digest('authored fixture plan'),
      evidenceIds: Object.fromEntries(
        selected.map((check) => [check, randomUUID()]),
      ),
      policies: Object.fromEntries(
        selected.map((check) => [
          check,
          {
            scope: 'reported_samples',
            target: {
              value: 1e-8,
              unit: heat ? 'J' : check === 'O_ENERGY' ? 'm^2/s^2' : 'm^2/s',
              justification:
                'Authored fixture requirement on maximum saved-sample invariant drift, in explicit SI units.',
              evidenceIds: [randomUUID()],
            },
          },
        ]),
      ),
    },
    sourceResult.payloads,
  );
  console.log(
    JSON.stringify({
      evidence: result.evidence.map(({ checkId, status, metric }) => ({
        checkId,
        status,
        metric,
      })),
    }),
  );
} finally {
  if (scientific)
    console.log(
      JSON.stringify({ scientificTerminated: await scientific.kill() }),
    );
}
