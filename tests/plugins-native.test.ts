import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appRows } from '../src/engine/apps.js';
import { runExplain, runSync } from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import {
  applyNative,
  captureNative,
  type NativeCommandRunner,
  type NativeWork,
  planNative,
} from '../src/engine/native.js';
import { readSourceCatalog } from '../src/engine/sources.js';
import {
  installApps,
  type ScratchHomes,
  seedMarketplace,
  seedSource,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The native apply kind: an app whose own plugin manager owns the install.
 * There is no file to prove ownership with, so every run probes the manager and
 * plans against what it reports. Both managers live here: the Claude dialect,
 * driven through a real process on the run's PATH so the verbs, their order and
 * their arguments are exercised rather than mocked; and the Codex dialect,
 * which wraps a bare plugin in state asb materializes before it shells out.
 */

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

interface FakeManager {
  /** Everything the manager was asked to do, one argv per call. */
  calls(): string[][];
  state(): {
    marketplaces: { name: string; source: unknown }[];
    plugins: Record<string, unknown>[];
  };
  setState(next: Record<string, unknown>): void;
  reset(): void;
}

/**
 * Run `body` with a stateful manager on the PATH. The manager cannot resolve a
 * registration argument to a catalog by itself, so each argument is declared
 * with the name and source it stands for; everything else it decides from its
 * own state. The three variables it is steered by are this file's own —
 * withScratchHomes restores the ASB and XDG roots only — so they are put back
 * here rather than left for whatever runs next.
 */
async function withFakeManager<T>(
  homes: ScratchHomes,
  registrations: Record<string, { name: string; source: unknown }>,
  body: (manager: FakeManager) => Promise<T>
): Promise<T> {
  const binDir = path.join(homes.root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'claude');
  fs.writeFileSync(binPath, FAKE_SOURCE, 'utf-8');
  fs.chmodSync(binPath, 0o755);

  const statePath = path.join(homes.root, 'manager-state.json');
  const logPath = path.join(homes.root, 'manager-log.txt');
  const names: Record<string, string> = {};
  const sources: Record<string, unknown> = {};
  for (const [argument, registration] of Object.entries(registrations)) {
    names[argument] = registration.name;
    sources[argument] = registration.source;
  }
  const initial = { marketplaces: [], plugins: [], invalid: [], names, sources };
  fs.writeFileSync(statePath, JSON.stringify(initial, null, 2), 'utf-8');
  fs.writeFileSync(logPath, '', 'utf-8');

  const previous = {
    PATH: process.env.PATH,
    FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE,
    FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.FAKE_CLAUDE_STATE = statePath;
  process.env.FAKE_CLAUDE_LOG = logPath;
  try {
    return await body({
      calls: () =>
        fs
          .readFileSync(logPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
      state: () => JSON.parse(fs.readFileSync(statePath, 'utf-8')),
      setState: (next) => {
        const current = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
        fs.writeFileSync(statePath, JSON.stringify({ ...current, ...next }, null, 2), 'utf-8');
      },
      reset: () => fs.writeFileSync(logPath, '', 'utf-8'),
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * A marketplace source declared with a GitHub remote but held in the library
 * tree, so the registration asb computes is the portable one without any
 * command in this file reaching the network.
 */
function seedManagedSource(homes: ScratchHomes): string {
  seedMarketplace(homes, 'openai-codex', 'openai-codex', 'codex', {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'codex', version: '1.0.0' }),
  });
  return path.join(homes.asbHome, 'plugins', 'openai-codex');
}

function managedConfig(): string {
  return [
    '[applications]',
    'enabled = ["claude-code"]',
    '',
    '[applications.claude-code.native_plugins]',
    'enabled = ["codex@openai-codex"]',
    '',
    '[plugins.sources]',
    'openai-codex = { url = "https://github.com/openai/codex.git", type = "subtree", ref = "main" }',
    '',
  ].join('\n');
}

const REGISTRATION = { source: 'github', repo: 'openai/codex', ref: 'main' };
const REMOTE_ARGUMENT = { 'openai/codex@main': { name: 'openai-codex', source: REGISTRATION } };

function settingsOf(homes: ScratchHomes): Record<string, unknown> {
  const filePath = path.join(homes.agentsHome, '.claude', 'settings.json');
  return fs.existsSync(filePath)
    ? (JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>)
    : {};
}

test('a native plugin registers through the manager by a portable reference', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const root = seedManagedSource(homes);
    await withFakeManager(homes, REMOTE_ARGUMENT, async (manager) => {
      writeUserConfig(homes, managedConfig());

      const report = await runSync();
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));

      // The protocol: validate the catalog, read the manager's state, then act
      // on it. GitHub remotes register portably, by `org/repo@ref` rather than
      // by a path only this machine has.
      assert.deepEqual(manager.calls(), [
        ['plugin', 'validate', root],
        ['plugin', 'marketplace', 'list', '--json'],
        ['plugin', 'list', '--json'],
        ['plugin', 'marketplace', 'add', '--scope', 'user', 'openai/codex@main'],
        ['plugin', 'install', '--scope', 'user', 'codex@openai-codex'],
      ]);

      const row = report.entries.find((entry) => entry.type === 'native_plugins');
      assert.ok(row);
      assert.equal(row.id, 'codex@openai-codex');
      assert.equal(row.outcome, 'written');

      // The portable declaration is recorded where the app reads it.
      assert.deepEqual(settingsOf(homes).extraKnownMarketplaces, {
        'openai-codex': { source: REGISTRATION },
      });
    });
  });
});

