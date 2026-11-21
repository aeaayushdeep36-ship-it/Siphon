import { sciencePython } from './science-python.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ObservationMapping } from '../packages/contracts/src/adapter.js';

// Authored fixed namespace and selectors only; accepts no source or upload path.
const base = {
  key: 'temperature',
  root: 'history',
  steps: [{ kind: 'key', key: 'values' }],
  expectedShape: [2, 3],
  axisOrder: [1, 0],
  declaredUnit: 'K',
};
const cases = [
  base,
  { ...base, root: 'history.values()' },
  { ...base, axisOrder: [0, 0] },
  { ...base, steps: [{ kind: 'attribute', name: 'values' }] },
];
const code = `import json,sys,numpy as np
from siphon_science.adapter import extract_observations,AdapterError
assert sys.version_info[:2] == (3,11), "Python 3.11 required"
results=[]
for mapping in json.load(sys.stdin):
    try:
        out=extract_observations({"history":{"values":np.arange(6,dtype=np.float64).reshape(3,2)}},[mapping],maximum_bytes=48,maximum_elements=6)
        results.append({"accepted":True,"values":out["temperature"].tolist()})
    except AdapterError:
        results.append({"accepted":False})
print(json.dumps(results))`;
const output: unknown = JSON.parse(
  execFileSync(sciencePython, ['-c', code], {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    input: JSON.stringify(cases),
    timeout: 10000,
    maxBuffer: 10000,
    encoding: 'utf8',
    windowsHide: true,
  }),
);
if (!Array.isArray(output) || output.length !== cases.length)
  throw new Error('Invalid adapter fixture output');
for (const [index, mapping] of cases.entries()) {
  const expected = ObservationMapping.safeParse(mapping).success;
  if (output[index]?.accepted !== expected)
    throw new Error('Cross-language selector validation mismatch');
}
if (
  JSON.stringify(output[0]?.values) !==
  JSON.stringify([
    [0, 2, 4],
    [1, 3, 5],
  ])
)
  throw new Error('Explicit extraction axes produced incorrect values');
process.stdout.write(
  'Validated one authored adapter extraction and three unsafe/invalid selector rejection cases across TypeScript/Python.\n',
);
