import { describe, expect, it } from 'vitest';
import { evaluateInspectionGate } from './inspection-gate.js';

const id = 'd559a333-886d-4a99-9ead-29f8dc303656';
const manifest = [
  {
    schemaVersion: '1.0',
    artifactId: id,
    path: 'model.py',
    bytes: 30,
    sha256: 'a'.repeat(64),
  },
];
const parsed = {
  schemaVersion: '1.0',
  sourceDigest: 'a'.repeat(64),
  parsed: true,
  truncated: false,
  dependencies: [],
  definitions: [],
  findings: [],
};
describe('inspection completeness gate', () => {
  it('does not mistake a parsed file for model/execution readiness', () => {
    expect(
      evaluateInspectionGate(manifest, [{ artifactId: id, result: parsed }]),
    ).toMatchObject({
      status: 'needs_input',
      next: 'review_requirements',
      findings: [{ artifactId: id, code: 'source_privacy_review' }],
    });
  });
  it('requires every source inspection and rejects duplicates or stale hashes', () => {
    expect(evaluateInspectionGate(manifest, [])).toMatchObject({
      next: 'resolve_inspection',
    });
    expect(() =>
      evaluateInspectionGate(manifest, [
        { artifactId: id, result: parsed },
        { artifactId: id, result: parsed },
      ]),
    ).toThrow('Duplicate');
    expect(() =>
      evaluateInspectionGate(manifest, [
        { artifactId: id, result: { ...parsed, sourceDigest: 'b'.repeat(64) } },
      ]),
    ).toThrow('different source');
  });
  it('blocks parse failures and incomplete output with explicit reasons', () => {
    expect(
      evaluateInspectionGate(manifest, [
        {
          artifactId: id,
          result: {
            ...parsed,
            parsed: false,
            findings: [{ code: 'syntax_error', line: 2 }],
          },
        },
      ]),
    ).toMatchObject({ status: 'unsupported', next: 'unsupported' });
    expect(
      evaluateInspectionGate(manifest, [
        { artifactId: id, result: { ...parsed, truncated: true } },
      ]),
    ).toMatchObject({ next: 'resolve_inspection' });
  });
  it('surfaces dependencies and dynamic execution without authorizing them', () => {
    const result = evaluateInspectionGate(manifest, [
      {
        artifactId: id,
        result: {
          ...parsed,
          dependencies: [
            { kind: 'absolute_import', name: 'unknown_package', line: 1 },
          ],
          findings: [{ code: 'dynamic_code_requires_review', line: 2 }],
        },
      },
    ]);
    expect(result.status).toBe('needs_input');
    expect(result.findings.map((item) => item.code)).toContain(
      'dependency_review',
    );
    expect(result.findings.map((item) => item.code)).toContain(
      'dynamic_code_review',
    );
  });
});
