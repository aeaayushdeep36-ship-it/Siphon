import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(
  root,
  'node_modules',
  'firebase-tools',
  'lib',
  'bin',
  'firebase.js',
);
if (!existsSync(cli))
  throw new Error(
    'Install the pinned development dependencies before running rules checks.',
  );
const env = { ...process.env };
const portable = join(root, '.tools', 'java21');
if (existsSync(portable)) {
  const runtimes = readdirSync(portable, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      join(
        portable,
        entry.name,
        'bin',
        process.platform === 'win32' ? 'java.exe' : 'java',
      ),
    )
    .filter(existsSync);
  if (runtimes.length !== 1)
    throw new Error('Portable Java installation is incomplete or ambiguous.');
  env.JAVA_HOME = dirname(dirname(runtimes[0]));
  const key =
    Object.keys(env).find((entry) => entry.toLowerCase() === 'path') ?? 'PATH';
  env[key] =
    `${dirname(runtimes[0])}${process.platform === 'win32' ? ';' : ':'}${env[key] ?? ''}`;
}
const java = spawnSync('java', ['-version'], {
  env,
  encoding: 'utf8',
  windowsHide: true,
});
const major = /version "(?:1\.)?(\d+)/.exec(
  `${java.stdout ?? ''}${java.stderr ?? ''}`,
)?.[1];
if (java.status !== 0 || !major || Number(major) < 21)
  throw new Error('Java 21+ is required for the local Firestore emulator.');
const run = spawnSync(
  process.execPath,
  [
    cli,
    'emulators:exec',
    '--only',
    'firestore',
    '--project',
    'demo-siphon-rules',
    '--non-interactive',
    'node scripts/check-firestore-emulator.mjs',
  ],
  { cwd: root, env, stdio: 'inherit', windowsHide: true },
);
if (run.error) throw new Error('Firestore emulator process could not start.');
process.exitCode = run.status ?? 1;
