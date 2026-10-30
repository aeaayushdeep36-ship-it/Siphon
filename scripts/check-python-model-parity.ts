import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { z } from 'zod';
import {
  InspectionJobRequest,
  ObservationMapping,
  ObservationValidationRequest,
  validateInspectionJobResult,
  validateObservationValidationResult,
} from '../packages/contracts/src/index.js';

const Case = z.strictObject({
  id: z.string().min(1),
  kind: z.enum([
    'inspection_request',
    'inspection_result',
    'mapping',
    'observation_validation',
    'observation_validation_result',
  ]),
  valid: z.boolean(),
  value: z.unknown(),
  request: z.unknown().optional(),
});
const cases = z
  .array(Case)
  .min(1)
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../packages/contracts/fixtures/python-boundaries.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
assert.equal(
  new Set(cases.map((item) => item.id)).size,
  cases.length,
  'Duplicate fixture ID',
);
function validate(item: z.infer<typeof Case>, value: unknown) {
  switch (item.kind) {
    case 'inspection_request':
      return InspectionJobRequest.parse(value);
    case 'inspection_result':
      return validateInspectionJobResult(value, item.request);
    case 'mapping':
      return ObservationMapping.parse(value);
    case 'observation_validation':
      return ObservationValidationRequest.parse(value);
    case 'observation_validation_result':
      return validateObservationValidationResult(value, item.request);
  }
}
for (const item of cases) {
  let accepted = false;
  try {
    validate(item, item.value);
    accepted = true;
  } catch {
    /* Expected invalid fixtures. */
  }
  assert.equal(accepted, item.valid, `TypeScript boundary: ${item.id}`);
}
// Fixed test helper and fixed fixture file only. No upload path/source argument.
const response = execFileSync(
  process.env.SIPHON_PYTHON ?? 'python',
  [
    '-c',
    "import runpy; runpy.run_path('tests/model_boundaries.py', run_name='__main__')",
  ],
  {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1000000,
    windowsHide: true,
  },
);
const outputs = z
  .array(
    z.strictObject({
      id: z.string(),
      valid: z.boolean(),
      normalized: z.unknown().optional(),
    }),
  )
  .parse(JSON.parse(response));
assert.equal(outputs.length, cases.length);
for (const [index, item] of cases.entries()) {
  const output = outputs[index]!;
  assert.equal(output.id, item.id);
  assert.equal(output.valid, item.valid, `Python boundary: ${item.id}`);
  if (output.valid)
    assert.deepEqual(
      validate(item, output.normalized),
      validate(item, item.value),
    );
}
process.stdout.write(
  `Validated ${cases.length} shared Python/TypeScript boundary cases and accepted-value round trips.\n`,
);
