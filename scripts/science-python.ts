import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = join(
  root,
  '.tools',
  'science-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);

/** Honor explicit configuration, then the project virtual environment. */
export const sciencePython =
  process.env.SIPHON_PYTHON ?? (existsSync(local) ? local : 'python');
