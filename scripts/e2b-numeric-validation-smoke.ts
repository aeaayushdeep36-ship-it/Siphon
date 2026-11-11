import { createHash, randomUUID } from 'node:crypto';
import { Sandbox, Template } from 'e2b';
import {
  E2bSourceSession,
  SourceJobFailed,
  SourceRunner,
} from '../apps/api/src/source-runner.js';

// Authored fixtures only. This bypasses production admission and consumes E2B
// usage; use only after checking available credit and billing settings.
const apiKey = process.env.E2B_API_KEY;
const templateId = process.env.SIPHON_SOURCE_TEMPLATE_ID;
const buildId = process.env.SIPHON_SOURCE_TEMPLATE_BUILD_ID;
const tag = process.env.SIPHON_SOURCE_TEMPLATE_TAG;
if (
  !apiKey ||
  !templateId ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) ||
  !buildId ||
  !/^[a-f0-9-]{36}$/.test(buildId) ||
  !tag ||
  !/^siphon-[a-f0-9]{32}$/.test(tag)
)
  throw new Error(
    'Source template ID, build ID, tag and E2B_API_KEY are required',
  );

const verifiedApiKey = apiKey;
const verifiedTemplateId = templateId;
async function verifyTag() {
  const tags = await Template.getTags(verifiedTemplateId, {
    apiKey: verifiedApiKey,
    retries: 0,
    requestTimeoutMs: 30000,
  });
  if (tags.find((entry) => entry.tag === tag)?.buildId !== buildId)
    throw new Error('Source template tag does not match the requested build');
}

const digest = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const source = Buffer.from(
  [
    'from pathlib import Path',
    'Path("/tmp/siphon-numeric-fixture-ran").write_text("ran")',
    'import numpy as np',
    'times = np.array([0., 1.], dtype=np.float64)',
    '',
  ].join('\n'),
);

function validNpy(): Buffer {
  const dictionary =
    "{'descr': '<f8', 'fortran_order': False, 'shape': (2,), }";
  const padding = (16 - ((10 + dictionary.length + 1) % 16)) % 16;
  const header = Buffer.from(`${dictionary}${' '.repeat(padding)}\n`, 'ascii');
  const prefix = Buffer.alloc(10);
  prefix.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  prefix.writeUInt16LE(header.length, 8);
  const data = Buffer.alloc(16);
  data.writeDoubleLE(1, 0);
  data.writeDoubleLE(2, 8);
  return Buffer.concat([prefix, header, data]);
}

const fixtures = [
  {
    name: 'valid_csv',
    path: 'values.csv',
    bytes: Buffer.from('1\n2\n'),
    valid: true,
  },
  {
    name: 'invalid_csv',
    path: 'values.csv',
    bytes: Buffer.from('header\n1\n'),
    valid: false,
  },
  { name: 'valid_npy', path: 'values.npy', bytes: validNpy(), valid: true },
  {
    name: 'invalid_npy',
    path: 'values.npy',
    bytes: Buffer.from('not an npy file'),
    valid: false,
  },
];

for (const fixture of fixtures) {
  let sandbox: Sandbox | undefined;
  let terminated = false;
  try {
    await verifyTag();
    sandbox = await Sandbox.create(`${templateId}:${tag}`, {
      apiKey,
      timeoutMs: 60000,
      allowInternetAccess: false,
      network: { allowPublicTraffic: false },
      lifecycle: { onTimeout: 'kill', autoResume: false },
      retries: 0,
    });
    await verifyTag();
    const entryArtifactId = randomUUID();
    const runner = new SourceRunner(new E2bSourceSession(sandbox), {
      async claim() {},
      async authorizeCollection() {},
    });
    let completed = false;
    try {
      await runner.run({
        schemaVersion: '1.0',
        operationId: randomUUID(),
        inputDigest: digest(`authored numeric fixture ${fixture.name}`),
        adapterDigest: digest('authored numeric fixture mapping'),
        entryArtifactId,
        files: [
          {
            schemaVersion: '1.0',
            artifactId: entryArtifactId,
            path: 'fixture.py',
            bytes: source.length,
            sha256: digest(source),
            dataBase64: source.toString('base64'),
          },
          {
            schemaVersion: '1.0',
            artifactId: randomUUID(),
            path: fixture.path,
            bytes: fixture.bytes.length,
            sha256: digest(fixture.bytes),
            dataBase64: fixture.bytes.toString('base64'),
          },
        ],
        mappings: [
          {
            key: 'times',
            root: 'times',
            steps: [],
            expectedShape: [2],
            axisOrder: [0],
            declaredUnit: 's',
          },
        ],
        maximumOutputBytes: 4096,
        maximumElements: 100,
      });
      completed = true;
    } catch (error) {
      if (!(error instanceof SourceJobFailed)) throw error;
    }
    if (completed !== fixture.valid)
      throw new Error(`Unexpected source outcome for ${fixture.name}`);
    await sandbox.commands.run(
      fixture.valid
        ? 'test -f /tmp/siphon-numeric-fixture-ran'
        : 'test ! -e /tmp/siphon-numeric-fixture-ran',
      { requestTimeoutMs: 30000, timeoutMs: 30000, retainOutput: false },
    );
    console.log(JSON.stringify({ fixture: fixture.name, completed }));
  } finally {
    if (sandbox) terminated = await sandbox.kill();
  }
  if (!terminated) throw new Error('Sandbox termination not confirmed');
}
