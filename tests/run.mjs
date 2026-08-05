import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const suiteDir = new URL('./', import.meta.url);
const files = readdirSync(suiteDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => fileURLToPath(new URL(name, suiteDir)));
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
