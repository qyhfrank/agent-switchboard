import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
import {
  type CodexPluginCommandRunner,
  distributeCodexNativePlugins,
} from '../src/native-plugins/codex.js';
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

function createCodexPluginFixture(asbHome: string): string {
  const pluginDir = path.join(asbHome, 'plugins', 'cowart');
  fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'cowart', version: '0.1.0' }),
    'utf-8'
  );
  return pluginDir;
}

function createExternalNativeMarketplaceFixture(
  asbHome: string,
  target: 'claude-code' | 'codex'
): string {
  const mktDir = path.join(asbHome, 'marketplaces', `${target}-external`);
  const manifestDir =
    target === 'claude-code'
      ? path.join(mktDir, '.claude-plugin')
      : path.join(mktDir, '.agents', 'plugins');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, 'marketplace.json'),
    JSON.stringify({
      name: `${target}-external`,
      plugins: [
        {
          name: 'remote-native',
          version: '1.0.0',
          source: { source: 'url', url: 'file:///not-materialized.git' },
        },
      ],
    }),
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

test('runSyncCommand dry-run keeps source checkouts and marketplace cache unchanged', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');

    const pluginRepo = path.join(asbHome, 'external-plugin.git');
    const skillDir = path.join(pluginRepo, 'skills', 'remote-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: remote-skill\ndescription: Remote\n---\nBody'
    );
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: pluginRepo,
      stdio: 'pipe',
    });
    execFileSync('git', ['add', '.'], { cwd: pluginRepo, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin'],
      { cwd: pluginRepo, stdio: 'pipe' }
    );

    const catalogBare = path.join(asbHome, 'catalog.git');
    const catalogWork = path.join(asbHome, 'catalog-work');
    const catalogCheckout = path.join(asbHome, 'plugins', 'catalog');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', catalogBare], {
      stdio: 'pipe',
    });
    execFileSync('git', ['clone', catalogBare, catalogWork], { stdio: 'pipe' });
    fs.mkdirSync(path.join(catalogWork, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogWork, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: pluginRepo },
          },
        ],
      })
    );
    execFileSync('git', ['add', '.'], { cwd: catalogWork, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: catalogWork, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: catalogWork, stdio: 'pipe' });
    fs.mkdirSync(path.dirname(catalogCheckout), { recursive: true });
    execFileSync('git', ['clone', catalogBare, catalogCheckout], { stdio: 'pipe' });

    fs.writeFileSync(path.join(catalogWork, 'REMOTE-CHANGE'), 'change');
    execFileSync('git', ['add', '.'], { cwd: catalogWork, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'change'],
      { cwd: catalogWork, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: catalogWork, stdio: 'pipe' });

    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins]',
      'enabled = ["remote-plugin@catalog"]',
      '',
      '[plugins.sources]',
      `catalog = { url = "${catalogBare}", type = "clone" }`,
    ]);

    const { result } = await captureConsoleOutput(() =>
      runSyncCommand({ dryRun: true, updateSources: true })
    );

    assert.equal(result, false);
    assert.equal(fs.existsSync(path.join(catalogCheckout, 'REMOTE-CHANGE')), false);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
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

test('runSyncCommand dry-run previews Codex native plugins without generic expansion', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
      'scope = "user"',
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false, dryRun: true })
    );

    assert.equal(result, false);
    assert.match(output, /native plugins/);
    assert.match(output, /cowart/);
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

test('runSyncCommand rejects Codex native plugins enabled through generic plugins', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins]',
      'enabled = ["cowart"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
    ]);

    const { result, output } = await captureConsoleOutput(() =>
      runSyncCommand({ updateSources: false })
    );

    assert.equal(result, true);
    assert.match(output, /use \[applications\.codex\.native_plugins\] instead/);
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

test('Claude native distribution leaves external marketplace entries unmaterialized', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mktDir = createExternalNativeMarketplaceFixture(asbHome, 'claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[plugins.sources]',
      `external-source = "${mktDir}"`,
      '',
      '[applications.claude-code.native_plugins]',
      'enabled = ["remote-native@claude-code-external"]',
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

    assert.equal(outcome.results[0]?.status, 'written');
    assert.deepEqual(calls, [
      ['plugin', 'validate', mktDir],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', '--scope', 'user', mktDir],
      ['plugin', 'list', '--json'],
      ['plugin', 'install', '--scope', 'user', 'remote-native@claude-code-external'],
    ]);
    assert.equal(fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache')), false);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
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

test('distributeCodexNativePlugins installs bare plugin through Codex CLI', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    const calls: string[][] = [];
    const runner: CodexPluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '{"marketplaces":[]}', stderr: '' };
      }
      if (args.join(' ') === 'plugin list --marketplace cowart --json') {
        return { status: 0, stdout: '{"installed":[],"available":[]}', stderr: '' };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const wrapperDir = path.join(asbHome, 'state', 'native-plugins', 'codex', 'cowart');
    fs.mkdirSync(path.join(wrapperDir, 'plugins'), { recursive: true });
    fs.symlinkSync(
      path.join(asbHome, 'missing-cowart'),
      path.join(wrapperDir, 'plugins', 'cowart'),
      'dir'
    );

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      runner,
    });

    const manifest = JSON.parse(
      fs.readFileSync(path.join(wrapperDir, '.agents', 'plugins', 'marketplace.json'), 'utf-8')
    ) as { name: string; plugins: Array<{ name: string; source: string }> };

    assert.deepEqual(outcome.results, [
      {
        platform: 'codex',
        pluginRef: 'cowart@cowart',
        filePath: wrapperDir,
        status: 'written',
        reason: 'marketplace added, installed',
      },
    ]);
    assert.deepEqual(manifest, {
      name: 'cowart',
      plugins: [{ name: 'cowart', source: './plugins/cowart' }],
    });
    assert.equal(fs.lstatSync(path.join(wrapperDir, 'plugins', 'cowart')).isSymbolicLink(), true);
    assert.deepEqual(calls, [
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', wrapperDir, '--json'],
      ['plugin', 'list', '--marketplace', 'cowart', '--json'],
      ['plugin', 'add', 'cowart@cowart', '--json'],
    ]);
  });
});

