import { Template } from 'e2b';
import {
  createSiphonTemplate,
  sandboxRoles,
  type SiphonTemplateBase,
} from './e2b-template.js';

const [role, alias] = process.argv.slice(2);
const baseImage = process.env.SIPHON_E2B_BASE_IMAGE ?? '';
const runtimeUser = process.env.SIPHON_E2B_RUNTIME_USER ?? '';
const baseTemplateId = process.env.SIPHON_E2B_BASE_TEMPLATE_ID ?? '';
const baseTemplateTag = process.env.SIPHON_E2B_BASE_TEMPLATE_TAG ?? '';
const baseTemplateBuildId = process.env.SIPHON_E2B_BASE_TEMPLATE_BUILD_ID ?? '';
const cpuCount = Number(process.env.SIPHON_E2B_BUILD_CPU);
const memoryMB = Number(process.env.SIPHON_E2B_BUILD_MEMORY_MB);
const hasTemplateBase = Boolean(
  baseTemplateId || baseTemplateTag || baseTemplateBuildId,
);
const hasValidTemplateBase =
  /^[a-zA-Z0-9_-]{1,128}$/.test(baseTemplateId) &&
  /^siphon-[a-f0-9]{32}$/.test(baseTemplateTag) &&
  /^[a-f0-9-]{36}$/.test(baseTemplateBuildId);
const hasImageBase = Boolean(baseImage || runtimeUser);
const base: SiphonTemplateBase | undefined = hasValidTemplateBase
  ? {
      kind: 'template',
      templateId: baseTemplateId,
      tag: baseTemplateTag,
      buildId: baseTemplateBuildId,
    }
  : baseImage && runtimeUser && !hasTemplateBase
    ? { kind: 'image', image: baseImage }
    : undefined;

if (
  !role ||
  !sandboxRoles.some((value) => value === role) ||
  !alias ||
  !/^[a-zA-Z0-9_-]{1,64}$/.test(alias) ||
  !Number.isInteger(cpuCount) ||
  cpuCount < 1 ||
  cpuCount > 8 ||
  !Number.isInteger(memoryMB) ||
  memoryMB < 128 ||
  memoryMB > 8192 ||
  !process.env.E2B_API_KEY ||
  !base ||
  (hasTemplateBase && hasImageBase)
)
  throw new Error(
    'Provide a valid role, alias, E2B_API_KEY, one verified template base or pinned image/runtime user, and build resource settings',
  );
const configuredBase = base;
if (!configuredBase) throw new Error('A valid template base is required');

async function verifyBaseTemplate() {
  if (configuredBase.kind !== 'template') return;
  const tags = await Template.getTags(configuredBase.templateId, {
    retries: 0,
    requestTimeoutMs: 30_000,
  });
  if (
    tags.find((item) => item.tag === configuredBase.tag)?.buildId !==
    configuredBase.buildId
  )
    throw new Error('Base template tag does not match its configured build ID');
}

await verifyBaseTemplate();
const template = createSiphonTemplate(
  configuredBase,
  configuredBase.kind === 'image' ? runtimeUser : undefined,
);
// Avoid accidental replacement; this check is not an atomic immutability guarantee.
if (await Template.exists(alias, { retries: 0 }))
  throw new Error(
    'Template name already exists; choose a new name for each build',
  );
const result = await Template.build(template, alias, { cpuCount, memoryMB });
await verifyBaseTemplate();
const templateTag = `siphon-${result.buildId.replaceAll('-', '')}`;
await Template.assignTags(`${result.templateId}:default`, templateTag, {
  retries: 0,
});
const assigned = await Template.getTags(result.templateId, { retries: 0 });
if (
  assigned.find((item) => item.tag === templateTag)?.buildId !== result.buildId
)
  throw new Error('E2B build tag verification failed');
// Build identifiers do not certify isolation, resource enforcement or billing.
console.log(
  JSON.stringify({
    role,
    base:
      configuredBase.kind === 'image'
        ? { kind: configuredBase.kind, image: configuredBase.image }
        : {
            kind: configuredBase.kind,
            templateId: configuredBase.templateId,
            tag: configuredBase.tag,
            buildId: configuredBase.buildId,
          },
    templateId: result.templateId,
    buildId: result.buildId,
    templateTag,
    templateSelector: `${result.templateId}:${templateTag}`,
  }),
);
