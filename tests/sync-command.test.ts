import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getClaudeJsonPath,
  getCodexDir,
  getMcpConfigPath,
  getProfileConfigPath,
} from '../src/config/paths.js';
import { resetAgentSyncCache } from '../src/library/state.js';
import { resolveManifestPath } from '../src/manifest/store.js';
import {
  type ClaudePluginCommandRunner,
  distributeClaudeNativePlugins,
} from '../src/native-plugins/claude-code.js';
import { clearPluginIndexCache } from '../src/plugins/index.js';
import { runSyncCommand } from '../src/sync/command.js';
import { resetTargetInit } from '../src/targets/init.js';
import { clearExtensionTargets } from '../src/targets/registry.js';
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
    clearPluginIndexCache();
    clearExtensionTargets();
    resetTargetInit();
    resetAgentSyncCache();
    return await fn({ asbHome, agentsHome });
  } finally {
    clearPluginIndexCache();
    clearExtensionTargets();
    resetTargetInit();
    resetAgentSyncCache();
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

function createClaudeMarketplaceFixture(asbHome: string): string {
  const mktDir = path.join(asbHome, 'marketplaces', 'openai-codex');
  const pluginDir = path.join(mktDir, 'plugins', 'codex');
  fs.mkdirSync(path.join(mktDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });

  fs.writeFileSync(
    path.join(mktDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-codex',
      owner: { name: 'OpenAI' },
      plugins: [{ name: 'codex', source: './plugins/codex' }],
    }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codex', version: '1.0.5' }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(pluginDir, 'commands', 'setup.md'),
    '---\ndescription: setup\n---\nsetup body\n',
    'utf-8'
  );
  return mktDir;
}

async function captureConsoleOutput<T>(
  fn: () => Promise<T>
): Promise<{ result: T; output: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;

  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

test('runSyncCommand syncs global config through extracted orchestration', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
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

test('runSyncCommand project scope only syncs project outputs', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
      '',
      '[rules]',
      'enabled = ["response", "execution"]',
      '',
      '[plugins]',
      'enabled = ["ghost-plugin"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });
    const skillDir = path.join(asbHome, 'skills', 'project-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: project-skill\ndescription: project scoped skill\n---\nBody\n',
      'utf-8'
    );

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeConfig(path.join(projectRoot, '.asb.toml'), [
      '[mcp]',
      'enabled = ["beta"]',
      '',
      '[skills]',
      'enabled = ["project-skill"]',
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ scope: { project: projectRoot }, updateSources: false })
    );
    const projectApplied = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf-8')
    ) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(result, false);
    assert.match(output, /Project:/);
    assert.doesNotMatch(output, /Global/);
    assert.doesNotMatch(output, /plugins/);
    assert.doesNotMatch(output, /ghost-plugin/);
    assert.match(output, /rules\s+\(0\)\s+claude-code:0/);
    assert.doesNotMatch(output, /response/);
    assert.match(output, /skills\s+\(1\)\s+claude-code:1/);
    assert.match(output, /project-skill/);
    assert.equal(fs.existsSync(getClaudeJsonPath()), false);
    assert.deepEqual(Object.keys(projectApplied.mcpServers), ['beta']);
  });
});

test('runSyncCommand profile scope syncs writable profile selection to global outputs', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
      '',
      '[rules]',
      'enabled = ["response"]',
      '',
      '[plugins]',
      'enabled = ["ghost-plugin"]',
    ]);
    writeConfig(getProfileConfigPath('team'), [
      '[mcp]',
      'enabled = ["beta"]',
      '',
      '[skills]',
      'enabled = ["profile-skill"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
      beta: { command: 'npx', args: ['beta'], type: 'stdio' },
    });
    const skillDir = path.join(asbHome, 'skills', 'profile-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: profile-skill\ndescription: profile scoped skill\n---\nBody\n',
      'utf-8'
    );

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ scope: { profile: 'team' }, updateSources: false })
    );
    const applied = JSON.parse(fs.readFileSync(getClaudeJsonPath(), 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(result, false);
    assert.match(output, /Profile: team/);
    assert.doesNotMatch(output, /Global/);
    assert.doesNotMatch(output, /plugins/);
    assert.doesNotMatch(output, /ghost-plugin/);
    assert.match(output, /rules\s+\(0\)\s+claude-code:0/);
    assert.doesNotMatch(output, /response/);
    assert.match(output, /skills\s+\(1\)\s+claude-code:1/);
    assert.match(output, /profile-skill/);
    assert.deepEqual(Object.keys(applied.mcpServers), ['beta']);
  });
});

