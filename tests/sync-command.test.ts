import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getClaudeJsonPath, getMcpConfigPath } from '../src/config/paths.js';
import { runSyncCommand } from '../src/sync/command.js';
import { simulateAppsInstalled } from './helpers/tmp.js';

function setEnv(key: string, value: string | undefined): string | undefined {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return previous;
}

async function withTempHomesAsync<T>(
  fn: (ctx: { asbHome: string; agentsHome: string }) => Promise<T>
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-sync-'));
  const asbHome = path.join(root, 'asb-home');
  const agentsHome = path.join(root, 'agents-home');
  fs.mkdirSync(asbHome, { recursive: true });
  fs.mkdirSync(agentsHome, { recursive: true });

  const previousAsbHome = setEnv('ASB_HOME', asbHome);
  const previousAgentsHome = setEnv('ASB_AGENTS_HOME', agentsHome);

  try {
    return await fn({ asbHome, agentsHome });
  } finally {
    setEnv('ASB_HOME', previousAsbHome);
    setEnv('ASB_AGENTS_HOME', previousAgentsHome);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeConfig(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
}

function writeMcpConfig(servers: Record<string, unknown>): void {
  const configPath = getMcpConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8');
}

async function captureConsoleOutput<T>(
  fn: () => Promise<T>
): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

test('runSyncCommand syncs global config through extracted orchestration', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'active = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false })
    );
    const applied = JSON.parse(fs.readFileSync(getClaudeJsonPath(), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(result, false);
    assert.match(output, /Distribution:/);
    assert.match(output, /mcp/);
    assert.deepEqual(Object.keys(applied.mcpServers), ['alpha']);
  });
});

test('runSyncCommand performs dual sync for project scope', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'active = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeConfig(path.join(projectRoot, '.asb.toml'), ['[mcp]', 'enabled = ["beta"]']);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ scope: { project: projectRoot }, updateSources: false })
    );
    const globalApplied = JSON.parse(fs.readFileSync(getClaudeJsonPath(), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    const projectApplied = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf-8')
    ) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(result, false);
    assert.match(output, /Global/);
    assert.match(output, /Project:/);
    assert.deepEqual(Object.keys(globalApplied.mcpServers), ['alpha']);
    assert.deepEqual(Object.keys(projectApplied.mcpServers), ['beta']);
  });
});
