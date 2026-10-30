import { describe, expect, it } from 'vitest';
import {
  InspectionResult,
  validateInspectionResult,
} from '../src/inspection.js';

const result = {
  schemaVersion: '1.0',
  sourceDigest: 'a'.repeat(64),
  parsed: true,
  truncated: false,
  dependencies: [{ kind: 'absolute_import', name: 'numpy', line: 1 }],
  definitions: [],
  findings: [],
};
describe('inspection output boundary', () => {
  it('binds observations to exact source bytes', () => {
    expect(validateInspectionResult(result, result.sourceDigest)).toEqual(
      result,
    );
    expect(() => validateInspectionResult(result, 'b'.repeat(64))).toThrow(
      'different source',
    );
  });
  it('rejects unsupported fields and contradictory results', () => {
    expect(InspectionResult.safeParse({ ...result, ready: true }).success).toBe(
      false,
    );
    expect(
      InspectionResult.safeParse({ ...result, parsed: false }).success,
    ).toBe(false);
    expect(
      InspectionResult.safeParse({
        ...result,
        findings: [{ code: 'syntax_error', line: 1 }],
      }).success,
    ).toBe(false);
  });
  it('enforces aggregate record limits and bounded names/locations', () => {
    expect(
      InspectionResult.safeParse({
        ...result,
        dependencies: Array(200).fill(result.dependencies[0]),
        definitions: [{ kind: 'assignment', name: 'x', line: 2 }],
      }).success,
    ).toBe(false);
    expect(
      InspectionResult.safeParse({
        ...result,
        dependencies: [
          { kind: 'absolute_import', name: 'x'.repeat(201), line: 0 },
        ],
      }).success,
    ).toBe(false);
  });
  it('accepts a bounded parse failure without claiming execution validity', () => {
    expect(
      InspectionResult.safeParse({
        ...result,
        parsed: false,
        dependencies: [],
        findings: [{ code: 'invalid_source_encoding', line: null }],
      }).success,
    ).toBe(true);
  });
});
