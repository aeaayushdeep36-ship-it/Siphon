import { AdapterProposal, Answer, QuestionSet } from '@siphon/contracts';
import { z } from 'zod';
import { canonicalJson } from './hashing.js';

/** Human declarations about meaning, not proof that a proposed mapping is true.
 * Every mapping gets its own answer; corrections and unknowns remain unresolved.
 */
export function buildAdapterQuestions(value: unknown) {
  const proposal = AdapterProposal.parse(value);
  return QuestionSet.parse({
    schemaVersion: '1.0',
    auditId: proposal.auditId,
    revisionId: proposal.revisionId,
    inputDigest: proposal.inputDigest,
    questions: proposal.mappings.map((mapping) => {
      const selector =
        mapping.root +
        mapping.steps
          .map((step) =>
            step.kind === 'key'
              ? `[${JSON.stringify(step.key)}]`
              : `[${step.index}]`,
          )
          .join('');
      const shape = mapping.expectedShape.length
        ? mapping.expectedShape.join(' × ')
        : 'scalar';
      return {
        schemaVersion: '1.0',
        id: crypto.randomUUID(),
        key: `adapter.${mapping.key}`,
        prompt: `Does ${selector} represent ${mapping.key} in your simulation, with canonical shape ${shape}, axis order [${mapping.axisOrder.join(', ')}] and unit ${mapping.declaredUnit}?`,
        reason:
          'The automatic proposal and repeated values cannot establish the meaning of a variable, its axes, or its unit.',
        options: [
          {
            id: 'confirm',
            label: 'Yes, this mapping, shape and unit describe my simulation',
            unknown: false,
          },
          {
            id: 'incorrect',
            label: 'No, at least one detail is incorrect',
            unknown: false,
          },
          { id: 'unknown', label: 'I am not sure', unknown: true },
        ],
        customTextAllowed: true,
        requiredFacts: [`adapter.${mapping.key}`],
        affectedChecks: [],
      };
    }),
  });
}

/** A confirmation is a user declaration only. Custom text and unknown answers
 * require reconciliation and can never silently become confirmations. */
export function interpretAdapterAnswers(
  proposalValue: unknown,
  questionSetValue: unknown,
  answersValue: unknown,
) {
  const proposal = AdapterProposal.parse(proposalValue),
    questions = QuestionSet.parse(questionSetValue),
    answers = z.array(Answer).max(20).parse(answersValue);
  if (
    questions.auditId !== proposal.auditId ||
    questions.revisionId !== proposal.revisionId ||
    questions.inputDigest !== proposal.inputDigest ||
    questions.questions.length !== proposal.mappings.length ||
    new Set(answers.map((answer) => answer.questionId)).size !== answers.length
  )
    throw new Error('Adapter question snapshot mismatch');
  // The user must have seen the exact server-generated selector, shape, unit,
  // and option meanings for this proposal. IDs are intentionally arbitrary.
  const expected = buildAdapterQuestions(proposal);
  for (const expectedQuestion of expected.questions) {
    const actual = questions.questions.find(
      (item) => item.key === expectedQuestion.key,
    );
    if (
      !actual ||
      canonicalJson({ ...actual, id: expectedQuestion.id }) !==
        canonicalJson(expectedQuestion)
    )
      throw new Error('Adapter question content does not match proposal');
  }
  const decisions = proposal.mappings.map((mapping) => {
    const matches = questions.questions.filter(
      (question) => question.key === `adapter.${mapping.key}`,
    );
    if (matches.length !== 1)
      throw new Error('Adapter question mapping mismatch');
    const question = matches[0]!,
      answer = answers.find((item) => item.questionId === question.id);
    if (
      answer?.selectedOptionId !== null &&
      answer?.selectedOptionId !== undefined &&
      !question.options.some((option) => option.id === answer.selectedOptionId)
    )
      throw new Error('Unknown adapter answer option');
    const state = answer?.customText.trim()
      ? 'needs_reconciliation'
      : answer?.selectedOptionId === 'confirm'
        ? 'declared_confirmed'
        : answer?.selectedOptionId === 'incorrect'
          ? 'declared_incorrect'
          : 'unknown';
    return {
      key: mapping.key,
      questionId: question.id,
      state,
      answer: answer ?? null,
    };
  });
  if (
    answers.some(
      (answer) =>
        !questions.questions.some(
          (question) => question.id === answer.questionId,
        ),
    )
  )
    throw new Error('Answer is not part of adapter question set');
  return {
    schemaVersion: '1.0' as const,
    auditId: proposal.auditId,
    revisionId: proposal.revisionId,
    inputDigest: proposal.inputDigest,
    decisions,
    allDeclaredConfirmed: decisions.every(
      (item) => item.state === 'declared_confirmed',
    ),
  };
}