test('an unchanged install asks the manager to change nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const root = seedManagedSource(homes);
    await withFakeManager(homes, REMOTE_ARGUMENT, async (manager) => {
      writeUserConfig(homes, managedConfig());
      await runSync();
      manager.reset();

      const second = await runSync();

      const row = second.entries.find((entry) => entry.type === 'native_plugins');
      assert.ok(row);
      assert.equal(row.outcome, 'unchanged', JSON.stringify(second.entries, null, 2));
      assert.deepEqual(
        manager.calls(),
        [
          ['plugin', 'validate', root],
          ['plugin', 'marketplace', 'list', '--json'],
          ['plugin', 'list', '--json'],
        ],
        'a settled install runs read-only verbs only'
      );
    });
  });
});

test('a plugin disabled behind asb’s back reports stale, then a real run re-enables it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedManagedSource(homes);
    await withFakeManager(homes, REMOTE_ARGUMENT, async (manager) => {
      writeUserConfig(homes, managedConfig());
      await runSync();

      // The user disabled it in the app itself.
      manager.setState({
        plugins: manager.state().plugins.map((entry) => ({ ...entry, enabled: false })),
      });
      manager.reset();

      const preview = (await runSync({ dryRun: true })).entries.find(
        (entry) => entry.type === 'native_plugins'
      );
      assert.equal(preview?.detail, 'stale');
      assert.ok(
        !manager.calls().some((call) => call[1] === 'enable'),
        'a preview changes nothing in the manager'
      );

      const row = (await runSync()).entries.find((entry) => entry.type === 'native_plugins');
      assert.equal(row?.detail, 'stale');
      assert.equal(row?.outcome, 'written');
      assert.deepEqual(
        manager.calls().filter((call) => call[1] === 'enable'),
        [['plugin', 'enable', '--scope', 'user', 'codex@openai-codex']]
      );
      assert.equal(manager.state().plugins[0].enabled, true);
    });
  });
});

test('a plugin enabled in both channels is refused rather than installed twice', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedManagedSource(homes);
    await withFakeManager(homes, REMOTE_ARGUMENT, async (manager) => {
      writeUserConfig(homes, `${managedConfig()}\n[plugins]\nenabled = ["codex@openai-codex"]\n`);

      const report = await runSync();

      const row = report.entries.find((entry) => entry.type === 'native_plugins');
      assert.ok(row);
      assert.equal(row.outcome, 'failed');
      assert.match(row.reason ?? '', /\[plugins\]\.enabled/, 'the row names the other channel');
      assert.ok(
        !manager.calls().some((call) => call[1] === 'install'),
        'nothing is installed while the channels disagree'
      );
      assert.equal(report.exitCode, 1);
    });
  });
});