test('runSyncCommand aborts project managed sync when manifest is corrupt', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(path.join(projectRoot, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'commands', 'foreign.md'),
      'user-owned\n',
      'utf-8'
    );
    const manifestPath = resolveManifestPath(projectRoot);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{ not valid json', 'utf-8');
    writeConfig(path.join(projectRoot, '.asb.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[distribution.project]',
      'mode = "managed"',
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ scope: { project: projectRoot }, updateSources: false })
    );

    assert.equal(result, true);
    assert.match(output, /Aborting managed sync: corrupt manifest/);
    assert.equal(
      fs.existsSync(path.join(projectRoot, '.claude', 'commands', 'foreign.md')),
      true,
      'foreign project file should not be deleted when manifest is corrupt'
    );
  });
});

test('runSyncCommand respects project distribution mode none', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const projectRoot = path.join(asbHome, 'project-none');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeConfig(path.join(projectRoot, '.asb.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
      '',
      '[distribution.project]',
      'mode = "none"',
    ]);

    const { result } = await captureConsoleOutput(() =>
      runSyncCommand({ scope: { project: projectRoot }, updateSources: false })
    );

    assert.equal(result, false);
    assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), false);
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'settings.local.json')), false);
  });
});

test('runSyncCommand dry-run previews changes without writing outputs', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[mcp]',
      'enabled = ["alpha"]',
    ]);
    writeMcpConfig({
      alpha: { command: 'npx', args: ['alpha'], type: 'stdio' },
    });

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false, dryRun: true })
    );

    assert.equal(result, false);
    assert.match(output, /Distribution:/);
    assert.match(output, /\[dry-run\] No files were modified\./);
    assert.equal(fs.existsSync(getClaudeJsonPath()), false);
  });
});

test('runSyncCommand dry-run previews Claude native plugins without generic expansion', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code', 'codex');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code", "codex"]',
      '',
      '[plugins.sources.openai-codex]',
      `url = "${mktDir}"`,
      'type = "clone"',
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
      'scope = "user"',
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false, dryRun: true })
    );

    assert.equal(result, false);
    assert.match(output, /native plugins/);
    assert.match(output, /codex@openai-codex/);
    assert.doesNotMatch(output, /codex@openai-codex:setup/);
    assert.equal(fs.existsSync(path.join(getClaudeJsonPath(), '..', 'commands')), false);
    assert.equal(fs.existsSync(path.join(getCodexDir(), 'prompts')), false);
  });
});

test('runSyncCommand rejects native refs before generic plugin writes', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code", "codex"]',
      '',
      '[plugins]',
      'enabled = ["codex@openai-codex"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false })
    );

    assert.equal(result, true);
    assert.match(output, /also enabled through \[plugins\]\.enabled/);
    assert.equal(fs.existsSync(path.join(getCodexDir(), 'prompts')), false);
  });
});

test('distributeClaudeNativePlugins installs missing marketplace plugin through Claude CLI', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const calls: string[][] = [];
    const runner: ClaudePluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '[]', stderr: '' };
      }
      if (args.join(' ') === 'plugin list --json') {
        return { status: 0, stdout: '[]', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      runner,
    });

    assert.deepEqual(outcome.results, [
      {
        platform: 'claude-code',
        pluginRef: 'codex@openai-codex',
        filePath: mktDir,
        status: 'written',
        reason: 'marketplace added, installed',
      },
    ]);
    assert.deepEqual(calls, [
      ['plugin', 'validate', mktDir],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', '--scope', 'user', mktDir],
      ['plugin', 'list', '--json'],
      ['plugin', 'install', '--scope', 'user', 'codex@openai-codex'],
    ]);
  });
});

