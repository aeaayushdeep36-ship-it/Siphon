import { createHash, randomUUID } from 'node:crypto';
import { Sandbox, Template } from 'e2b';
import {
  E2bInspectionSession,
  InspectionRunner,
} from '../apps/api/src/inspection-runner.js';

const templateId = process.env.SIPHON_INSPECTION_TEMPLATE_ID;
const templateBuildId = process.env.SIPHON_INSPECTION_TEMPLATE_BUILD_ID;
const templateTag = process.env.SIPHON_INSPECTION_TEMPLATE_TAG;
const apiKey = process.env.E2B_API_KEY;
if (
  !templateId ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) ||
  !templateBuildId ||
  !/^[a-f0-9-]{36}$/.test(templateBuildId) ||
  !templateTag ||
  !/^siphon-[a-f0-9]{32}$/.test(templateTag) ||
  !apiKey
)
  throw new Error(
    'Provide the inspection template ID, build ID, tag and E2B_API_KEY',
  );

const tags = await Template.getTags(templateId, { apiKey, retries: 0 });
if (tags.find((item) => item.tag === templateTag)?.buildId !== templateBuildId)
  throw new Error('Pinned inspection smoke template build mismatch');

// Authored fixture only. No user-uploaded files or service credentials enter the sandbox.
const source = Buffer.from('import numpy as np\nx = np.array([1.0, 2.0])\n');
const operationId = randomUUID();
let sandbox: Sandbox | undefined;
try {
  sandbox = await Sandbox.create(`${templateId}:${templateTag}`, {
    timeoutMs: 60000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    retries: 0,
  });
  const session = new E2bInspectionSession(sandbox);
  const runner = new InspectionRunner(session, {
    async claim() {},
    async authorizeResult() {},
  });
  const result = await runner.run({
    schemaVersion: '1.0',
    operationId,
    inputDigest: createHash('sha256')
      .update('authored smoke fixture')
      .digest('hex'),
    maximumSourceBytes: 131072,
    sources: [
      {
        artifactId: randomUUID(),
        sourceBase64: source.toString('base64'),
        sourceDigest: createHash('sha256').update(source).digest('hex'),
      },
    ],
  });
  console.log(
    JSON.stringify({
      parsed: result.sources[0]?.inspection.parsed,
      sources: result.sources.length,
    }),
  );
} finally {
  if (sandbox)
    console.log(JSON.stringify({ terminated: await sandbox.kill() }));
}
