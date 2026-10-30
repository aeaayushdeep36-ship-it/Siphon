import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MetricEvidence } from '../packages/contracts/src/index.js';

// Fixed authored numerical cases only. Never run uploaded code or accept paths.
const code = `
import sys,json
from dataclasses import asdict
from siphon_science.evidence import decide_absolute_metric
assert sys.version_info[:2] == (3,11), 'Python 3.11 required'
cases=[(0.5,1.,0.1),(2.,1.,0.1),(1.,1.,0.1),(0.,1.,None),
       (100.,None,0.),(1.,1.,0.),(0.5,1.,0.5),(1e308,1e308,1e308),
       (sys.float_info.max,sys.float_info.max,1.)]
print(json.dumps([asdict(decide_absolute_metric(m,target=t,absolute_uncertainty_bound=u))
                  for m,t,u in cases],allow_nan=False))
`;
const raw = execFileSync(process.env.SIPHON_PYTHON ?? 'python', ['-c', code], {
  cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 100_000,
  windowsHide: true,
});
const Decision = z.strictObject({
  status: z.enum(['passed_within_tolerance', 'flagged', 'inconclusive']),
  metric: z.number().finite().nonnegative(),
  target: z.number().nullable(),
  absolute_uncertainty_bound: z.number().nullable(),
  lower_bound: z.number().nullable(),
  upper_bound: z.number().nullable(),
  reason: z.string(),
});
const decisions = z.array(Decision).length(9).parse(JSON.parse(raw));
const expected = [
  'passed_within_tolerance',
  'flagged',
  'inconclusive',
  'inconclusive',
  'inconclusive',
  'passed_within_tolerance',
  'inconclusive',
  'inconclusive',
  'inconclusive',
];
for (const [index, decision] of decisions.entries()) {
  const support = (value: number | null) =>
    value === null
      ? null
      : {
          value,
          unit: 'J',
          justification:
            'Authored parity fixture; not a production accuracy policy.',
          evidenceIds: [randomUUID()],
        };
  const result = MetricEvidence.parse({
    schemaVersion: '1.0',
    id: randomUUID(),
    auditId: randomUUID(),
    revisionId: randomUUID(),
    checkId: 'H_ENERGY',
    checkVersion: '0.1.0',
    inputDigest: 'a'.repeat(64),
    contextDigest: 'b'.repeat(64),
    adapterDigest: 'c'.repeat(64),
    planDigest: 'd'.repeat(64),
    experimentIds: [randomUUID()],
    metric: {
      name: 'fixture_metric',
      value: decision.metric,
      unit: 'J',
      normalization: 'absolute',
    },
    target: support(decision.target),
    uncertainty: support(decision.absolute_uncertainty_bound),
    interval:
      decision.lower_bound === null
        ? null
        : { lower: decision.lower_bound, upper: decision.upper_bound },
    status: decision.status,
    reason: decision.reason,
    limitations: ['Authored boundary fixture only.'],
  });
  if (result.status !== expected[index])
    throw new Error('Unexpected scientific decision');
}
process.stdout.write(
  `Validated ${decisions.length} Python decisions against the evidence contract.\n`,
);
