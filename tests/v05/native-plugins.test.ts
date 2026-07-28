import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import {
  installApps,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The native apply kind: an app whose own plugin manager owns the install.
 * There is no file to prove ownership with, so every run probes the manager
 * and plans against what it reports. The manager here is a real process on the
 * run's PATH, driven by a state file, so the protocol — the verbs, their order
 * and their arguments — is exercised rather than mocked.
 */

interface FakeManager {
  /** Everything the manager was asked to do, one argv per line. */
  calls(): string[][];
  state(): { marketplaces: unknown[]; plugins: Record<string, unknown>[] };
  setState(next: { marketplaces?: unknown[]; plugins?: Record<string, unknown>[] }): void;
  reset(): void;
}

const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');

const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const scoped = (rest) => (rest[0] === '--scope' ? rest.slice(2) : rest);
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };

if (args[0] !== 'plugin') fail('unknown command');
const verb = args[1];

if (verb === 'validate') {
  if ((state.invalid || []).includes(args[2])) fail('marketplace manifest is not valid');
  process.exit(0);
}
if (verb === 'marketplace' && args[2] === 'list') {
  process.stdout.write(JSON.stringify({ marketplaces: state.marketplaces }));
  process.exit(0);
}
if (verb === 'list') {
  process.stdout.write(JSON.stringify({ plugins: state.plugins }));
  process.exit(0);
}
if (verb === 'marketplace' && args[2] === 'add') {
  const argument = scoped(args.slice(3))[0];
  const name = state.names[argument];
  if (!name) fail('cannot resolve marketplace: ' + argument);
  state.marketplaces.push({ name, source: state.sources[argument] });
  save();
  process.exit(0);
}
if (verb === 'marketplace' && args[2] === 'remove') {
  const name = scoped(args.slice(3))[0];
  state.marketplaces = state.marketplaces.filter((entry) => entry.name !== name);
  // Removing a marketplace takes its plugins with it.
  state.plugins = state.plugins.filter((entry) => entry.marketplaceName !== name);
  save();
  process.exit(0);
}
if (verb === 'install' || verb === 'enable' || verb === 'disable') {
  const ref = scoped(args.slice(2))[0];
  const [pluginName, marketplaceName] = ref.split('@');
  const existing = state.plugins.find((entry) => entry.id === ref);
  if (verb === 'install') {
    if (!existing) state.plugins.push({ id: ref, name: pluginName, marketplaceName, enabled: true });
  } else if (existing) {
    existing.enabled = verb === 'enable';
  } else {
    fail('not installed: ' + ref);
  }
  save();
  process.exit(0);
}
fail('unsupported: ' + args.join(' '));
`;

/**
 * Put a stateful manager on the run's PATH. The manager cannot resolve a
 * registration argument to a catalog by itself, so the test tells it which
 * name each argument stands for — everything else it decides from its state.
 */
function installFakeManager(
  scratch: ScratchHomes,
  names: Record<string, string>,
  sources: Record<string, unknown>
): FakeManager {
  const binDir = path.join(scratch.root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'claude');
  fs.writeFileSync(binPath, FAKE_SOURCE, 'utf-8');
  fs.chmodSync(binPath, 0o755);

  const statePath = path.join(scratch.root, 'manager-state.json');
  const logPath = path.join(scratch.root, 'manager-log.txt');
  const initial = { marketplaces: [], plugins: [], invalid: [], names, sources };
  fs.writeFileSync(statePath, JSON.stringify(initial, null, 2), 'utf-8');
  fs.writeFileSync(logPath, '', 'utf-8');

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_CLAUDE_STATE = statePath;
  process.env.FAKE_CLAUDE_LOG = logPath;

  return {
    calls: () =>
      fs
        .readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    state: () => JSON.parse(fs.readFileSync(statePath, 'utf-8')),
    setState: (next) => {
      const current = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      fs.writeFileSync(statePath, JSON.stringify({ ...current, ...next }, null, 2), 'utf-8');
    },
    reset: () => fs.writeFileSync(logPath, '', 'utf-8'),
  };
}

/**
 * A marketplace source declared with a GitHub remote but held in the library
 * tree, so the registration asb computes is the portable one without any
 * command in this test reaching the network.
 */
function seedMarketplaceSource(scratch: ScratchHomes): string {
  const root = path.join(scratch.asbHome, 'plugins', 'openai-codex');
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-codex',
      plugins: [{ name: 'codex', source: './codex' }],
    }),
    'utf-8'
  );
  fs.mkdirSync(path.join(root, 'codex', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'codex', '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'codex', version: '1.0.0' }),
    'utf-8'
  );
  return root;
}

function nativeConfig(extra = ''): string {
  return [
    '[applications]',
    'enabled = ["claude-code"]',
    '',
    '[applications.claude-code.native_plugins]',
    'enabled = ["codex@openai-codex"]',
    '',
    '[plugins.sources]',
    'openai-codex = { url = "https://github.com/openai/codex.git", type = "subtree", ref = "main" }',
    extra,
    '',
  ].join('\n');
}

const REGISTRATION = { source: 'github', repo: 'openai/codex', ref: 'main' };

function settingsOf(scratch: ScratchHomes): Record<string, unknown> {
  const filePath = path.join(scratch.agentsHome, '.claude', 'settings.json');
  return fs.existsSync(filePath)
    ? (JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>)
    : {};
}

test('a native plugin registers through the manager exactly as 0.4.35 does', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { 'openai/codex@main': 'openai-codex' },
      { 'openai/codex@main': REGISTRATION }
    );
    writeUserConfig(scratch, nativeConfig());

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));

    // The protocol: validate the catalog, read the manager's state, then act
    // on it. GitHub remotes register portably, by `org/repo@ref` rather than
    // by a path only this machine has.
    assert.deepEqual(manager.calls(), [
      ['plugin', 'validate', path.join(scratch.asbHome, 'plugins', 'openai-codex')],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'list', '--json'],
      ['plugin', 'marketplace', 'add', '--scope', 'user', 'openai/codex@main'],
      ['plugin', 'install', '--scope', 'user', 'codex@openai-codex'],
    ]);

    const row = report.entries.find((entry) => entry.type === 'native_plugins');
    assert.ok(row);
    assert.equal(row.id, 'codex@openai-codex');
    assert.equal(row.outcome, 'written');
    assert.match(row.reason ?? '', /marketplace added, installed, settings reconciled/);

    // The portable declaration is recorded where the app reads it.
    assert.deepEqual(settingsOf(scratch).extraKnownMarketplaces, {
      'openai-codex': { source: REGISTRATION },
    });
  });
});

test('an unchanged install reports up to date and asks the manager to change nothing', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { 'openai/codex@main': 'openai-codex' },
      { 'openai/codex@main': REGISTRATION }
    );
    writeUserConfig(scratch, nativeConfig());

    await runSync();
    manager.reset();

    const second = await runSync();
    const row = second.entries.find((entry) => entry.type === 'native_plugins');
    assert.ok(row);
    assert.equal(row.outcome, 'unchanged', JSON.stringify(second.entries, null, 2));
    assert.match(row.reason ?? '', /up to date/);
    assert.deepEqual(
      manager.calls(),
      [
        ['plugin', 'validate', path.join(scratch.asbHome, 'plugins', 'openai-codex')],
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'list', '--json'],
      ],
      'a settled install runs read-only verbs only'
    );
  });
});

test('a plugin disabled behind asb’s back reports stale, then sync re-enables it', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { 'openai/codex@main': 'openai-codex' },
      { 'openai/codex@main': REGISTRATION }
    );
    writeUserConfig(scratch, nativeConfig());
    await runSync();

    // The user disabled it in the app itself.
    const state = manager.state();
    manager.setState({
      plugins: state.plugins.map((entry) => ({ ...entry, enabled: false })),
    });
    manager.reset();

    const status = await runSync({ dryRun: true });
    const preview = status.entries.find((entry) => entry.type === 'native_plugins');
    assert.ok(preview);
    assert.equal(preview.detail, 'stale', JSON.stringify(status.entries, null, 2));
    assert.match(preview.reason ?? '', /disabled outside asb/);
    assert.ok(
      !manager.calls().some((call) => call[1] === 'enable'),
      'a preview changes nothing in the manager'
    );

    const report = await runSync();
    const row = report.entries.find((entry) => entry.type === 'native_plugins');
    assert.equal(row?.detail, 'stale');
    assert.equal(row?.outcome, 'written');
    assert.deepEqual(
      manager.calls().filter((call) => call[1] === 'enable'),
      [['plugin', 'enable', '--scope', 'user', 'codex@openai-codex']]
    );
    assert.equal(manager.state().plugins[0].enabled, true);
  });
});

test('a plugin enabled in both channels is refused rather than installed twice', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { 'openai/codex@main': 'openai-codex' },
      { 'openai/codex@main': REGISTRATION }
    );
    writeUserConfig(scratch, `${nativeConfig()}\n[plugins]\nenabled = ["codex@openai-codex"]\n`);

    const report = await runSync();
    const row = report.entries.find((entry) => entry.type === 'native_plugins');
    assert.ok(row);
    assert.equal(row.outcome, 'failed');
    assert.match(row.reason ?? '', /also enabled through \[plugins\].enabled/);
    assert.ok(
      !manager.calls().some((call) => call[1] === 'install'),
      'nothing is installed while the channels disagree'
    );
    assert.equal(report.exitCode, 1);
  });
});

test('a catalog the manager refuses is reported instead of installed', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    const root = seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { 'openai/codex@main': 'openai-codex' },
      { 'openai/codex@main': REGISTRATION }
    );
    manager.setState({ invalid: [root] } as never);
    writeUserConfig(scratch, nativeConfig());

    const report = await runSync();
    const row = report.entries.find((entry) => entry.type === 'native_plugins');
    assert.ok(row);
    assert.equal(row.outcome, 'failed');
    assert.match(row.reason ?? '', /marketplace manifest is not valid/);
    assert.ok(!manager.calls().some((call) => call[2] === 'add'));
  });
});

test('a local registration asb made migrates to the portable one, install included', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    const root = seedMarketplaceSource(scratch);
    const manager = installFakeManager(
      scratch,
      { [root]: 'openai-codex', 'openai/codex@main': 'openai-codex' },
      { [root]: { source: 'directory', path: root }, 'openai/codex@main': REGISTRATION }
    );

    // First the source is only a directory: nothing about it travels, so the
    // manager is told where it is.
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[applications.claude-code.native_plugins]',
        'enabled = ["codex@openai-codex"]',
        '',
      ].join('\n')
    );
    await runSync();
    assert.deepEqual(manager.state().marketplaces, [
      { name: 'openai-codex', source: { source: 'directory', path: root } },
    ]);
    assert.equal(settingsOf(scratch).extraKnownMarketplaces, undefined);
    manager.reset();

    // Then it gains a remote, so the registration can become portable.
    writeUserConfig(scratch, nativeConfig());
    const report = await runSync();

    const row = report.entries.find((entry) => entry.type === 'native_plugins');
    assert.equal(row?.outcome, 'written', JSON.stringify(report.entries, null, 2));
    assert.match(row?.reason ?? '', /marketplace migrated/);
    assert.deepEqual(manager.calls().slice(3), [
      ['plugin', 'marketplace', 'remove', '--scope', 'user', 'openai-codex'],
      ['plugin', 'marketplace', 'add', '--scope', 'user', 'openai/codex@main'],
      // The removal took the install with it, so it is put back.
      ['plugin', 'install', '--scope', 'user', 'codex@openai-codex'],
    ]);
    assert.deepEqual(
      manager.state().plugins.map((entry) => entry.id),
      ['codex@openai-codex']
    );
    assert.deepEqual(settingsOf(scratch).extraKnownMarketplaces, {
      'openai-codex': { source: REGISTRATION },
    });
  });
});

test('a native plugin scope other than user is refused by configuration', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedMarketplaceSource(scratch);
    writeUserConfig(
      scratch,
      nativeConfig().replace(
        'enabled = ["codex@openai-codex"]',
        'enabled = ["codex@openai-codex"]\nscope = "project"'
      )
    );
    await assert.rejects(runSync(), /native_plugins\.scope/);
  });
});
