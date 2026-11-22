import { describe, expect, it } from 'vitest';
import {
  buildContextQuestions,
  interpretContextAnswers,
  unresolvedContextQuestions,
} from './context-questions.js';
import { validateContextProposal, type Domain } from '@siphon/contracts';
function snapshot(domain: Domain = 'heat_diffusion') {
  return {
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    inputDigest: 'a'.repeat(64),
    domain,
  };
}
describe('deterministic context clarification', () => {
  it.each(['heat_diffusion', 'orbital_dynamics'] as const)(
    'creates domain-specific %s questions with custom and unknown choices',
    (domain) => {
      const set = buildContextQuestions(snapshot(domain));
      expect(set.questions).toHaveLength(7);
      expect(
        set.questions.every(
          (q) =>
            q.customTextAllowed && q.options.some((option) => option.unknown),
        ),
      ).toBe(true);
      expect(
        set.questions
          .flatMap((q) => q.affectedChecks)
          .every((id) =>
            id.startsWith(domain === 'heat_diffusion' ? 'H_' : 'O_'),
          ),
      ).toBe(true);
    },
  );
  it('keeps a selected option and custom text together unresolved', () => {
    const set = buildContextQuestions(snapshot());
    const answer = {
      schemaVersion: '1.0',
      questionId: set.questions[0]!.id,
      selectedOptionId: 'si',
      customText: 'Distance is in centimetres',
    };
    const [result] = interpretContextAnswers('heat_diffusion', set, [answer]);
    expect(result).toMatchObject({
      state: 'needs_reconciliation',
      value: null,
      answer,
    });
    expect(
      unresolvedContextQuestions('heat_diffusion', set, [answer])?.questions,
    ).toHaveLength(7);
  });
  it('resolves option-only declarations while preserving unknown and missing answers', () => {
    const set = buildContextQuestions(snapshot());
    const answers = [
      {
        schemaVersion: '1.0',
        questionId: set.questions[0]!.id,
        selectedOptionId: 'si',
        customText: '',
      },
      {
        schemaVersion: '1.0',
        questionId: set.questions[1]!.id,
        selectedOptionId: 'unknown',
        customText: '',
      },
    ];
    const interpreted = interpretContextAnswers('heat_diffusion', set, answers);
    expect(interpreted[0]).toMatchObject({
      state: 'declared',
      value: 'si',
      provenance: 'user_declaration',
    });
    expect(interpreted[1]).toMatchObject({ state: 'unknown', value: null });
    expect(
      unresolvedContextQuestions('heat_diffusion', set, answers)?.questions,
    ).toHaveLength(6);
  });
  it('does not treat custom units or unsupported geometry as confirmed details', () => {
    const set = buildContextQuestions(snapshot());
    const results = interpretContextAnswers('heat_diffusion', set, [
      {
        schemaVersion: '1.0',
        questionId: set.questions[0]!.id,
        selectedOptionId: 'mixed',
        customText: '',
      },
      {
        schemaVersion: '1.0',
        questionId: set.questions[1]!.id,
        selectedOptionId: 'other',
        customText: '',
      },
    ]);
    expect(
      results.every(
        (result) =>
          result.state === 'needs_reconciliation' && result.value === null,
      ),
    ).toBe(true);
  });
  it('rejects invented options, changed option meanings and duplicate responses', () => {
    const set = buildContextQuestions(snapshot());
    const answer = {
      schemaVersion: '1.0',
      questionId: set.questions[0]!.id,
      selectedOptionId: 'si',
      customText: '',
    };
    expect(() =>
      interpretContextAnswers('heat_diffusion', set, [answer, answer]),
    ).toThrow('Duplicate');
    expect(() =>
      interpretContextAnswers('heat_diffusion', set, [
        { ...answer, selectedOptionId: 'invented' },
      ]),
    ).toThrow('Unknown');
    set.questions[0]!.options[0]!.label = 'Centimetres';
    expect(() =>
      interpretContextAnswers('heat_diffusion', set, [answer]),
    ).toThrow('reviewed');
  });
  it('treats complete option resolution as declarations without issuing check eligibility', () => {
    const set = buildContextQuestions(snapshot());
    const answers = set.questions.map((q) => ({
      schemaVersion: '1.0',
      questionId: q.id,
      selectedOptionId: q.options[0]!.id,
      customText: '',
    }));
    expect(
      unresolvedContextQuestions('heat_diffusion', set, answers),
    ).toBeNull();
    expect(
      interpretContextAnswers('heat_diffusion', set, answers).every(
        (item) => item.provenance === 'user_declaration',
      ),
    ).toBe(true);
  });
});
describe('model context provenance boundary', () => {
  it('validates source locations without promoting inferences to physical facts', () => {
    const base = snapshot();
    const source = {
      artifactId: crypto.randomUUID(),
      sourceDigest: 'b'.repeat(64),
      lineCount: 10,
    };
    const proposal = {
      schemaVersion: '1.0',
      ...base,
      summary: 'A possible heat simulation.',
      domainMismatchSuspected: false,
      candidates: [
        {
          field: 'units',
          description: 'Possibly SI',
          uncertainty: 'inferred',
          citations: [
            {
              artifactId: source.artifactId,
              sourceDigest: source.sourceDigest,
              startLine: 1,
              endLine: 2,
            },
          ],
        },
      ],
    };
    expect(
      validateContextProposal(proposal, { ...base, sources: [source] })
        .candidates[0]?.uncertainty,
    ).toBe('inferred');
    expect(() =>
      validateContextProposal(proposal, {
        ...base,
        domain: 'orbital_dynamics',
        sources: [source],
      }),
    ).toThrow('snapshot');
    expect(() =>
      validateContextProposal(proposal, {
        ...base,
        sources: [{ ...source, sourceDigest: 'c'.repeat(64) }],
      }),
    ).toThrow('citation');
    expect(() =>
      validateContextProposal(proposal, {
        ...base,
        sources: [{ ...source, lineCount: 1 }],
      }),
    ).toThrow('citation');
  });
});
