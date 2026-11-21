import { sciencePython } from './science-python.js';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  InspectionJobRequest,
  validateInspectionJobResult,
  DEFAULT_POLICY,
} from '../packages/contracts/src/index.js';

// Only authored fixtures; no uploaded path or source argument is accepted.
const sources = [
  '',
  'import math\nx = 1',
  'raise RuntimeError("not executed")',
  'def broken(:',
];
const request = InspectionJobRequest.parse({
  schemaVersion: '1.0',
  operationId: randomUUID(),
  inputDigest: 'a'.repeat(64),
  maximumSourceBytes: DEFAULT_POLICY.sourceBytes,
  sources: sources.map((source) => ({
    artifactId: randomUUID(),
    sourceDigest: createHash('sha256').update(source).digest('hex'),
    sourceBase64: Buffer.from(source).toString('base64'),
  })),
});
const output = execFileSync(
  sciencePython,
  ['-m', 'siphon_science.inspection_job'],
  {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1000000,
    windowsHide: true,
  },
);
const result = validateInspectionJobResult(JSON.parse(output), request);
if (result.sources.at(-1)?.inspection.parsed !== false)
  throw new Error('Expected syntax-error fixture');
for (const mutate of [
  () => ({ ...result, inputDigest: 'b'.repeat(64) }),
  () => ({ ...result, sources: result.sources.slice(1) }),
  () => ({ ...result, sources: result.sources.map(() => result.sources[0]) }),
]) {
  let rejected = false;
  try {
    validateInspectionJobResult(mutate(), request);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Invalid response was accepted');
}
process.stdout.write(
  'Validated four authored inspection-job sources and three response identity rejection cases.\n',
);
