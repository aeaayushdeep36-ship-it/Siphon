import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '@siphon/contracts';
import { sciencePython } from '../../../scripts/science-python.js';
import { groqFixtureConfig } from '../test/groq-stage-fixture.js';
import { prepareInvestigationRequest } from './investigation-request.js';
import { validateInvestigationDraft } from './investigation-draft.js';

function authoredHeatEvidence() {
  const result = spawnSync(
    sciencePython,
    [
      '-c',
      [
        'import json',
        'from test_scientific_checks import heat_case',
        'from siphon_science.experiments import evaluate_conservation_job',
        'request, payloads = heat_case(faulty=False)',
        'print(json.dumps({"request": request, "evidence": evaluate_conservation_job(request, payloads)}))',
      ].join('\n'),
    ],
    {
      cwd: resolve('packages/science'),
      env: {
        ...process.env,
        PYTHONPATH: [
          resolve('packages/science'),
          resolve('packages/science/tests'),
        ].join(delimiter),
      },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Authored evidence fixture failed');
  return JSON.parse(result.stdout) as {
    request: unknown;
    evidence: { evidence: Array<{ metric: { value: number } }> };
  };
}

describe('data-only investigation preparation', () => {
  it('binds an authored validated measurement without sending source or credentials', async () => {
    const fixture = authoredHeatEvidence();
    const prepared = await prepareInvestigationRequest(
      fixture.evidence,
      fixture.request,
      DEFAULT_POLICY,
      groqFixtureConfig,
    );
    const body = JSON.stringify(prepared.request);
    expect(body).not.toContain(groqFixtureConfig.apiKey);
    expect(body).not.toContain('dataBase64');
    expect(prepared.request.messages[0].content).toContain(
      'do not change verdicts',
    );
    const { evidenceIds, ...identity } = prepared.expected;
    expect(evidenceIds).toHaveLength(1);
    expect(
      validateInvestigationDraft(
        {
          schemaVersion: '1.0',
          ...identity,
          hypotheses: [],
          recommendations: [],
        },
        prepared.expected,
      ),
    ).toBeDefined();
  });
  it('rejects changed evidence and requests beyond the configured byte bound', async () => {
    const fixture = authoredHeatEvidence();
    fixture.evidence.evidence[0]!.metric.value += 1;
    await expect(
      prepareInvestigationRequest(
        fixture.evidence,
        fixture.request,
        DEFAULT_POLICY,
        groqFixtureConfig,
      ),
    ).rejects.toThrow();
    const valid = authoredHeatEvidence();
    await expect(
      prepareInvestigationRequest(
        valid.evidence,
        valid.request,
        DEFAULT_POLICY,
        { ...groqFixtureConfig, maxInputBytes: 1 },
      ),
    ).rejects.toThrow('byte limit');
  });
});
