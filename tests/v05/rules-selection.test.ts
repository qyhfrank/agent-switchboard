import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from '@iarna/toml';
import { editSelection, loadConfig } from '../../src/engine/config.js';
import { type ScratchHomes, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

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

test('loadConfig without any config file yields an empty selection', async () => {
  await withScratchHomes(async ({ asbHome }) => {
    const config = loadConfig();
    assert.deepEqual(config.selection.rules, []);
    assert.deepEqual(config.apps.enabled, []);
    assert.equal(config.rules.includeDelimiters, false);
    assert.equal(fs.existsSync(path.join(asbHome, 'config.toml')), false);
  });
});

test('enable normalizes, dedupes, and persists rule ids', async () => {
  await withScratchHomes(async ({ asbHome }) => {
    editSelection({ type: 'rules', enable: [' alpha ', 'alpha', 'beta'] });

    assert.deepEqual(parsedRulesEnabled(asbHome), ['alpha', 'beta']);
    assert.deepEqual(loadConfig().selection.rules, ['alpha', 'beta']);
  });
});

test('enable preserves comments and commented-out lines in config.toml', async () => {
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
        ']\n'
    );

    editSelection({ type: 'rules', enable: ['beta'] });

    const content = readUserConfig(homes.asbHome);
    assert.ok(content.includes('# my machines'));
    assert.ok(content.includes('# keep'));
    assert.ok(content.includes('# enabled = ["draft"]'));
    assert.ok(content.includes('# first'));
    assert.deepEqual(parsedRulesEnabled(homes.asbHome), ['alpha', 'beta']);
    assert.deepEqual(loadConfig().apps.enabled, ['claude-code']);
  });
});

test('disable splices a rule id out and keeps the rest intact', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '# header\n[rules]\nenabled = ["alpha", "beta"]\n');

    editSelection({ type: 'rules', disable: ['alpha'] });

    const content = readUserConfig(homes.asbHome);
    assert.ok(content.includes('# header'));
    assert.deepEqual(parsedRulesEnabled(homes.asbHome), ['beta']);
    assert.deepEqual(loadConfig().selection.rules, ['beta']);
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
  });
});

test('legacy selection spellings still load', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nactive = ["alpha"]\n');

    assert.deepEqual(loadConfig().selection.rules, ['alpha']);
  });
});

test('enable appends after the last element when ] shares its line', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = [\n  "alpha"]\n');

    editSelection({ type: 'rules', enable: ['beta'] });

    const content = fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
    const parsed = parse(content) as { rules?: { enabled?: string[] } };
    assert.deepEqual(
      parsed.rules?.enabled,
      ['alpha', 'beta'],
      'additions never jump ahead of existing ids'
    );
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

test('a section the profile leaves out selects nothing', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["alpha"]\n\n[commands]\nenabled = ["ship"]\n'
    );
    writeProfile(homes, 'aws', '[applications]\nenabled = ["claude-code"]\n');

    const config = loadConfig({ profile: 'aws' });

    assert.deepEqual(config.selection.rules, [], 'a profile declares everything it uses');
    assert.deepEqual(config.selection.commands, []);
  });
});

test('ASB_PROFILE names the same file -p does', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["alpha"]\n');
    writeProfile(homes, 'aws', '[rules]\nenabled = ["beta"]\n');
    process.env.ASB_PROFILE = 'aws';

    assert.deepEqual(loadConfig().selection.rules, ['beta']);
    assert.equal(loadConfig().profile, 'aws');
  });
});

test('a rule enabled under a profile lands in the profile file alone', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["alpha"]\n');
    const profilePath = writeProfile(homes, 'aws', '# aws machine\n[rules]\nenabled = ["beta"]\n');
    const untouched = readUserConfig(homes.asbHome);

    editSelection({ type: 'rules', enable: ['gamma'], profile: 'aws' });

    assert.deepEqual(parsedRules(profilePath), ['beta', 'gamma']);
    assert.match(fs.readFileSync(profilePath, 'utf-8'), /# aws machine/);
    assert.equal(readUserConfig(homes.asbHome), untouched, 'the edit never reaches config.toml');
  });
});

test('editing a symlinked config writes through the link and keeps its mode', async () => {
  await withScratchHomes(async (homes) => {
    const backing = path.join(homes.root, 'dotfiles', 'asb-config.toml');
    fs.mkdirSync(path.dirname(backing), { recursive: true });
    fs.writeFileSync(backing, '[rules]\nenabled = ["alpha"]\n');
    fs.chmodSync(backing, 0o600);
    const configPath = path.join(homes.asbHome, 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.symlinkSync(backing, configPath);

    editSelection({ type: 'rules', enable: ['beta'] });

    assert.ok(fs.lstatSync(configPath).isSymbolicLink(), 'the link survives the edit');
    assert.match(fs.readFileSync(backing, 'utf-8'), /"beta"/);
    assert.equal(fs.statSync(backing).mode & 0o777, 0o600, 'permission bits preserved');
  });
});