test('a catalog the manager refuses is reported instead of installed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const root = seedManagedSource(homes);
    await withFakeManager(homes, REMOTE_ARGUMENT, async (manager) => {
      manager.setState({ invalid: [root] });
      writeUserConfig(homes, managedConfig());

      const report = await runSync();

      const row = report.entries.find((entry) => entry.type === 'native_plugins');
      assert.ok(row);
      assert.equal(row.outcome, 'failed');
      // The manager's own refusal reaches the row instead of being swallowed.
      assert.match(row.reason ?? '', /marketplace manifest is not valid/);
      assert.ok(!manager.calls().some((call) => call[2] === 'add'));
    });
  });
});

test('a local registration asb made migrates to the portable one, install included', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const root = seedManagedSource(homes);
    const registrations = {
      [root]: { name: 'openai-codex', source: { source: 'directory', path: root } },
      ...REMOTE_ARGUMENT,
    };
    await withFakeManager(homes, registrations, async (manager) => {
      // First the source is only a directory: nothing about it travels, so the
      // manager is told where it is.
      writeUserConfig(
        homes,
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
      assert.equal(settingsOf(homes).extraKnownMarketplaces, undefined);
      manager.reset();

      // Then it gains a remote, so the registration can become portable.
      writeUserConfig(homes, managedConfig());
      const report = await runSync();

      const row = report.entries.find((entry) => entry.type === 'native_plugins');
      assert.equal(row?.outcome, 'written', JSON.stringify(report.entries, null, 2));
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
      assert.deepEqual(settingsOf(homes).extraKnownMarketplaces, {
        'openai-codex': { source: REGISTRATION },
      });
    });
  });
});

test('a native plugin scope other than user is refused by configuration', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedManagedSource(homes);
    writeUserConfig(
      homes,
      managedConfig().replace(
        'enabled = ["codex@openai-codex"]',
        'enabled = ["codex@openai-codex"]\nscope = "project"'
      )
    );

    await assert.rejects(runSync(), /native_plugins\.scope/);
  });
});

/** A bare plugin: no marketplace of its own, so asb has to wrap it. */
function seedBarePlugin(homes: ScratchHomes): string {
  return seedSource(homes, 'bare', {
    '.codex-plugin/plugin.json': '{"name":"demo","version":"1.0.0"}\n',
    'README.md': 'Demo.\n',
  });
}

function codexConfig(enabled: string[]): string {
  return [
    '[applications]',
    'enabled = ["codex"]',
    'assume_installed = ["codex"]',
    '',
    '[applications.codex.native_plugins]',
    `enabled = ${JSON.stringify(enabled)}`,
    '',
  ].join('\n');
}

/** Probe the Codex manager with `runner`, then plan against what it reported. */
function planCodex(runner: NativeCommandRunner, dryRun = false) {
  const config = loadConfig();
  const catalog = readSourceCatalog(config);
  const table = appRows(config);
  const capture = captureNative(
    config,
    catalog,
    table,
    process.env,
    { codex: true },
    dryRun,
    runner
  );
  return planNative({
    config,
    catalog,
    capture,
    table,
    env: process.env,
    installed: { codex: true },
    dryRun,
  });
}

function wrapperRoot(homes: ScratchHomes, name: string): string {
  return path.join(homes.asbHome, 'state', 'native-plugins', 'codex', name);
}

