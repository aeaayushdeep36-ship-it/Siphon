import { z } from 'zod';
import { Template } from 'e2b';

const TemplateAccountRecord = z.object({
  templateID: z.string().min(1).max(128),
  buildID: z.string().uuid(),
  buildCount: z.number().int().nonnegative(),
  public: z.boolean(),
});

const roles = ['inspection', 'source', 'evaluation', 'pdf'] as const;

type Role = (typeof roles)[number];
type ConfiguredTemplate = {
  role: Role;
  templateId: string;
  buildId: string;
  tag: string;
};

function readConfiguredTemplates(): ConfiguredTemplate[] {
  const configured = roles.flatMap((role) => {
    const prefix = `SIPHON_${role.toUpperCase()}_TEMPLATE`;
    const templateId = process.env[`${prefix}_ID`];
    const buildId = process.env[`${prefix}_BUILD_ID`];
    const tag = process.env[`${prefix}_TAG`];
    if (!templateId && !buildId && !tag) return [];
    if (
      !templateId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) ||
      !buildId ||
      !/^[a-f0-9-]{36}$/.test(buildId) ||
      !tag ||
      !/^siphon-[a-f0-9]{32}$/.test(tag)
    )
      throw new Error(`Missing or invalid ${role} template configuration`);
    return [{ role, templateId, buildId, tag }];
  });
  if (!configured.length) throw new Error('No template roles are configured');
  return configured;
}

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error('E2B_API_KEY is required');
const apiUrl = new URL(process.env.E2B_API_URL ?? 'https://api.e2b.app');
if (apiUrl.protocol !== 'https:') throw new Error('E2B_API_URL must use HTTPS');

const results = await Promise.all(
  readConfiguredTemplates().map(async (configured) => {
    const response = await fetch(
      new URL(
        `/templates/${encodeURIComponent(configured.templateId)}`,
        apiUrl,
      ),
      {
        headers: { 'X-API-Key': apiKey },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return {
        role: configured.role,
        templateId: configured.templateId,
        status: 'provider_error',
        httpStatus: response.status,
      };
    }
    const record = TemplateAccountRecord.parse(await response.json());
    const tags = await Template.getTags(configured.templateId, {
      apiKey,
      retries: 0,
      requestTimeoutMs: 30_000,
    });
    const mappedBuildId =
      tags.find((item) => item.tag === configured.tag)?.buildId ?? null;
    const singlePrivateBuild =
      record.templateID === configured.templateId &&
      record.buildID === configured.buildId &&
      record.buildCount === 1 &&
      record.public === false;
    const tagMatches = mappedBuildId === configured.buildId;
    return {
      role: configured.role,
      templateId: configured.templateId,
      status: singlePrivateBuild && tagMatches ? 'verified' : 'review_required',
      buildCount: record.buildCount,
      private: !record.public,
      currentBuildMatches: record.buildID === configured.buildId,
      tagMatches,
    };
  }),
);

console.log(JSON.stringify({ results }, null, 2));
if (results.some((result) => result.status !== 'verified'))
  process.exitCode = 1;
