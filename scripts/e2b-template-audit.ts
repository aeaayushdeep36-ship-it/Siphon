import { pathToFileURL } from 'node:url';
import { e2bApiUrl } from '../apps/api/src/e2b-endpoint.js';
import { verifyE2bTemplate } from '../apps/api/src/e2b-client.js';

const roles = ['inspection', 'source', 'evaluation', 'pdf'] as const;

type Role = (typeof roles)[number];
type ConfiguredTemplate = {
  role: Role;
  templateId: string;
  buildId: string;
  tag: string;
};

function readConfiguredTemplates(
  environment: NodeJS.ProcessEnv,
): ConfiguredTemplate[] {
  const configured = roles.flatMap((role) => {
    const prefix = `SIPHON_${role.toUpperCase()}_TEMPLATE`;
    const templateId = environment[`${prefix}_ID`];
    const buildId = environment[`${prefix}_BUILD_ID`];
    const tag = environment[`${prefix}_TAG`];
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

export async function auditConfiguredTemplates(
  environment: NodeJS.ProcessEnv,
  verify: typeof verifyE2bTemplate = verifyE2bTemplate,
) {
  const apiKey = environment.E2B_API_KEY;
  if (!apiKey?.trim()) throw new Error('E2B_API_KEY is required');
  const apiUrl = e2bApiUrl(environment.E2B_API_URL);
  return Promise.all(
    readConfiguredTemplates(environment).map(async (configured) => {
      try {
        const record = await verify(
          apiKey,
          configured.templateId,
          configured.tag,
          AbortSignal.timeout(30_000),
          apiUrl,
        );
        if (!record) throw new Error('Provider template unavailable');
        const tagMatches = record.tagBuildId === configured.buildId;
        const singlePrivateBuild =
          record.buildId === configured.buildId &&
          record.buildCount === 1 &&
          record.isPrivate;
        return {
          role: configured.role,
          templateId: configured.templateId,
          status:
            singlePrivateBuild && tagMatches ? 'verified' : 'review_required',
          buildCount: record.buildCount,
          private: record.isPrivate,
          currentBuildMatches: record.buildId === configured.buildId,
          tagMatches,
        };
      } catch {
        // Provider errors can contain credentials or private response bodies.
        return {
          role: configured.role,
          templateId: configured.templateId,
          status: 'provider_error',
        };
      }
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const results = await auditConfiguredTemplates(process.env);
    console.log(JSON.stringify({ results }, null, 2));
    if (results.some((result) => result.status !== 'verified'))
      process.exitCode = 1;
  } catch {
    console.error('E2B template audit configuration is invalid or unavailable');
    process.exitCode = 1;
  }
}