test('a bare Codex plugin is wrapped in asb state and added through the probed verbs', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedBarePlugin(homes);
    writeUserConfig(homes, codexConfig(['bare']));
    const probed: string[][] = [];
    const actions = planCodex((_bin, args) => {
      probed.push([...args]);
      return { status: 0, stdout: '{"marketplaces":[]}\n', stderr: '' };
    });

    assert.deepEqual(probed, [['plugin', 'marketplace', 'list', '--json']]);
    assert.equal(actions.length, 1);
    const wrapper = wrapperRoot(homes, 'bare');
    assert.deepEqual(actions[0].native?.commands, [
      ['plugin', 'marketplace', 'add', wrapper, '--json'],
      ['plugin', 'list', '--marketplace', 'bare', '--json'],
      ['plugin', 'add', 'demo@bare', '--json'],
    ]);

    const applied: string[][] = [];
    const failure = applyNative(
      actions[0].native as NonNullable<(typeof actions)[0]['native']>,
      (_bin, args) => {
        applied.push([...args]);
        return { status: 0, stdout: '{}\n', stderr: '' };
      }
    );

    assert.equal(failure, undefined);
    assert.deepEqual(applied, actions[0].native?.commands);
    // The wrapper is a marketplace of one, linked back to the plugin source.
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(wrapper, '.agents', 'plugins', 'marketplace.json'), 'utf-8')
      ),
      { name: 'bare', plugins: [{ name: 'demo', source: './plugins/demo' }] }
    );
    assert.equal(fs.realpathSync(path.join(wrapper, 'plugins', 'demo')), fs.realpathSync(source));
  });
});

test('a Codex preview invokes no manager and materializes no wrapper', async () => {
  await withScratchHomes(async (homes) => {
    seedBarePlugin(homes);
    writeUserConfig(homes, codexConfig(['bare']));
    let calls = 0;

    const actions = planCodex(() => {
      calls++;
      throw new Error('a preview must not invoke Codex');
    }, true);

    assert.equal(calls, 0);
    assert.equal(actions[0].outcome, 'written');
    assert.equal(actions[0].native, undefined);
    assert.equal(fs.existsSync(path.dirname(wrapperRoot(homes, 'bare'))), false);
  });
});

test('Codex refuses a foreign marketplace of the same name and retires a deselected wrapper', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedBarePlugin(homes);
    writeUserConfig(homes, codexConfig(['bare']));

    const refused = planCodex((_bin, args) => ({
      status: 0,
      stdout:
        args[1] === 'marketplace'
          ? '{"marketplaces":[{"name":"bare","root":"/foreign"}]}'
          : '{"installed":[]}',
      stderr: '',
    }));

    assert.equal(refused[0].outcome, 'conflict');
    assert.equal(refused[0].native, undefined, 'a name someone else registered is not overwritten');

    // Now the same wrapper exists and asb owns it, but nothing selects it.
    const wrapper = wrapperRoot(homes, 'bare');
    fs.mkdirSync(path.join(wrapper, '.agents', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(wrapper, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(wrapper, '.agents', 'plugins', 'marketplace.json'),
      '{"name":"bare","plugins":[{"name":"demo","source":"./plugins/demo"}]}\n',
      'utf-8'
    );
    fs.symlinkSync(source, path.join(wrapper, 'plugins', 'demo'), 'dir');
    writeUserConfig(homes, codexConfig([]));

    let managerCalls = 0;
    const manager: NativeCommandRunner = (_bin, args) => {
      managerCalls++;
      return {
        status: 0,
        stdout:
          args[1] === 'marketplace'
            ? JSON.stringify({ marketplaces: [{ name: 'bare', root: wrapper }] })
            : '{"installed":[{"id":"demo@bare","enabled":true,"version":"1.0.0"}]}',
        stderr: '',
      };
    };
    const retired = planCodex(manager);

    assert.equal(retired[0].outcome, 'removed');
    assert.deepEqual(retired[0].native?.commands, [
      ['plugin', 'remove', 'demo@bare', '--json'],
      ['plugin', 'marketplace', 'remove', 'bare', '--json'],
    ]);
    assert.equal(
      applyNative(retired[0].native as NonNullable<(typeof retired)[0]['native']>, manager),
      undefined
    );
    assert.equal(fs.existsSync(wrapper), false);

    managerCalls = 0;
    planCodex(manager);
    assert.equal(managerCalls, 0, 'an empty state root does not keep Codex capture active');
  });
});

