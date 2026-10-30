import { describe, expect, it } from 'vitest';
import {
  buildAdapterQuestions,
  interpretAdapterAnswers,
} from './adapter-questions.js';
import { adapterStageFixture } from '../test/adapter-stage-fixture.js';

describe('adapter meaning questions', () => {
  it('asks separately about every actual mapping and preserves an unknown and custom option', async () => {
    const f = await adapterStageFixture(),
      set = buildAdapterQuestions(f.adapter);
    expect(set.questions).toHaveLength(f.adapter.mappings.length);
    for (const mapping of f.adapter.mappings) {
      const question = set.questions.find(
        (q) => q.key === `adapter.${mapping.key}`,
      )!;
      expect(question.prompt).toContain(mapping.root);
      expect(question.prompt).toContain(mapping.declaredUnit);
      expect(question.prompt).toContain(
        `axis order [${mapping.axisOrder.join(', ')}]`,
      );
      expect(question.customTextAllowed).toBe(true);
      expect(question.options.some((option) => option.unknown)).toBe(true);
    }
  });
  it('preserves uncertain and custom answers instead of treating them as confirmed', async () => {
    const f = await adapterStageFixture(),
      set = buildAdapterQuestions(f.adapter);
    const answers = set.questions.map((q) => ({
      schemaVersion: '1.0' as const,
      questionId: q.id,
      selectedOptionId: 'confirm',
      customText: '',
    }));
    expect(
      interpretAdapterAnswers(f.adapter, set, answers).allDeclaredConfirmed,
    ).toBe(true);
    answers[0]!.customText = 'Actually I am unsure about the units';
    const reconciled = interpretAdapterAnswers(f.adapter, set, answers);
    expect(reconciled.allDeclaredConfirmed).toBe(false);
    expect(reconciled.decisions[0]!.state).toBe('needs_reconciliation');
    answers[0]!.customText = '';
    answers[0]!.selectedOptionId = 'unknown';
    expect(
      interpretAdapterAnswers(f.adapter, set, answers).decisions[0]!.state,
    ).toBe('unknown');
    expect(() =>
      interpretAdapterAnswers(f.adapter, set, [...answers, answers[0]!]),
    ).toThrow();
    const altered = structuredClone(set);
    altered.questions[0]!.prompt = 'Confirm a different variable';
    expect(() => interpretAdapterAnswers(f.adapter, altered, answers)).toThrow(
      'content does not match',
    );
  });
});
