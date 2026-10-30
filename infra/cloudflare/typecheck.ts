import worker, { type WorkerEnvironment } from '../../apps/api/src/worker.js';

type NativeEnvironment = Omit<
  WorkerEnvironment,
  'SIPHON_ARTIFACTS' | 'SIPHON_EDGE_LIMITER'
> & {
  SIPHON_ARTIFACTS: R2Bucket;
  SIPHON_EDGE_LIMITER: RateLimit;
};

// Compile against Cloudflare's native APIs, separately from DOM/Node test types.
export const checkedWorker: ExportedHandler<NativeEnvironment> = worker;
