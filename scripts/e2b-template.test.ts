import { describe, expect, it } from 'vitest';
import { Template } from 'e2b';
import {
  createSiphonTemplate,
  e2bTemplateFileIgnores,
} from './e2b-template.js';

describe('E2B template definition', () => {
  const image = `e2bdev/base@sha256:${'a'.repeat(64)}`;
  const templateBase = {
    kind: 'template' as const,
    templateId: 'source-base',
    tag: `siphon-${'a'.repeat(32)}`,
    buildId: `${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`,
  };

  it('requires a digest-pinned image or a build-verified template base', () => {
    expect(() =>
      createSiphonTemplate(
        { kind: 'image', image: 'e2bdev/base:latest' },
        'user',
      ),
    ).toThrow();
    expect(() =>
      createSiphonTemplate({ kind: 'image', image }, 'root'),
    ).toThrow();
    expect(() =>
      createSiphonTemplate({ kind: 'image', image }, 'user;id'),
    ).toThrow();
    expect(() =>
      createSiphonTemplate({ ...templateBase, buildId: 'mutable' }),
    ).toThrow();
    expect(() => createSiphonTemplate(templateBase, 'user')).toThrow();
  });

  it('serializes the science package, isolated interpreter and job staging paths', async () => {
    const definition = await Template.toJSON(
      createSiphonTemplate({ kind: 'image', image }, 'user'),
      true,
    );
    expect(definition).toContain('packages/science/siphon_science');
    expect(definition).toContain('packages/science/requirements.txt');
    expect(definition).toContain('/opt/siphon/venv');
    expect(definition).toContain('usermod -G');
    expect(definition).toContain('passwd -l root');
    expect(definition).toContain('chmod 0700');
    expect(e2bTemplateFileIgnores).toContain('.dev.vars');
    expect(e2bTemplateFileIgnores).toContain('.dev.vars.*');
    expect(e2bTemplateFileIgnores).toContain('node_modules/**');
    expect(e2bTemplateFileIgnores).toContain('.wrangler/**');
  });

  it('inherits a hardened template base and replaces the installed science package', async () => {
    const definition = await Template.toJSON(
      createSiphonTemplate(templateBase),
      true,
    );
    expect(definition).toContain(
      `${templateBase.templateId}:${templateBase.tag}`,
    );
    expect(definition).toContain('packages/science/siphon_science');
    expect(definition).toContain(
      'rm -rf /opt/siphon/venv/lib/python3.11/site-packages/siphon_science',
    );
    expect(definition).not.toContain('usermod -G');
    expect(definition).not.toContain('passwd -l root');
  });
});
