import { z } from 'zod';
import { Count, SchemaVersion, Timestamp } from '@siphon/contracts';
import { type MetaUsage } from './meta-client.js';

/** Rates in micro-USD per million tokens; no floating monetary arithmetic. */
export const MetaPricing = z
  .strictObject({
    schemaVersion: SchemaVersion,
    version: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    model: z.literal('muse-wonder-1.0'),
    mode: z.literal('standard'),
    verifiedAt: Timestamp,
    effectiveFrom: Timestamp,
    effectiveUntil: Timestamp,
    inputMicroUsdPerMillion: Count,
    cachedInputMicroUsdPerMillion: Count,
    outputMicroUsdPerMillion: Count,
  })
  .superRefine((value, ctx) => {
    if (
      Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveUntil) ||
      Date.parse(value.verifiedAt) >= Date.parse(value.effectiveUntil)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid pricing validity window',
      });
    if (
      value.inputMicroUsdPerMillion === 0 ||
      value.outputMicroUsdPerMillion === 0 ||
      value.cachedInputMicroUsdPerMillion > value.inputMicroUsdPerMillion
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid token rates' });
  });
export type MetaPricing = z.infer<typeof MetaPricing>;

function money(numerator: bigint): number {
  const value = (numerator + 999999n) / 1000000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Model cost exceeds accounting range');
  return Number(value);
}

export function reserveMetaCost(
  pricingValue: unknown,
  inputTokenBound: number,
  outputTokenBound: number,
  now: Date,
) {
  const pricing = MetaPricing.parse(pricingValue);
  Count.parse(inputTokenBound);
  Count.parse(outputTokenBound);
  if (inputTokenBound < 1 || outputTokenBound < 1)
    throw new Error('Positive token bounds required');
  if (
    !Number.isFinite(now.getTime()) ||
    now.getTime() < Date.parse(pricing.verifiedAt) ||
    now.getTime() < Date.parse(pricing.effectiveFrom) ||
    now.getTime() >= Date.parse(pricing.effectiveUntil)
  )
    throw new Error('Pricing is not verified for dispatch time');
  // Round each billed category upward independently; never reserve cache savings.
  const cost =
    money(BigInt(inputTokenBound) * BigInt(pricing.inputMicroUsdPerMillion)) +
    money(BigInt(outputTokenBound) * BigInt(pricing.outputMicroUsdPerMillion)) +
    1;
  if (!Number.isSafeInteger(cost))
    throw new Error('Model cost exceeds accounting range');
  return {
    pricingVersion: pricing.version,
    // One micro-USD covers separate rounding if actual input splits into two
    // billing categories. It is released at settlement when not consumed.
    microUsd: cost,
  };
}

export function settleMetaCost(
  pricingValue: unknown,
  usage: MetaUsage,
): number {
  const pricing = MetaPricing.parse(pricingValue);
  const input = Count.parse(usage.prompt_tokens);
  const output = Count.parse(usage.completion_tokens);
  const total = Count.parse(usage.total_tokens);
  const cached = Count.parse(usage.prompt_tokens_details?.cached_tokens ?? 0);
  if (cached > input || BigInt(input) + BigInt(output) !== BigInt(total))
    throw new Error('Inconsistent Meta usage');
  // Use the operation's immutable pricing snapshot even after its dispatch
  // window has closed. Reasoning is already included in completion_tokens.
  const result =
    money(BigInt(input - cached) * BigInt(pricing.inputMicroUsdPerMillion)) +
    money(BigInt(cached) * BigInt(pricing.cachedInputMicroUsdPerMillion)) +
    money(BigInt(output) * BigInt(pricing.outputMicroUsdPerMillion));
  if (!Number.isSafeInteger(result))
    throw new Error('Model cost exceeds accounting range');
  return result;
}
