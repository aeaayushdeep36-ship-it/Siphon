import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  Answer,
  DEFAULT_POLICY,
  ResourcePolicy,
  SafeUploadPath,
  acceptAnswer,
  e2bDispatchAllowance,
  metaDispatchAllowance,
  preflightUploads,
} from '../src/index.js';

const file = (path = 'experiment.py', bytes = 100) => ({
  schemaVersion: '1.0',
  artifactId: randomUUID(),
  path,
  bytes,
  sha256: 'a'.repeat(64),
});

describe('budget policy', () => {
  it('keeps provider balances separate and reserves Meta headroom', () => {
    expect(metaDispatchAllowance(150_000_000)).toBe(135_000_000);
    expect(metaDispatchAllowance(20_000_000)).toBe(5_000_000);
    expect(metaDispatchAllowance(14_000_000)).toBe(0);
    expect(e2bDispatchAllowance(100_000_001)).toBe(90_000_000);
    expect(e2bDispatchAllowance(0)).toBe(0);
  });
  it('rejects inconsistent policy and noninteger balances', () => {
    expect(() =>
      ResourcePolicy.parse({ ...DEFAULT_POLICY, sandboxLifetimeSeconds: 901 }),
    ).toThrow();
    expect(() =>
      ResourcePolicy.parse({
        ...DEFAULT_POLICY,
        metaDispatchCeilingMicroUsd: 140_000_000,
      }),
    ).toThrow();
    expect(() => metaDispatchAllowance(0.5)).toThrow();
    expect(() => e2bDispatchAllowance(-1)).toThrow();
  });
});

describe('cheap upload checks', () => {
  it.each([
    '../x.py',
    '/x.py',
    'C:/x.py',
    'a\\x.py',
    'a//x.py',
    'a/./x.py',
    'CON.py',
    'a./x.py',
    'x.py\0',
    'x.pkl',
    'x.PY',
  ])('rejects unsafe/unsupported path %s', (path) => {
    expect(SafeUploadPath.safeParse(path).success).toBe(false);
  });
  it('accepts nested source and numeric metadata without claiming content inspection', () => {
    expect(
      preflightUploads([file('src/model.py'), file('data/input.npy')]).status,
    ).toBe('ready');
  });
  it('enforces exact combined source boundary and does not overflow', () => {
    expect(
      preflightUploads([file('one.py', 65536), file('two.py', 65536)]).status,
    ).toBe('ready');
    expect(
      preflightUploads([file('one.py', 65536), file('two.py', 65537)]).reasons,
    ).toContain('source_byte_limit');
    expect(
      preflightUploads([
        file('one.py', Number.MAX_SAFE_INTEGER),
        file('two.py', Number.MAX_SAFE_INTEGER),
      ]).reasons,
    ).toContain('upload_byte_limit');
  });
  it('rejects collisions, too many files, absent source and wrong digest', () => {
    expect(
      preflightUploads([file('Src/x.py'), file('src/x.py')]).reasons,
    ).toContain('duplicate_upload_path');
    expect(
      preflightUploads(Array.from({ length: 11 }, (_, n) => file(`${n}.py`)))
        .reasons,
    ).toContain('upload_file_limit');
    expect(preflightUploads([file('x.csv')]).reasons).toContain(
      'python_source_required',
    );
    expect(preflightUploads([{ ...file(), sha256: 'bad' }]).status).toBe(
      'unsupported',
    );
  });
});

describe('answers', () => {
  const id = randomUUID();
  const question = {
    schemaVersion: '1.0',
    id,
    key: 'lengthUnit',
    prompt: 'Length unit?',
    reason: 'Needed for dimensions',
    options: [
      { id: 'metres', label: 'Metres', unknown: false },
      { id: 'unknown', label: 'Unknown', unknown: true },
    ],
    customTextAllowed: true,
    requiredFacts: ['lengthUnit'],
    affectedChecks: ['O_ENERGY'],
  };
  it('preserves conflicting text instead of confirming the chosen option', () => {
    const answer = {
      schemaVersion: '1.0',
      questionId: id,
      selectedOptionId: 'metres',
      customText: 'Actually kilometres',
    };
    const result = acceptAnswer(question, answer);
    expect(result.answer).toEqual(answer);
    expect(result.state).toBe('pending');
    expect(result.facts).toEqual({});
  });
  it('accepts unknown while refusing empty and invented choices', () => {
    const answer = {
      schemaVersion: '1.0',
      questionId: id,
      selectedOptionId: 'unknown',
      customText: '',
    };
    expect(acceptAnswer(question, answer).state).toBe('unknown');
    expect(() =>
      acceptAnswer(question, { ...answer, selectedOptionId: 'invented' }),
    ).toThrow();
    expect(
      Answer.safeParse({ ...answer, selectedOptionId: null }).success,
    ).toBe(false);
  });
});
