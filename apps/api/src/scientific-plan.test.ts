import { describe, expect, it } from 'vitest';
import { RequirementId } from '@siphon/contracts';
import { buildScientificPlan } from './scientific-plan.js';

const evidenceId = crypto.randomUUID();
function fixture(domain: 'heat_diffusion' | 'orbital_dynamics') {
  return {
    planId: crypto.randomUUID(),
    auditId: crypto.randomUUID(),
    revisionId: crypto.randomUUID(),
    eligibilityInput: {
      schemaVersion: '1.0',
      domain,
      inputDigest: 'a'.repeat(64),
      contextDigest: 'b'.repeat(64),
      adapterDigest: 'c'.repeat(64),
      assertions: RequirementId.options.map((requirement) => ({
        requirement,
        state: 'satisfied',
        evidenceIds: [evidenceId],
      })),
    },
    profile:
      domain === 'heat_diffusion' ? 'heat_energy_si' : 'isolated_orbits_si',
    sourceOperationId: crypto.randomUUID(),
    sourceOutputDigest: 'd'.repeat(64),
    createdAt: '2026-11-10T18:00:00.000Z',
  };
}

describe('scientific plan construction', () => {
  it('plans only released heat energy against the exact stored baseline with no invented target', () => {
    const f = fixture('heat_diffusion'),
      plan = buildScientificPlan(f);
    expect(
      plan.checks
        .filter((item) => item.selection === 'selected')
        .map((item) => item.checkId),
    ).toEqual(['H_ENERGY']);
    expect(
      plan.checks.filter((item) => item.selection === 'excluded'),
    ).toHaveLength(4);
    expect(plan.experiments[0]).toMatchObject({
      id: f.sourceOperationId,
      sourceOperationId: f.sourceOperationId,
      resultDigest: f.sourceOutputDigest,
    });
    expect(plan.accuracyPolicies.H_ENERGY).toEqual({
      scope: 'reported_samples',
      target: null,
    });
  });
  it('plans the applicable isolated gravity checks and never enables unreleased refinement', () => {
    const plan = buildScientificPlan(fixture('orbital_dynamics'));
    expect(
      plan.checks
        .filter((item) => item.selection === 'selected')
        .map((item) => item.checkId),
    ).toEqual(['O_ENERGY', 'O_ANGULAR', 'O_MOMENTUM']);
    expect(
      plan.checks.find((item) => item.checkId === 'O_REFINE')?.selection,
    ).toBe('excluded');
  });
  it('excludes system momentum for a fixed central field', () => {
    const f = fixture('orbital_dynamics');
    f.profile = 'central_orbit_si';
    f.eligibilityInput.assertions = f.eligibilityInput.assertions.map((item) =>
      item.requirement === 'isolated_mutual_gravity'
        ? { ...item, state: 'violated' }
        : item,
    );
    const plan = buildScientificPlan(f);
    expect(
      plan.checks
        .filter((item) => item.selection === 'selected')
        .map((item) => item.checkId),
    ).toEqual(['O_ENERGY', 'O_ANGULAR']);
    expect(
      plan.checks.find((item) => item.checkId === 'O_MOMENTUM')?.selection,
    ).toBe('excluded');
  });
  it('rejects missing budget, conflicting facts and incompatible profiles', () => {
    const heat = fixture('heat_diffusion');
    heat.eligibilityInput.assertions = heat.eligibilityInput.assertions.filter(
      (item) => item.requirement !== 'resource_budget_available',
    );
    expect(() => buildScientificPlan(heat)).toThrow(
      'No scientifically eligible',
    );
    const orbit = fixture('orbital_dynamics');
    orbit.profile = 'central_orbit_si';
    expect(() => buildScientificPlan(orbit)).toThrow('evaluation profile');
    const conflict = fixture('heat_diffusion');
    conflict.eligibilityInput.assertions =
      conflict.eligibilityInput.assertions.map((item) =>
        item.requirement === 'thermal_weights'
          ? { ...item, state: 'conflicting' }
          : item,
      );
    expect(() => buildScientificPlan(conflict)).toThrow(
      'No scientifically eligible',
    );
  });
});
