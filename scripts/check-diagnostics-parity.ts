import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  DiagnosticJobRequest,
  validateDiagnosticJobResult,
} from '../packages/contracts/src/diagnostics.js';

// Fixed authored arrays only. No CLI arguments, uploaded source or input paths.
const code = `import io,json,hashlib,uuid,sys
import numpy as np
from siphon_science.diagnostics_job import run_diagnostics_job
assert sys.version_info[:2]==(3,11), "Python 3.11 required"
units={"times":"s","positions":"m","velocities":"m/s","central_mu":"m^3/s^2","masses":"kg","gravity_constant":"m^3/(kg*s^2)","temperature":"K","thermal_weights":"m^3","source_power":"W","outward_power":"W"}
fixtures=[
 ({"times":[0.,1.],"positions":[[[1.,0.]],[[0.,1.]]],"velocities":[[[0.,1.]], [[-1.1,0.]]],"central_mu":1.},{"kind":"central_orbit_si"}),
 ({"times":[0.,1.],"positions":[[[-1.,0.],[1.,0.]]]*2,"velocities":[[[0.,-.5],[0.,.5]],[[0.,.5],[0.,-.5]]],"masses":[1.,1.],"gravity_constant":1.},{"kind":"isolated_orbits_si"}),
 ({"times":[0.,1.],"temperature":[[[300.,300.],[300.,300.]],[[302.,302.],[302.,302.]]],"thermal_weights":[[1.,1.],[1.,1.]]},{"kind":"heat_energy_si","densityKgM3":2.,"heatCapacityJKgK":3.}),
 ({"times":[0.,1.,3.],"temperature":[[10.],[8.],[4.]],"thermal_weights":[1.],"source_power":[0.,0.,0.],"outward_power":[-2.,-2.,-2.]},{"kind":"heat_balance_si","densityKgM3":1.,"heatCapacityJKgK":1.})]
out=[]
for values,profile in fixtures:
    mappings,descriptors,payloads=[],[],{}
    for key,value in values.items():
        array=np.array(value,dtype=np.float64)
        stream=io.BytesIO()
        np.save(stream,array,allow_pickle=False)
        raw=stream.getvalue()
        filename="obs_"+key+".npy"
        payloads[filename]=raw
        mappings.append({"key":key,"root":"fixture","steps":[],"expectedShape":list(array.shape),"axisOrder":list(range(array.ndim)),"declaredUnit":units[key]})
        descriptors.append({"key":key,"filename":filename,"sha256":hashlib.sha256(raw).hexdigest(),"bytes":len(raw),"shape":list(array.shape),"dtype":"float64","declaredUnit":units[key]})
    source=str(uuid.uuid4())
    validation={"schemaVersion":"1.0","evaluationOperationId":str(uuid.uuid4()),"sourceOperationId":source,"inputDigest":"a"*64,"adapterDigest":"b"*64,"maximumBytes":100000,"maximumElements":1000,"mappings":mappings,"manifest":{"schemaVersion":"1.0","operationId":source,"inputDigest":"a"*64,"adapterDigest":"b"*64,"executionProfile":"runpy_main_root_v1","observations":descriptors}}
    request={"schemaVersion":"1.0","auditId":str(uuid.uuid4()),"revisionId":str(uuid.uuid4()),"operationId":str(uuid.uuid4()),"contextDigest":"c"*64,"validation":validation,"profile":profile}
    out.append({"request":request,"result":run_diagnostics_job(request,payloads)})
print(json.dumps(out,allow_nan=False))`;
const output: unknown = JSON.parse(
  execFileSync(process.env.SIPHON_PYTHON ?? 'python', ['-c', code], {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 50000,
    windowsHide: true,
  }),
);
const cases = z
  .array(z.strictObject({ request: DiagnosticJobRequest, result: z.unknown() }))
  .length(4)
  .parse(output);
const expected = [[0.105, 0.1], [0, 2, 0], [48], [12]];
let rejected = 0;
for (const [index, item] of cases.entries()) {
  const result = validateDiagnosticJobResult(item.result, item.request);
  for (const [metricIndex, metric] of result.metrics.entries()) {
    // Unit-scale fixture arithmetic only; this is not a user accuracy tolerance.
    if (Math.abs(metric.value - expected[index]![metricIndex]!) > 1e-14)
      throw new Error(
        'Diagnostic differs from independently calculated authored values',
      );
    if (
      !metric.arithmetic ||
      metric.arithmetic.scope !== 'sampled_formula_roundoff'
    )
      throw new Error('Authored metric lost its separate arithmetic enclosure');
  }
  for (const invalid of [
    { ...result, contextDigest: 'f'.repeat(64) },
    {
      ...result,
      metrics: result.metrics.map((metric) => ({
        ...metric,
        status: 'flagged',
      })),
    },
    {
      ...result,
      metrics: result.metrics.map((metric) => ({
        ...metric,
        arithmetic: {
          ...metric.arithmetic!,
          lower: metric.value + 1,
          upper: metric.value + 2,
          absoluteUncertaintyBound: 0,
        },
      })),
    },
  ]) {
    try {
      validateDiagnosticJobResult(invalid, item.request);
    } catch {
      rejected++;
      continue;
    }
    throw new Error('Diagnostic provenance/verdict mismatch was accepted');
  }
  if (item.request.profile.kind.startsWith('heat_')) {
    const changed = DiagnosticJobRequest.parse({
      ...item.request,
      profile: { ...item.request.profile, densityKgM3: 10 },
    });
    try {
      validateDiagnosticJobResult(result, changed);
    } catch {
      rejected++;
      continue;
    }
    throw new Error('Changed thermal parameters accepted a stale measurement');
  }
}
process.stdout.write(
  `Validated four real Python diagnostic profiles and independent values; rejected ${rejected} provenance/verdict/parameter mismatches.\n`,
);
