import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Only the Firebase CLI wrapper may start these checks. Neither child selects
// credentials or falls back to the application's real Firebase project.
const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^127\.0\.0\.1:\d{1,5}$/.test(endpoint))
  throw new Error('A loopback Firestore emulator is required.');
const root = fileURLToPath(new URL('../', import.meta.url));
for (const args of [
  ['infra/firebase/check-rules.mjs'],
  ['--import', 'tsx', 'scripts/check-firestore-rest.ts'],
]) {
  const run = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (run.error) throw new Error('Local emulator check could not start.');
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    break;
  }
}
