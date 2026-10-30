import { describe, expect, it } from 'vitest';
import {
  EligibilityInput,
  RequirementId,
  type RequirementAssertion,
} from '@siphon/contracts';
import { assessEligibility, evaluateRequirements } from './eligibility.js';

const evidence = '9bdc07d8-e57a-41d2-9222-d8f7ef166f7b';
const input = {
  schemaVersion: '1.0',
  domain: 'heat_diffusion',
  inputDigest: 'a'.repeat(64),
  contextDigest: 'b'.repeat(64),
  adapterDigest: 'c'.repeat(64),
  assertions: [],
};
function assertion(
  requirement: RequirementId,
  state: RequirementAssertion['state'],
): RequirementAssertion {
  return { requirement, state, evidenceIds: [evidence] };
}
const satisfied = () =>
  RequirementId.options.map((key) => assertion(key, 'satisfied'));

describe('deterministic eligibility', () => {
  it('preserves missing/unknown/conflicting requirements without calling them failures', () => {
    const result = evaluateRequirements(
      ['confirmed_units', 'verified_adapter', 'finite_observations'],
      [
        assertion('confirmed_units', 'unknown'),
        assertion('verified_adapter', 'conflicting'),
      ],
    );
    expect(result.applicability).toBe('unresolved');
    expect(result.reasons.map((item) => item.code)).toEqual([
      'unknown',
      'conflicting',
      'missing',
    ]);
  });
  it('retains missing facts even when a confirmed incompatibility excludes the check', () => {
    const result = evaluateRequirements(
      ['confirmed_units', 'verified_adapter'],
      [assertion('confirmed_units', 'violated')],
    );
    expect(result.applicability).toBe('ineligible');
    expect(result.reasons).toHaveLength(2);
  });
  it('requires every predicate, and ignores unrelated satisfied facts', () => {
    expect(
      evaluateRequirements(
        ['confirmed_units'],
        [assertion('verified_adapter', 'satisfied')],
      ).applicability,
    ).toBe('unresolved');
    expect(
      evaluateRequirements(
        ['confirmed_units'],
        [assertion('confirmed_units', 'satisfied')],
      ),
    ).toEqual({ applicability: 'eligible', reasons: [] });
  });
  it('releases only validated sampled conservation methods, preserving all other release gates', () => {
    for (const domain of ['heat_diffusion', 'orbital_dynamics']) {
      const result = assessEligibility({
        ...input,
        domain,
        assertions: satisfied(),
      });
      expect(result.decisions).toHaveLength(5);
      for (const decision of result.decisions) {
        expect(decision.applicability).toBe('eligible');
        const released = [
          'H_ENERGY',
          'O_ENERGY',
          'O_ANGULAR',
          'O_MOMENTUM',
        ].includes(decision.checkId);
        expect(decision.status).toBe(released ? 'eligible' : 'ineligible');
        expect(decision.released).toBe(released);
        expect(decision.reasons).toEqual(
          released ? [] : [{ requirement: null, code: 'check_not_released' }],
        );
      }
    }
  });
  it('does not apply isolated-system momentum to a fixed central field', () => {
    const assertions = satisfied().map((item) =>
      item.requirement === 'isolated_mutual_gravity'
        ? assertion(item.requirement, 'violated')
        : item,
    );
    const result = assessEligibility({
      ...input,
      domain: 'orbital_dynamics',
      assertions,
    });
    expect(
      result.decisions.find((item) => item.checkId === 'O_MOMENTUM')
        ?.applicability,
    ).toBe('ineligible');
    expect(
      result.decisions.find((item) => item.checkId === 'O_ENERGY')
        ?.applicability,
    ).toBe('eligible');
  });
  it('keeps driven thermal models out of source-free energy conservation', () => {
    const assertions = satisfied().map((item) =>
      item.requirement === 'no_heat_sources'
        ? assertion(item.requirement, 'violated')
        : item,
    );
    const result = assessEligibility({ ...input, assertions });
    expect(
      result.decisions.find((item) => item.checkId === 'H_ENERGY')
        ?.applicability,
    ).toBe('ineligible');
    expect(
      result.decisions.find((item) => item.checkId === 'H_BALANCE')
        ?.applicability,
    ).toBe('eligible');
  });
  it('rejects duplicate assertions, missing evidence and model-provided release overrides', () => {
    const item = assertion('confirmed_units', 'satisfied');
    expect(() =>
      assessEligibility({ ...input, assertions: [item, item] }),
    ).toThrow();
    expect(() =>
      evaluateRequirements(['confirmed_units'], [item, item]),
    ).toThrow();
    expect(
      EligibilityInput.safeParse({
        ...input,
        assertions: [{ ...item, evidenceIds: [] }],
      }).success,
    ).toBe(false);
    expect(() => assessEligibility({ ...input, released: true })).toThrow();
  });
  it('binds output to all input snapshot digests and the explicit domain', () => {
    const result = assessEligibility(input);
    expect(result).toMatchObject({
      inputDigest: input.inputDigest,
      contextDigest: input.contextDigest,
      adapterDigest: input.adapterDigest,
    });
    expect(
      result.decisions.every((item) => item.checkId.startsWith('H_')),
    ).toBe(true);
  });
});