test('Codex native distribution leaves external marketplace entries unmaterialized', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const mktDir = createExternalNativeMarketplaceFixture(asbHome, 'codex');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `external-source = "${mktDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["remote-native@codex-external"]',
    ]);

    const calls: string[][] = [];
    const runner: CodexPluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return { status: 0, stdout: '{"marketplaces":[]}', stderr: '' };
      }
      if (args.join(' ') === 'plugin list --marketplace codex-external --json') {
        return { status: 0, stdout: '{"installed":[],"available":[]}', stderr: '' };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const outcome = distributeCodexNativePlugins({ activeAppIds: ['codex'], runner });

    assert.equal(outcome.results[0]?.status, 'written');
    assert.deepEqual(calls, [
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', mktDir, '--json'],
      ['plugin', 'list', '--marketplace', 'codex-external', '--json'],
      ['plugin', 'add', 'remote-native@codex-external', '--json'],
    ]);
    assert.equal(fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache')), false);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'native-plugins')), false);
    assert.equal(fs.existsSync(path.join(asbHome, 'state', 'marketplace-plugins')), false);
  });
});

test('distributeCodexNativePlugins dry-run does not invoke Codex CLI runner', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    let called = false;
    const runner: CodexPluginCommandRunner = () => {
      called = true;
      return { status: 1, stdout: '', stderr: 'should not run' };
    };

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      dryRun: true,
      runner,
    });

    assert.equal(called, false);
    assert.equal(outcome.results[0]?.status, 'written');
    assert.equal(outcome.results[0]?.reason, 'would sync native plugin (user)');
  });
});

test('distributeCodexNativePlugins skips installed matching plugins as up-to-date', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    const wrapperDir = path.join(asbHome, 'state', 'native-plugins', 'codex', 'cowart');
    const calls: string[][] = [];
    const runner: CodexPluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ marketplaces: [{ name: 'cowart', root: wrapperDir }] }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --marketplace cowart --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'cowart@cowart',
                marketplaceName: 'cowart',
                version: '0.1.0',
                installed: true,
                enabled: true,
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'skipped');
    assert.equal(outcome.results[0]?.reason, 'up-to-date');
    assert.deepEqual(calls, [
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--marketplace', 'cowart', '--json'],
    ]);
  });
});

test('distributeCodexNativePlugins re-adds disabled installed plugins', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    const wrapperDir = path.join(asbHome, 'state', 'native-plugins', 'codex', 'cowart');
    const calls: string[][] = [];
    const runner: CodexPluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ marketplaces: [{ name: 'cowart', root: wrapperDir }] }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --marketplace cowart --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'cowart@cowart',
                marketplaceName: 'cowart',
                version: '0.1.0',
                installed: true,
                enabled: false,
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'written');
    assert.equal(outcome.results[0]?.reason, 'enabled');
    assert.deepEqual(calls, [
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--marketplace', 'cowart', '--json'],
      ['plugin', 'add', 'cowart@cowart', '--json'],
    ]);
  });
});

test('distributeCodexNativePlugins updates stale installed plugin versions', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    const wrapperDir = path.join(asbHome, 'state', 'native-plugins', 'codex', 'cowart');
    const calls: string[][] = [];
    const runner: CodexPluginCommandRunner = (args) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ marketplaces: [{ name: 'cowart', root: wrapperDir }] }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'plugin list --marketplace cowart --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'cowart@cowart',
                marketplaceName: 'cowart',
                version: '0.0.9',
                installed: true,
                enabled: true,
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'written');
    assert.equal(outcome.results[0]?.reason, 'updated');
    assert.deepEqual(calls, [
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--marketplace', 'cowart', '--json'],
      ['plugin', 'add', 'cowart@cowart', '--json'],
    ]);
  });
});

test('distributeCodexNativePlugins rejects same-name marketplace from another root', async () => {
  await withTempHomesAsync(async ({ asbHome }) => {
    simulateAppsInstalled('codex');
    const pluginDir = createCodexPluginFixture(asbHome);
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["codex"]',
      '',
      '[plugins.sources]',
      `cowart = "${pluginDir}"`,
      '',
      '[applications.codex.native_plugins]',
      'enabled = ["cowart"]',
    ]);

    const runner: CodexPluginCommandRunner = (args) => {
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            marketplaces: [{ name: 'cowart', root: path.join(asbHome, 'other-cowart') }],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '{}', stderr: '' };
    };

    const outcome = distributeCodexNativePlugins({
      activeAppIds: ['codex'],
      runner,
    });

    assert.equal(outcome.results[0]?.status, 'error');
    assert.match(outcome.results[0]?.error ?? '', /different source/);
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
