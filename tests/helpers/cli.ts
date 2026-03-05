import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function runCli(
  args: string[],
  env?: NodeJS.ProcessEnv
): { stdout: string; stderr: string } {
  const node = process.execPath; // current Node
  const entry = path.join(process.cwd(), 'src', 'index.ts');
  const finalEnv = { ...process.env, FORCE_COLOR: '0', ...(env ?? {}) };
  const out = execFileSync(node, ['--import', 'tsx', '--enable-source-maps', entry, ...args], {
    env: finalEnv,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // execFileSync returns stdout when encoding is provided; stderr is not captured here.
  return { stdout: out, stderr: '' };
}

export function stripAnsi(input: string): string {
  const ESC = String.fromCharCode(27);
  const pattern = `${ESC}\\[[0-?]*[ -/]*[@-~]`;
  return input.replace(new RegExp(pattern, 'g'), '');
}
