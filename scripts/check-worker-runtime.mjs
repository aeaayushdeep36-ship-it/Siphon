import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const bundle = fileURLToPath(
  new URL('../apps/api/dist/worker/index.js', import.meta.url),
);
if (!existsSync(bundle))
  throw new Error('Build the native Worker before checking its local runtime.');
let outboundCalls = 0;
// Literal authored values only. This does not load .dev.vars, application
// credentials, real bucket bindings, or the actual Firebase project selection.
const options = convertV4MiniflareOptions({
  host: '127.0.0.1',
  port: 0,
  inspectorHost: '127.0.0.1',
  inspectorPort: 0,
  cf: false,
  telemetry: { enabled: false },
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: 'siphon-offline',
      modules: true,
      scriptPath: bundle,
      compatibilityDate: '2026-10-29',
      bindings: {
        SIPHON_API_ENABLED: 'false',
        SIPHON_INSPECTION_WORKFLOW_ENABLED: 'false',
        FIREBASE_PROJECT_ID: 'siphon-offline',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: 'authored-private-marker',
        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: 'authored-private-marker',
        E2B_API_KEY: 'authored-private-marker',
      },
      kvNamespaces: ['SIPHON_PRIVATE_KV'],
      workflows: {
        SIPHON_INSPECTION: {
          name: 'siphon-inspection-offline',
          className: 'SiphonInspectionWorkflow',
        },
      },
      outboundService: () => {
        outboundCalls++;
        throw new Error('Outbound network is forbidden in this local check.');
      },
    },
  ],
});
const runtime = new Miniflare({ ...options, enableDevRegistry: false });
try {
  const response = await runtime.dispatchFetch(
    'https://siphon.invalid/offline-startup',
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, 'service_unavailable');
  const bindings = await runtime.getBindings();
  const instance = await bindings.SIPHON_INSPECTION.create({
    id: 'offline-disabled',
    params: { schemaVersion: '1.0', jobId: 'a'.repeat(64) },
  });
  const deadline = Date.now() + 20_000;
  let state;
  do {
    state = await instance.status();
    if (['complete', 'errored', 'terminated'].includes(state.status)) break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.equal(
    state.status,
    'errored',
    'The disabled local Workflow must fail closed.',
  );
  // The local engine wraps the entrypoint's NonRetryableError in its own fatal
  // envelope rather than exposing the custom entrypoint message in status().
  assert.equal(state.error?.name, 'WorkflowFatalError');
  assert.ok(state.error.message.includes('NonRetryableError'));
  assert.deepEqual(state.__LOCAL_DEV_STEP_OUTPUTS, []);
  assert.ok(!JSON.stringify(state).includes('authored-private-marker'));
  assert.equal(
    outboundCalls,
    0,
    'Disabled API/Workflow must make no external calls.',
  );
  process.stdout.write(
    'Verified compiled Worker startup, disabled API, native Workflow failure/redaction and zero outbound calls in local workerd.\n',
  );
} finally {
  await runtime.dispose();
}
