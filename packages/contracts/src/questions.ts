import { z } from 'zod';
import { CheckId, Count, Digest, Fact, Id, SchemaVersion } from './common.js';

export const Question = z
  .strictObject({
    schemaVersion: SchemaVersion,
    id: Id,
    key: z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,99}$/),
    prompt: z.string().min(1).max(2000),
    reason: z.string().min(1).max(2000),
    options: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
          label: z.string().min(1).max(300),
          unknown: z.boolean(),
        }),
      )
      .min(2)
      .max(12),
    customTextAllowed: z.literal(true),
    requiredFacts: z.array(z.string().min(1).max(100)).min(1).max(20),
    affectedChecks: z.array(CheckId).max(10),
  })
  .refine(
    (question) =>
      new Set(question.options.map((option) => option.id)).size ===
      question.options.length,
    { message: 'Option IDs must be unique', path: ['options'] },
  );

export const Answer = z
  .strictObject({
    schemaVersion: SchemaVersion,
    questionId: Id,
    selectedOptionId: z.string().min(1).max(64).nullable(),
    customText: z.string().max(4000),
  })
  .refine(
    (answer) =>
      answer.selectedOptionId !== null || answer.customText.trim().length > 0,
    { message: 'Select an option or provide custom text' },
  );

export const AnswerInterpretation = z.strictObject({
  schemaVersion: SchemaVersion,
  answer: Answer,
  state: z.enum(['pending', 'confirmed', 'unknown', 'needs_reconciliation']),
  facts: z.record(z.string().max(100), Fact),
  explanation: z.string().max(2000),
});

export const QuestionSet = z
  .strictObject({
    schemaVersion: SchemaVersion,
    auditId: Id,
    revisionId: Id,
    inputDigest: Digest,
    questions: z.array(Question).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.questions.map((question) => question.id)).size !==
        value.questions.length ||
      new Set(value.questions.map((question) => question.key)).size !==
        value.questions.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Question IDs and keys must be unique',
      });
  });
export const SubmitAnswers = z
  .strictObject({
    schemaVersion: SchemaVersion,
    expectedGeneration: Count,
    expectedInputDigest: Digest,
    questionSetDigest: Digest,
    answers: z.array(Answer).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.answers.map((answer) => answer.questionId)).size !==
      value.answers.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate question answer' });
  });
export type SubmitAnswers = z.infer<typeof SubmitAnswers>;

// Custom text is never discarded or silently given priority over an option.
export function acceptAnswer(
  questionValue: unknown,
  answerValue: unknown,
): z.infer<typeof AnswerInterpretation> {
  const question = Question.parse(questionValue);
  const answer = Answer.parse(answerValue);
  if (question.id !== answer.questionId) throw new Error('Question mismatch');
  const option = question.options.find(
    (item) => item.id === answer.selectedOptionId,
  );
  if (answer.selectedOptionId !== null && !option)
    throw new Error('Unknown option');
  const hasText = answer.customText.trim().length > 0;
  return {
    schemaVersion: '1.0',
    answer,
    facts: {},
    state: hasText ? 'pending' : option?.unknown ? 'unknown' : 'pending',
    explanation:
      hasText && option
        ? 'Preserve both inputs and reconcile their meaning before confirming facts.'
        : 'Interpretation must be validated before dependent checks proceed.',
  };
}
