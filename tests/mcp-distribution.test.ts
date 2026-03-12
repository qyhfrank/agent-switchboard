import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getClaudeJsonPath, getCursorDir, getMcpConfigPath } from '../src/config/paths.js';
import { loadManifest, saveManifest } from '../src/manifest/store.js';
import { distributeMcp } from '../src/mcp/distribution.js';
import { clearPluginIndexCache } from '../src/plugins/index.js';
import { resetTargetInit } from '../src/targets/init.js';
import { clearExtensionTargets } from '../src/targets/registry.js';
import { simulateAppsInstalled, simulateTraeInstalled } from './helpers/tmp.js';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-mcp-'));
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

function resetRuntimeState(): void {
  clearPluginIndexCache();
  clearExtensionTargets();
  resetTargetInit();
}

function writeSwitchboardConfig(asbHome: string, lines: string[]): void {
  fs.writeFileSync(path.join(asbHome, 'config.toml'), `${lines.join('\n')}\n`, 'utf-8');
}

function writeMcpConfig(servers: Record<string, unknown>): void {
  const configPath = getMcpConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8');
}

test('distributeMcp: returns no results when no active apps are configured', async () => {
  await withTempHomesAsync(async () => {
    resetRuntimeState();
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const results = await distributeMcp(undefined, undefined, { useSpinner: false });

    assert.deepEqual(results, []);
  });
});

test('distributeMcp: skips apps that are not installed', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    writeSwitchboardConfig(asbHome, [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const results = await distributeMcp(undefined, undefined, { useSpinner: false });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.application, 'claude-code');
    assert.equal(results[0]?.status, 'skipped');
    assert.equal(results[0]?.reason, 'not installed');
    assert.equal(fs.existsSync(getClaudeJsonPath()), false);
  });
});

test('distributeMcp: writes project-scoped config when project scope is provided', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateAppsInstalled('claude-code');

    writeSwitchboardConfig(asbHome, [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.asb.toml'), '[mcp]\nenabled = ["alpha"]\n', 'utf-8');

    const results = await distributeMcp({ project: projectRoot }, undefined, { useSpinner: false });
    const projectConfigPath = path.join(projectRoot, '.mcp.json');
    const applied = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(results.length, 1);
    assert.equal(results[0]?.filePath, projectConfigPath);
    assert.equal(results[0]?.status, 'written');
    assert.deepEqual(Object.keys(applied.mcpServers), ['alpha']);
    assert.equal(fs.existsSync(getClaudeJsonPath()), false);
  });
});

test('distributeMcp: intersects UI selection with per-app MCP config', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateAppsInstalled('claude-code', 'cursor');

    writeSwitchboardConfig(asbHome, [
      '[applications]',
      'enabled = ["claude-code", "cursor"]',
      '',
      '[mcp]',
      'enabled = ["alpha", "beta"]',
      '',
      '[applications.cursor.mcp]',
      'enabled = ["beta"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });

    const results = await distributeMcp(undefined, ['alpha'], { useSpinner: false });
    const claudeConfig = JSON.parse(fs.readFileSync(getClaudeJsonPath(), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    const cursorConfig = JSON.parse(
      fs.readFileSync(path.join(getCursorDir(), 'mcp.json'), 'utf-8')
    ) as { mcpServers: Record<string, unknown> };

    assert.equal(results.length, 2);
    assert.deepEqual(Object.keys(claudeConfig.mcpServers), ['alpha']);
    assert.deepEqual(Object.keys(cursorConfig.mcpServers), []);
  });
});

test('distributeMcp: project mode none skips project writes', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateAppsInstalled('claude-code');

    writeSwitchboardConfig(asbHome, ['[applications]', 'enabled = ["claude-code"]']);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project-none');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      ['[mcp]', 'enabled = ["alpha"]'].join('\n'),
      'utf-8'
    );

    const results = await distributeMcp({ project: projectRoot }, undefined, {
      useSpinner: false,
      projectMode: 'none',
    });

    assert.deepEqual(results, []);
    assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), false);
  });
});

test('distributeMcp: project-scoped shared Trae path merges writes across variants', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateTraeInstalled();

    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project-trae');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["trae", "trae-cn"]',
        '',
        '[mcp]',
        'enabled = ["alpha", "beta"]',
        '',
        '[applications.trae.mcp]',
        'enabled = ["alpha"]',
        '',
        '[applications.trae-cn.mcp]',
        'enabled = ["beta"]',
      ].join('\n'),
      'utf-8'
    );

    const results = await distributeMcp({ project: projectRoot }, undefined, { useSpinner: false });
    const projectConfigPath = path.join(projectRoot, '.trae', 'mcp.json');
    const applied = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(results.length, 2);
    assert.deepEqual(Object.keys(applied.mcpServers).sort(), ['alpha', 'beta']);
    assert.ok(results.every((result) => result.filePath === projectConfigPath));
  });
});

test('distributeMcp: managed shared Trae path cleans inactive owner state', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateTraeInstalled();

    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project-trae-managed');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["trae", "trae-cn"]',
        '',
        '[mcp]',
        'enabled = ["alpha", "beta"]',
        '',
        '[applications.trae.mcp]',
        'enabled = ["alpha"]',
        '',
        '[applications.trae-cn.mcp]',
        'enabled = ["beta"]',
      ].join('\n'),
      'utf-8'
    );

    const first = loadManifest(projectRoot);
    await distributeMcp({ project: projectRoot }, undefined, {
      useSpinner: false,
      manifest: first.manifest,
      projectMode: 'managed',
    });
    saveManifest(projectRoot, first.manifest);

    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["trae-cn"]',
        '',
        '[mcp]',
        'enabled = ["alpha", "beta"]',
        '',
        '[applications.trae-cn.mcp]',
        'enabled = ["beta"]',
      ].join('\n'),
      'utf-8'
    );

    const second = loadManifest(projectRoot);
    await distributeMcp({ project: projectRoot }, undefined, {
      useSpinner: false,
      manifest: second.manifest,
      projectMode: 'managed',
    });

    const projectConfigPath = path.join(projectRoot, '.trae', 'mcp.json');
    const applied = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.deepEqual(Object.keys(applied.mcpServers), ['beta']);
    assert.deepEqual(Object.keys(second.manifest.sections.mcp ?? {}), ['beta::trae-cn']);
  });
});

test('distributeMcp: managed mode cleans project MCP for disabled targets', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    resetRuntimeState();
    simulateAppsInstalled('claude-code');

    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project-managed-disabled');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      ['[applications]', 'enabled = ["claude-code"]', '', '[mcp]', 'enabled = ["alpha"]'].join(
        '\n'
      ),
      'utf-8'
    );

    const first = loadManifest(projectRoot);
    await distributeMcp({ project: projectRoot }, undefined, {
      useSpinner: false,
      manifest: first.manifest,
      projectMode: 'managed',
    });
    saveManifest(projectRoot, first.manifest);

    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      '[applications]\nenabled = []\n',
      'utf-8'
    );

    const second = loadManifest(projectRoot);
    await distributeMcp({ project: projectRoot }, undefined, {
      useSpinner: false,
      manifest: second.manifest,
      projectMode: 'managed',
    });

    const projectConfigPath = path.join(projectRoot, '.mcp.json');
    const applied = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.deepEqual(Object.keys(applied.mcpServers), []);
    assert.deepEqual(Object.keys(second.manifest.sections.mcp ?? {}), []);
  });
});
