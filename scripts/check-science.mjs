import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(
  root,
  '.tools',
  'science-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const python =
  process.env.SIPHON_PYTHON ?? (existsSync(local) ? local : 'python');
const mode = process.argv[2];
const tasks = {
  test: [['pytest', '-q']],
  lint: [
    ['ruff', 'check', '.'],
    ['ruff', 'format', '--check', '.'],
  ],
  types: [['mypy']],
  all: [
    ['pip', 'check'],
    ['ruff', 'check', '.'],
    ['ruff', 'format', '--check', '.'],
    ['mypy'],
    ['pytest', '-q'],
  ],
};
if (!Object.hasOwn(tasks, mode) || process.argv.length !== 3)
  throw new Error('Choose test, lint, types or all.');
const cwd = join(root, 'packages', 'science');
function run(args) {
  const result = spawnSync(python, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000,
  });
  if (result.error)
    throw new Error(
      'Scientific verification process could not finish; check the Python environment.',
    );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// Fixed developer verification only. This command never receives upload paths.
run([
  '-c',
  "import sys; assert sys.version_info[:2] == (3, 11), 'Siphon scientific verification requires Python 3.11'",
]);
for (const task of tasks[mode]) run(['-m', ...task]);
