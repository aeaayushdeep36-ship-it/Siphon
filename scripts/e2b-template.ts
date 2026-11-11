import { fileURLToPath } from 'node:url';
import { Template } from 'e2b';

export const sandboxRoles = [
  'inspection',
  'source',
  'evaluation',
  'pdf',
] as const;
export type SandboxRole = (typeof sandboxRoles)[number];

export type SiphonTemplateBase =
  | { kind: 'image'; image: string }
  | {
      kind: 'template';
      templateId: string;
      tag: string;
      buildId: string;
    };

const providerId = /^[a-zA-Z0-9_-]{1,128}$/;
const buildTag = /^siphon-[a-f0-9]{32}$/;
export const e2bTemplateFileIgnores = [
  '**/__pycache__/**',
  '**/*.pyc',
  '.dev.vars',
  '.dev.vars.*',
  '.env',
  '.env.*',
  '.git/**',
  '**/.git/**',
  'node_modules/**',
  '**/node_modules/**',
  '.wrangler/**',
  '**/.wrangler/**',
] as const;

/** This definition prepares an image; it does not attest to its security or cost. */
export function createSiphonTemplate(
  base: SiphonTemplateBase,
  runtimeUser?: string,
) {
  if (base.kind === 'image') {
    if (!/^[a-zA-Z0-9._/:-]+@sha256:[a-f0-9]{64}$/.test(base.image))
      throw new Error('Base image must be an explicit sha256-pinned image');
    if (
      !runtimeUser ||
      !/^[a-z_][a-z0-9_-]{0,31}$/.test(runtimeUser) ||
      runtimeUser === 'root'
    )
      throw new Error('Runtime user must be a non-root Unix username');
  } else if (
    !providerId.test(base.templateId) ||
    !buildTag.test(base.tag) ||
    !/^[a-f0-9-]{36}$/.test(base.buildId)
  ) {
    throw new Error(
      'Base template must identify a verified build-specific tag',
    );
  } else if (runtimeUser !== undefined) {
    throw new Error(
      'A template base inherits its already-hardened runtime user',
    );
  }

  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const template = Template({
    fileContextPath: projectRoot,
    fileIgnorePatterns: [...e2bTemplateFileIgnores],
  });
  let builder =
    base.kind === 'image'
      ? template.fromImage(base.image)
      : template.fromTemplate(`${base.templateId}:${base.tag}`);
  builder = builder
    .remove('/opt/siphon/input/siphon_science', {
      recursive: true,
      force: true,
      user: 'root',
    })
    .makeDir('/opt/siphon/input', { user: 'root' })
    .copy(
      'packages/science/requirements.txt',
      '/opt/siphon/input/requirements.txt',
      { user: 'root' },
    )
    .copy(
      'packages/science/siphon_science',
      '/opt/siphon/input/siphon_science',
      { user: 'root' },
    )
    .runCmd(
      [
        'python3 -c "import sys; assert sys.version_info[:2] == (3, 11)"',
        'python3 -m venv /opt/siphon/venv',
        '/opt/siphon/venv/bin/pip install --no-cache-dir -r /opt/siphon/input/requirements.txt',
        'rm -rf /opt/siphon/venv/lib/python3.11/site-packages/siphon_science',
        'cp -R /opt/siphon/input/siphon_science /opt/siphon/venv/lib/python3.11/site-packages/',
        '/opt/siphon/venv/bin/python -I -c "import numpy, pydantic, reportlab, siphon_science.inspection_job, siphon_science.source_job, siphon_science.reference_source_job, siphon_science.validation_job, siphon_science.diagnostics_job, siphon_science.experiments, siphon_science.fidelity_job, siphon_science.pdf_job"',
        'chmod -R go-w /opt/siphon',
      ],
      { user: 'root' },
    );
  if (base.kind === 'image')
    builder = builder
      .runCmd(
        [
          `usermod -G "$(id -gn ${runtimeUser!})" ${runtimeUser!}`,
          'passwd -l root',
          'if command -v sudo >/dev/null 2>&1; then chmod 0700 "$(command -v sudo)"; fi',
          'if command -v su >/dev/null 2>&1; then chmod 0700 "$(command -v su)"; fi',
        ],
        { user: 'root' },
      )
      .setUser(runtimeUser!);
  return builder;
}
