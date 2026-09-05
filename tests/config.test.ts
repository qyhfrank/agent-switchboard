import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from '@iarna/toml';
import {
  clearDefaultProfile,
  defaultProfilePath,
  editSelection,
  loadConfig,
  readDefaultProfile,
  resolveProfile,
  setDefaultProfile,
} from '../src/engine/config.js';
import { type ScratchHomes, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/**
 * config.toml and the profile files beside it: what loadConfig resolves from
 * them, and how the selection writer edits them in place.
 */

function readUserConfig(asbHome: string): string {
  return fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8');
}

function writeProfile(homes: ScratchHomes, name: string, toml: string): string {
  const filePath = path.join(homes.asbHome, `${name}.toml`);
  fs.writeFileSync(filePath, toml, 'utf-8');
  return filePath;
}

function parsedRules(filePath: string): unknown {
  const parsed = parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  return ((parsed.rules ?? {}) as Record<string, unknown>).enabled;
}

function parsedRulesEnabled(asbHome: string): unknown {
  return parsedRules(path.join(asbHome, 'config.toml'));
}

test('the selector path uses an absolute XDG configuration root or the OS home', () => {
  const fallback = path.join(os.homedir(), '.config', 'asb', 'profile');
  for (const value of [undefined, '', '   ', 'relative/config']) {
    assert.equal(defaultProfilePath({ XDG_CONFIG_HOME: value }), fallback);
  }
  assert.equal(
    defaultProfilePath({ XDG_CONFIG_HOME: '/tmp/asb-config' }),
    '/tmp/asb-config/asb/profile'
  );
});

test('profile resolution follows precedence and bypasses an invalid lower-priority selector', async () => {
  await withScratchHomes(async (homes) => {
    for (const name of ['work', 'personal']) writeProfile(homes, name, '[rules]\nenabled = []\n');
    assert.deepEqual(resolveProfile(), { name: null, source: 'user' });
    setDefaultProfile('work');
    assert.equal(fs.readFileSync(defaultProfilePath(), 'utf-8'), 'work\n');
    assert.deepEqual(resolveProfile(), { name: 'work', source: 'default' });
    process.env.ASB_PROFILE = 'personal';
    assert.deepEqual(resolveProfile(), { name: 'personal', source: 'env' });
    assert.deepEqual(resolveProfile('work'), { name: 'work', source: 'cli' });
    assert.equal(readDefaultProfile(), 'work');
    for (const invalid of ['work\npersonal\n', '../work', 'absent']) {
      fs.writeFileSync(defaultProfilePath(), invalid);
      assert.equal(loadConfig().profile, 'personal');
      assert.equal(loadConfig({ profile: 'work' }).profile, 'work');
      delete process.env.ASB_PROFILE;
      assert.throws(() => loadConfig());
      clearDefaultProfile();
      clearDefaultProfile();
      assert.equal(resolveProfile().name, null);
      process.env.ASB_PROFILE = 'personal';
    }
  });
});

test('a saved profile accepts spaces within one name and rejects multiple lines or unsafe names', async () => {
  await withScratchHomes(async (homes) => {
    writeProfile(homes, 'work laptop', '[rules]\nenabled = []\n');
    setDefaultProfile('work laptop');
    fs.writeFileSync(defaultProfilePath(), ' \twork laptop\r\n');
    assert.equal(loadConfig().profile, 'work laptop');
    for (const name of ['work\nlaptop', '../work', 'config', 'absent', '']) {
      assert.throws(() => setDefaultProfile(name));
      assert.equal(readDefaultProfile(), 'work laptop');
    }
    fs.writeFileSync(defaultProfilePath(), ' \t\n');
    assert.equal(loadConfig().profile, null);
  });
});

test('ASB_CONFIG owns fallback selection edits and infrastructure under a saved profile', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["base"]\n');
    const user = path.join(homes.asbHome, 'config.toml');
    const original = fs.readFileSync(user, 'utf-8');
    const redirected = path.join(homes.root, 'redirected.toml');
    fs.writeFileSync(redirected, '[rules]\nenabled = []\n[ui]\npage_size = 31\n');
    process.env.ASB_CONFIG = redirected;
    editSelection({ type: 'rules', enable: ['redirected'] });
    assert.deepEqual(loadConfig().selection.rules, ['redirected']);
    writeProfile(homes, 'work', '[rules]\nenabled = ["work"]\n[ui]\npage_size = 12\n');
    setDefaultProfile('work');
    assert.deepEqual(loadConfig().selection.rules, ['work']);
    assert.equal(loadConfig().ui.pageSize, 31);
    editSelection({ type: 'rules', enable: ['extra'] });
    assert.deepEqual(loadConfig().selection.rules, ['work', 'extra']);
    assert.deepEqual(parsedRules(redirected), ['redirected']);
    assert.equal(fs.readFileSync(user, 'utf-8'), original);
  });
});

