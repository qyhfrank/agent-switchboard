import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from '@iarna/toml';
import { editSelection, loadConfig } from '../../src/engine/config.js';
import { withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function readUserConfig(asbHome: string): string {
  return fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8');
}

function parsedRulesEnabled(asbHome: string): unknown {
  const parsed = parse(readUserConfig(asbHome)) as Record<string, unknown>;
  const rules = (parsed.rules ?? {}) as Record<string, unknown>;
  return rules.enabled;
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
