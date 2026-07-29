import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const suiteDirs = [new URL('./v05/', import.meta.url)];
const files = suiteDirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => fileURLToPath(new URL(name, dir)))
);
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
