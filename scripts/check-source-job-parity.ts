import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  SourceJobRequest,
  validateSourceJobResult,
  ObservationValidationRequest,
  validateObservationValidationResult,
} from '../packages/contracts/src/source-job.js';
import {
  DiagnosticJobRequest,
  validateDiagnosticJobResult,
} from '../packages/contracts/src/diagnostics.js';

// The executed script is a fixed authored fixture; no file/source CLI arguments.
const source =
  'import numpy as np\nt=np.array([0.,1.])\nT=np.array([[3.],[5.]])\nw=np.array([1.])\n';
const artifactId = randomUUID();
const request = SourceJobRequest.parse({
  schemaVersion: '1.0',
  operationId: randomUUID(),
  inputDigest: 'a'.repeat(64),
  adapterDigest: 'b'.repeat(64),
  entryArtifactId: artifactId,
  files: [
    {
      schemaVersion: '1.0',
      artifactId,
      path: 'model.py',
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex'),
      dataBase64: Buffer.from(source).toString('base64'),
    },
  ],
  maximumOutputBytes: 4096,
  maximumElements: 100,
  mappings: [
    {
      key: 'times',
      root: 't',
      steps: [],
      expectedShape: [2],
      axisOrder: [0],
      declaredUnit: 's',
    },
    {
      key: 'temperature',
      root: 'T',
      steps: [],
      expectedShape: [2, 1],
      axisOrder: [0, 1],
      declaredUnit: 'K',
    },
    {
      key: 'thermal_weights',
      root: 'w',
      steps: [],
      expectedShape: [1],
      axisOrder: [0],
      declaredUnit: 'm^3',
    },
  ],
});
const code = `import json,sys,tempfile,pathlib,uuid
from siphon_science.source_job import execute_source_job
from siphon_science.validation_job import validate_observation_job
from siphon_science.diagnostics_job import run_diagnostics_job
assert sys.version_info[:2] == (3,11), "Python 3.11 required"
with tempfile.TemporaryDirectory() as directory:
    request=json.load(sys.stdin)
    root=pathlib.Path(directory)/"authored-job"
    result=execute_source_job(request,root)
    payloads={item["filename"]:(root/"observations"/item["filename"]).read_bytes() for item in result["observations"]}
    validation_request={"schemaVersion":"1.0","evaluationOperationId":str(uuid.uuid4()),"sourceOperationId":request["operationId"],"inputDigest":request["inputDigest"],"adapterDigest":request["adapterDigest"],"manifest":result,"mappings":request["mappings"],"maximumBytes":request["maximumOutputBytes"],"maximumElements":request["maximumElements"]}
    validation_result,validated=validate_observation_job(validation_request,payloads)
    assert validated["temperature"].values.tolist()==[[3.],[5.]]
    diagnostic_request={"schemaVersion":"1.0","auditId":str(uuid.uuid4()),"revisionId":str(uuid.uuid4()),"operationId":str(uuid.uuid4()),"contextDigest":"c"*64,"validation":validation_request,"profile":{"kind":"heat_energy_si","densityKgM3":2.,"heatCapacityJKgK":3.}}
    diagnostic_result=run_diagnostics_job(diagnostic_request,payloads)
    assert diagnostic_result["metrics"][0]["value"]==12.
    print(json.dumps({"source":result,"validationRequest":validation_request,"validationResult":validation_result,"diagnosticRequest":diagnostic_request,"diagnosticResult":diagnostic_result}))`;
const output: unknown = JSON.parse(
  execFileSync(process.env.SIPHON_PYTHON ?? 'python', ['-c', code], {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 10000,
    windowsHide: true,
  }),
);
const envelope = z
  .object({
    source: z.unknown(),
    validationRequest: ObservationValidationRequest,
    validationResult: z.unknown(),
    diagnosticRequest: DiagnosticJobRequest,
    diagnosticResult: z.unknown(),
  })
  .parse(output);
const result = validateSourceJobResult(envelope.source, request);
const validated = validateObservationValidationResult(
  envelope.validationResult,
  envelope.validationRequest,
);
const diagnostic = validateDiagnosticJobResult(
  envelope.diagnosticResult,
  envelope.diagnosticRequest,
);
if (
  diagnostic.metrics[0]?.value !== 12 ||
  diagnostic.metrics[0].status !== 'inconclusive'
)
  throw new Error(
    'Authored heat measurement or diagnostic-only status changed',
  );
for (const invalid of [
  { ...diagnostic, inputDigest: 'f'.repeat(64) },
  {
    ...diagnostic,
    metrics: diagnostic.metrics.map((item) => ({
      ...item,
      status: 'passed_within_tolerance',
    })),
  },
]) {
  let rejected = false;
  try {
    validateDiagnosticJobResult(invalid, envelope.diagnosticRequest);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error('Invalid diagnostic identity/verdict was accepted');
}
let rejectedCount = false;
try {
  validateObservationValidationResult(
    { ...validated, totalElements: validated.totalElements + 1 },
    envelope.validationRequest,
  );
} catch {
  rejectedCount = true;
}
if (!rejectedCount)
  throw new Error('Contradictory validation summary was accepted');
for (const invalid of [
  { ...result, adapterDigest: 'c'.repeat(64) },
  { ...result, observations: result.observations.slice(1) },
  {
    ...result,
    observations: result.observations.map((item) => ({
      ...item,
      filename: 'obs_wrong.npy',
    })),
  },
]) {
  let rejected = false;
  try {
    validateSourceJobResult(invalid, request);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error('Invalid source-job observation manifest was accepted');
}
process.stdout.write(
  'Validated authored source execution, numeric validation and a real 12 J heat diagnostic; rejected three altered manifests, one contradictory validation summary and two invalid diagnostic results.\n',
);