test('distributeClaudeNativePlugins dry-run does not invoke Claude CLI runner', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    let called = false;
    const runner: ClaudePluginCommandRunner = () => {
      called = true;
      return { status: 1, stdout: '', stderr: 'should not run' };
    };

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      dryRun: true,
      runner,
    });

    assert.equal(called, false);
    assert.equal(outcome.results[0]?.status, 'written');
    assert.equal(outcome.results[0]?.reason, 'would sync native plugin (user)');
  });
});

test('distributeClaudeNativePlugins skips installed enabled plugins as up-to-date', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const calls: string[][] = [];
    const runner: ClaudePluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '[{"name":"openai-codex"}]', stderr: '' };
      }
      if (args.join(' ') === 'plugin list --json') {
        return {
          status: 0,
          stdout: '[{"pluginId":"codex@openai-codex","enabled":true}]',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'skipped');
    assert.equal(outcome.results[0]?.reason, 'up-to-date');
    assert.deepEqual(calls, [
      ['plugin', 'validate', mktDir],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--json'],
    ]);
  });
});

test('distributeClaudeNativePlugins enables disabled installed plugins', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const calls: string[][] = [];
    const runner: ClaudePluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '[{"name":"openai-codex"}]', stderr: '' };
      }
      if (args.join(' ') === 'plugin list --json') {
        return {
          status: 0,
          stdout: '[{"pluginId":"codex@openai-codex","enabled":false}]',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'written');
    assert.equal(outcome.results[0]?.reason, 'enabled');
    assert.deepEqual(calls, [
      ['plugin', 'validate', mktDir],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--json'],
      ['plugin', 'enable', '--scope', 'user', 'codex@openai-codex'],
    ]);
  });
});

test('distributeClaudeNativePlugins rejects refs also enabled as generic plugins', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins]',
      'enabled = ["codex@openai-codex"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      dryRun: true,
      genericPluginRefs: ['codex@openai-codex'],
    });

    assert.equal(outcome.results[0]?.status, 'error');
    assert.match(outcome.results[0]?.error ?? '', /also enabled through \[plugins\]\.enabled/);
  });
});

test('distributeClaudeNativePlugins reports unknown native refs as errors', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["missing-plugin"]',
    ]);

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      dryRun: true,
    });

    assert.equal(outcome.results[0]?.status, 'error');
    assert.match(outcome.results[0]?.error ?? '', /Unknown native plugin ref: missing-plugin/);
  });
});

test('distributeClaudeNativePlugins reports malformed Claude JSON as an error result', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createClaudeMarketplaceFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `openai-codex = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    const runner: ClaudePluginCommandRunner = (args) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const outcome = distributeClaudeNativePlugins({
      activeAppIds: ['claude-code'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'error');
    assert.match(outcome.results[0]?.error ?? '', /returned invalid JSON/);
  });
});

test('distributeClaudeNativePlugins skips project mode none before runner calls', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(asbHome, 'project-native-none');
    fs.mkdirSync(projectRoot, { recursive: true });
    writeConfig(path.join(projectRoot, '.asb.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[distribution.project]',
      'mode = "none"',
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["codex@openai-codex"]',
    ]);

    let called = false;
    const runner: ClaudePluginCommandRunner = () => {
      called = true;
      return { status: 1, stdout: '', stderr: 'should not run' };
    };

    const outcome = distributeClaudeNativePlugins({
      scope: { project: projectRoot },
      activeAppIds: ['claude-code'],
      projectMode: 'none',
      runner,
    });

    assert.equal(called, false);
    assert.deepEqual(outcome.results, []);
  });
});
