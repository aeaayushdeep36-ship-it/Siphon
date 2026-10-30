import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validateInspectionResult } from '../packages/contracts/src/inspection.js';

// Authored fixtures only: never accept an upload path or source text as CLI input.
const sources = [
  'import numpy as np\ndef simulate(dt):\n    values = [dt]\n    return values\n',
  'from .helpers import solve\nclass Model: pass\n',
  'def broken(:\n',
  'exec("never executed")\n',
  'return 42\n',
];
const python = process.env.SIPHON_PYTHON ?? 'python';
const cwd = fileURLToPath(new URL('../packages/science/', import.meta.url));
const code = [
  'import json,sys',
  'from siphon_science.inspection import inspect_source',
  'assert sys.version_info[:2] == (3, 11), "Python 3.11 is required"',
  'sources=json.load(sys.stdin)',
  'print(json.dumps([inspect_source(s.encode("utf-8"), maximum_bytes=131072) for s in sources]))',
].join('\n');
const stdout = execFileSync(python, ['-c', code], {
  cwd,
  input: JSON.stringify(sources),
  encoding: 'utf8',
  timeout: 10_000,
  maxBuffer: 100_000,
  windowsHide: true,
});
const results: unknown = JSON.parse(stdout);
if (!Array.isArray(results) || results.length !== sources.length)
  throw new Error('Unexpected fixture output');
for (const [index, source] of sources.entries()) {
  validateInspectionResult(
    results[index],
    createHash('sha256').update(source).digest('hex'),
  );
}
process.stdout.write(
  `Validated ${sources.length} authored Python inspection outputs against TypeScript contracts.\n`,
);
