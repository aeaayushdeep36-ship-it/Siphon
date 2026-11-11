import { sciencePython } from './science-python.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BaselineComparison } from '../packages/contracts/src/index.js';

// Fixed authored arrays only; no upload path/source execution is accepted.
const code = `
import json,sys,numpy as np
from siphon_science.fidelity import compare_baselines
assert sys.version_info[:2] == (3, 11), 'Python 3.11 is required'
left={'time': np.array([0.,1.])}
results=[]
for right in (left, {'time': np.array([0.,2.])}, {}):
    results.append(compare_baselines(left,right,required_keys=('time',),maximum_total_elements=4))
print(json.dumps(results))
`;
const output = execFileSync(sciencePython, ['-c', code], {
  cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 100_000,
  windowsHide: true,
});
const results: unknown = JSON.parse(output);
if (!Array.isArray(results) || results.length !== 3)
  throw new Error('Unexpected fixture output');
for (const [index, value] of results.entries()) {
  const parsed = BaselineComparison.parse(value);
  if (parsed.status !== (index === 0 ? 'matched' : 'mismatched'))
    throw new Error('Unexpected baseline comparison');
}
process.stdout.write(
  'Validated 3 authored Python baseline comparisons against TypeScript contracts.\n',
);
