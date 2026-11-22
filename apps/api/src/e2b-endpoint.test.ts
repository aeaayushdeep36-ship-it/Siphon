import { afterEach, describe, expect, it, vi } from 'vitest';
import { Template } from 'e2b';
import { E2bApiUrl, e2bApiUrl } from './e2b-endpoint.js';
import { E2bClient, verifyE2bTemplate } from './e2b-client.js';
import { auditConfiguredTemplates } from '../../../scripts/e2b-template-audit.js';

const boundSdk = vi.hoisted(() => ({
  options: vi.fn(),
  kill: vi.fn(async () => true),
}));

// The callable SDK proxy caches bound statics, so mock the module boundary.
vi.mock('e2b', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('e2b')>();
  return {
    ...sdk,
    Template: { getTags: vi.fn() },
    E2B: class {
      constructor(options: unknown) {
        boundSdk.options(options);
      }
      Sandbox = { kill: boundSdk.kill };
    },
  };
});

const buildId = '02b4915f-b76b-42f0-8ce0-4616cac316bf';
const tag = `siphon-${buildId.replaceAll('-', '')}`;
const environment = {
  E2B_API_KEY: 'authored-test-key',
  SIPHON_SOURCE_TEMPLATE_ID: 'source-template',
  SIPHON_SOURCE_TEMPLATE_BUILD_ID: buildId,
  SIPHON_SOURCE_TEMPLATE_TAG: tag,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E2B endpoint and read-only template audit', () => {
  it('binds the endpoint through the SDK client for termination and records proof', async () => {
    const gate = {
      authorizeCreate: vi.fn(async () => {}),
      recordCreated: vi.fn(async () => {}),
      authorizeKill: vi.fn(async () => {}),
      recordTermination: vi.fn(async () => {}),
    };
    const operationId = crypto.randomUUID();
    const client = new E2bClient(
      'authored-test-key',
      gate,
      undefined,
      'https://api.example.test/',
    );
    expect(await client.kill(operationId, 'sandbox-123')).toBe('killed');
    expect(boundSdk.options).toHaveBeenCalledWith({
      apiUrl: 'https://api.example.test',
    });
    expect(boundSdk.kill).toHaveBeenCalledWith(
      'sandbox-123',
      expect.objectContaining({
        apiUrl: 'https://api.example.test',
        retries: 0,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(gate.recordTermination).toHaveBeenCalledWith(
      operationId,
      'sandbox-123',
      'killed',
    );
  });
  it.each([
    'http://api.example.test',
    'https://user:private-marker@api.example.test',
    'https://api.example.test?token=private-marker',
    'https://api.example.test#private-marker',
    'https://api.example.test/api',
    'https://api.example.test/%2fapi',
    'https://api.example.test/../',
    'https://api.example.test?',
    'https://api.example.test#',
    'https://api.\nexample.test',
    ' https://api.example.test',
    'not-a-url-private-marker',
  ])(
    'rejects ambiguous or credential-bearing endpoint %s before I/O',
    async (url) => {
      const verify = vi.fn<typeof verifyE2bTemplate>();
      await expect(
        auditConfiguredTemplates({ ...environment, E2B_API_URL: url }, verify),
      ).rejects.toThrow('E2B API endpoint must be a clean HTTPS origin');
      expect(verify).not.toHaveBeenCalled();
      try {
        e2bApiUrl(url);
      } catch (error) {
        expect(String(error)).not.toContain('private-marker');
      }
    },
  );

  it.each([undefined, 'https://api.example.test/'])(
    'uses the same validated origin for metadata and SDK tag requests (%s)',
    async (endpoint) => {
      const expectedOrigin = endpoint
        ? 'https://api.example.test'
        : 'https://api.e2b.app';
      const transport = vi.fn<typeof fetch>(async () =>
        Response.json({
          templateID: 'source-template',
          buildID: buildId,
          buildCount: 1,
          public: false,
        }),
      );
      vi.stubGlobal('fetch', transport);
      const tags = vi
        .mocked(Template.getTags)
        .mockResolvedValue([
          { tag, buildId, createdAt: new Date('2026-11-11T00:00:00.000Z') },
        ]);
      const results = await auditConfiguredTemplates({
        ...environment,
        ...(endpoint ? { E2B_API_URL: endpoint } : {}),
      });
      expect(results).toEqual([
        expect.objectContaining({
          role: 'source',
          status: 'verified',
          tagMatches: true,
        }),
      ]);
      expect(String(transport.mock.calls[0]?.[0])).toBe(
        `${expectedOrigin}/templates/source-template`,
      );
      expect(tags).toHaveBeenCalledWith(
        'source-template',
        expect.objectContaining({
          apiUrl: expectedOrigin,
          apiKey: environment.E2B_API_KEY,
          retries: 0,
          signal: expect.any(AbortSignal),
          requestTimeoutMs: 30_000,
        }),
      );
    },
  );

  it('preserves provider verification failures and never exposes raw provider errors', async () => {
    const verify = vi.fn<typeof verifyE2bTemplate>();
    verify.mockResolvedValueOnce(null);
    expect(await auditConfiguredTemplates(environment, verify)).toEqual([
      {
        role: 'source',
        templateId: 'source-template',
        status: 'provider_error',
      },
    ]);
    verify.mockRejectedValueOnce(new Error('private-marker'));
    expect(
      JSON.stringify(await auditConfiguredTemplates(environment, verify)),
    ).not.toContain('private-marker');
    verify.mockResolvedValueOnce({
      buildId,
      tagBuildId: buildId,
      buildCount: 2,
      isPrivate: true,
    });
    expect(await auditConfiguredTemplates(environment, verify)).toEqual([
      expect.objectContaining({ status: 'review_required' }),
    ]);
  });

  it('validates the whole role configuration before making a request', async () => {
    const verify = vi.fn<typeof verifyE2bTemplate>();
    await expect(
      auditConfiguredTemplates(
        {
          ...environment,
          SIPHON_PDF_TEMPLATE_ID: 'incomplete-role',
        },
        verify,
      ),
    ).rejects.toThrow('Missing or invalid pdf template configuration');
    expect(verify).not.toHaveBeenCalled();
  });

  describe('E2bApiUrl strict origin validation', () => {
    it.each([
      'https://api.e2b.dev:8080',
      'https://api.e2b.dev:443',
      'https://api.e2b.app:8443',
    ])('rejects URLs with explicit or custom ports: %s', (url) => {
      expect(E2bApiUrl.safeParse(url).success).toBe(false);
      expect(() => e2bApiUrl(url)).toThrow(
        'E2B API endpoint must be a clean HTTPS origin',
      );
    });

    it.each([
      'https://127.0.0.1',
      'https://169.254.169.254',
      'https://10.0.0.1',
      'https://0.0.0.0',
    ])('rejects URLs with raw IPv4 addresses: %s', (url) => {
      expect(E2bApiUrl.safeParse(url).success).toBe(false);
      expect(() => e2bApiUrl(url)).toThrow(
        'E2B API endpoint must be a clean HTTPS origin',
      );
    });

    it.each(['https://[::1]', 'https://[fe80::1]'])(
      'rejects URLs with raw IPv6 addresses: %s',
      (url) => {
        expect(E2bApiUrl.safeParse(url).success).toBe(false);
        expect(() => e2bApiUrl(url)).toThrow(
          'E2B API endpoint must be a clean HTTPS origin',
        );
      },
    );

    it.each([
      'https://localhost',
      'https://localhost:3000',
      'https://sub.localhost',
    ])('rejects localhost and subdomain URLs: %s', (url) => {
      expect(E2bApiUrl.safeParse(url).success).toBe(false);
      expect(() => e2bApiUrl(url)).toThrow(
        'E2B API endpoint must be a clean HTTPS origin',
      );
    });
  });
});