test('a missing config file yields an empty selection and writes nothing', async () => {
  await withScratchHomes(async ({ asbHome }) => {
    const config = loadConfig();

    assert.deepEqual(config.selection.rules, []);
    assert.deepEqual(config.apps.enabled, []);
    assert.equal(config.rules.includeDelimiters, false);
    assert.equal(fs.existsSync(path.join(asbHome, 'config.toml')), false);
  });
});

test('enable normalizes, dedupes, and persists ids into a missing section', async () => {
  await withScratchHomes(async ({ asbHome }) => {
    editSelection({ type: 'rules', enable: [' alpha ', 'alpha', 'beta'] });

    assert.deepEqual(parsedRulesEnabled(asbHome), ['alpha', 'beta']);
    assert.deepEqual(loadConfig().selection.rules, ['alpha', 'beta']);
  });
});

test('the selection writer splices ids in and out and keeps every comment', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '# my machines\n' +
        '[applications]\n' +
        'enabled = ["claude-code"] # keep\n' +
        '\n' +
        '[rules]\n' +
        '# enabled = ["draft"]\n' +
        'enabled = [\n' +
        '  "alpha", # first\n' +
        '  "gamma"]\n'
    );

    editSelection({ type: 'rules', enable: ['beta'] });

    assert.deepEqual(
      parsedRulesEnabled(homes.asbHome),
      ['alpha', 'gamma', 'beta'],
      'an addition lands after the last element even when ] shares its line'
    );

    editSelection({ type: 'rules', disable: ['gamma'] });

    const content = readUserConfig(homes.asbHome);
    assert.ok(content.includes('# my machines'));
    assert.ok(content.includes('# keep'));
    assert.ok(content.includes('# enabled = ["draft"]'));
    assert.ok(content.includes('# first'));
    assert.deepEqual(parsedRulesEnabled(homes.asbHome), ['alpha', 'beta']);
    assert.deepEqual(loadConfig().selection.rules, ['alpha', 'beta']);
    assert.deepEqual(loadConfig().apps.enabled, ['claude-code'], 'sibling sections survive');
  });
});

test('an unknown config key aborts with the nearest-key suggestion', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabeld = ["alpha"]\n');
    assert.throws(
      () => loadConfig(),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes('enabeld') && message.includes('enabled');
      }
    );

    // A nested key set resolves the same way, named by its full dotted path.
    writeUserConfig(
      homes,
      '[targets.mine.mcp]\nformat = "yaml"\nconfig_pth = "~/.mine/config.yaml"\n'
    );
    assert.throws(loadConfig, /unknown key "targets\.mine\.mcp\.config_pth".*config_path/);
  });
});

test('the legacy selection spelling still loads', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nactive = ["alpha"]\n');

    assert.deepEqual(loadConfig().selection.rules, ['alpha']);
  });
});

test('a profile stands in for config.toml instead of merging over it', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n'
    );
    writeProfile(
      homes,
      'aws',
      '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["beta"]\n'
    );

    const config = loadConfig({ profile: 'aws' });

    assert.deepEqual(config.selection.rules, ['beta']);
    assert.deepEqual(config.apps.enabled, ['codex'], 'the profile is the whole selection');
    assert.deepEqual(
      config.layers.map((layer) => layer.kind),
      ['user', 'profile'],
      'config.toml is still read: a profile inherits its infrastructure'
    );
    assert.equal(config.profile, 'aws');

    process.env.ASB_PROFILE = 'aws';
    const fromEnv = loadConfig();
    assert.equal(fromEnv.profile, 'aws', 'the env var names the same file the option does');
    assert.deepEqual(fromEnv.selection.rules, ['beta']);
  });
});

test('a profile inherits machine infrastructure and never contributes its own', async () => {
  await withScratchHomes(async (homes) => {
    const library = path.join(homes.root, 'lib');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n\n' +
        `[ui]\npage_size = 35\n\n[plugins.sources]\nlib = ${JSON.stringify(library)}\n`
    );
    writeProfile(
      homes,
      'aws',
      '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["lib:style"]\n\n[ui]\npage_size = 5\n'
    );

    const config = loadConfig({ profile: 'aws' });

    assert.deepEqual(config.selection.rules, ['lib:style']);
    assert.equal(config.plugins.sources.lib, library, 'sources live in config.toml in every run');
    assert.equal(config.ui.pageSize, 35, "a profile's infrastructure keys never merge");
  });
});