test('a partial Codex wrapper conflicts without hiding healthy managed wrappers', async () => {
  await withScratchHomes(async (homes) => {
    const good = wrapperRoot(homes, 'good');
    fs.mkdirSync(path.join(good, '.agents', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(good, 'plugins'), { recursive: true });
    fs.symlinkSync(homes.asbHome, path.join(good, 'plugins', 'good'), 'dir');
    fs.writeFileSync(
      path.join(good, '.agents', 'plugins', 'marketplace.json'),
      '{"name":"good","plugins":[{"name":"good","source":"./plugins/good"}]}\n',
      'utf-8'
    );
    // Unrecognizable: a directory with none of the wrapper's contents.
    const partial = wrapperRoot(homes, 'partial');
    fs.mkdirSync(path.join(partial, '.agents', 'plugins'), { recursive: true });
    writeUserConfig(homes, codexConfig([]));

    const actions = planCodex(() => ({ status: 0, stdout: '{"marketplaces":[]}\n', stderr: '' }));

    const conflicts = actions.filter((action) => action.outcome === 'conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.path, partial);
    assert.equal(
      actions.some((action) => action.id === 'good@good' && action.outcome === 'removed'),
      true,
      'one damaged directory does not blind the rest of the reconciliation'
    );
  });
});

test('a failed Codex verb restores the wrapper it rewrote and drops the root it created', async () => {
  await withScratchHomes(async (homes) => {
    const stateRoot = path.dirname(wrapperRoot(homes, 'bare'));
    const root = wrapperRoot(homes, 'bare');
    const oldSource = path.join(homes.root, 'old-source');
    const newSource = path.join(homes.root, 'new-source');
    fs.mkdirSync(oldSource);
    fs.mkdirSync(newSource);
    fs.mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    const link = path.join(root, 'plugins', 'demo');
    fs.symlinkSync(oldSource, link, 'dir');
    const manifestPath = path.join(root, '.agents', 'plugins', 'marketplace.json');
    const originalManifest =
      '{\n  "name": "bare",\n  "plugins": [{ "name": "demo", "source": "./plugins/demo" }]\n}\n';
    fs.writeFileSync(manifestPath, originalManifest, 'utf-8');
    const rewrite: NativeWork = {
      bin: 'codex',
      env: process.env,
      commands: [['first'], ['second']],
      compensate: [],
      setting: null,
      prepare: {
        root,
        stateRoot,
        marketplaceName: 'bare',
        pluginName: 'demo',
        ref: 'demo@bare',
        sourcePath: newSource,
      },
    };

    let calls = 0;
    const failure = applyNative(rewrite, () => ({
      status: ++calls === 2 ? 1 : 0,
      stdout: '',
      stderr: calls === 2 ? 'simulated failure' : '',
    }));

    assert.match(failure ?? '', /simulated failure/);
    assert.equal(fs.realpathSync(link), fs.realpathSync(oldSource));
    assert.equal(fs.readFileSync(manifestPath, 'utf-8'), originalManifest);

    // The other branch of the same contract: a wrapper this run created and
    // could not finish leaves no directory behind either.
    const created = wrapperRoot(homes, 'bad');
    const materialize: NativeWork = {
      bin: 'codex',
      env: process.env,
      commands: [],
      compensate: [],
      setting: null,
      prepare: {
        root: created,
        stateRoot,
        marketplaceName: 'bad',
        pluginName: 'bad',
        ref: 'bad@bad',
        sourcePath: 'invalid\0source',
      },
    };

    assert.match(applyNative(materialize) ?? '', /null bytes|must be a string without null bytes/i);
    assert.equal(fs.existsSync(created), false);
  });
});

test('explain reports a native-managed plugin without hashes and names its source', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedSource(homes, 'bare', {
      '.codex-plugin/plugin.json': '{"name":"demo","version":"1.0.0"}\n',
    });
    writeUserConfig(homes, codexConfig(['bare']));

    const { slices } = await runExplain('demo@bare');

    assert.equal(slices.length, 1, JSON.stringify(slices, null, 2));
    assert.equal(slices[0].app, 'codex');
    // The manager owns the install, so there is nothing to hash or diff.
    assert.equal(slices[0].provenance, 'native-manager');
    assert.equal(slices[0].currentHash, null);
    assert.equal(slices[0].desiredHash, null);
    assert.equal(slices[0].desired, null);
    assert.deepEqual(slices[0].sources, [{ id: 'bare', source: 'bare', path: source }]);
  });
});
