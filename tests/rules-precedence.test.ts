import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import {
  effectiveIncludeDelimiters,
  effectiveSelection,
  loadConfig,
} from '../src/engine/config.js';
import {
  entryFor,
  installApps,
  renderedRules,
  ruleFilePath,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

test('a per-app override resolves against the global selection for that app alone', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex", "gemini", "opencode", "cursor"]',
        '',
        '[rules]',
        'enabled = ["rule-a", "rule-b", "rule-c"]',
        '',
        '[commands]',
        'enabled = ["cmd-a", "cmd-b"]',
        '',
        '[applications.codex.rules]',
        'remove = ["rule-b"]',
        'add = ["rule-d"]',
        '',
        '[applications.gemini.rules]',
        'enabled = ["rule-x", "rule-y"]',
        '',
        '[applications.opencode.rules]',
        'enabled = []',
        '',
        '[applications.cursor.rules]',
        'add = ["rule-b", "rule-e"]',
        '',
        '[applications.codex.commands]',
        'remove = ["cmd-a"]',
      ].join('\n')
    );
    const config = loadConfig();

    assert.deepEqual(
      effectiveSelection(config, 'claude-code', 'rules'),
      ['rule-a', 'rule-b', 'rule-c'],
      'no override leaves the global selection alone'
    );
    assert.deepEqual(effectiveSelection(config, 'codex', 'rules'), ['rule-a', 'rule-c', 'rule-d']);
    assert.deepEqual(
      effectiveSelection(config, 'gemini', 'rules'),
      ['rule-x', 'rule-y'],
      'enabled replaces rather than merges'
    );
    assert.deepEqual(
      effectiveSelection(config, 'opencode', 'rules'),
      [],
      'an explicitly empty enabled list replaces the base with nothing'
    );
    assert.deepEqual(
      effectiveSelection(config, 'cursor', 'rules'),
      ['rule-a', 'rule-b', 'rule-c', 'rule-e'],
      'add keeps the first occurrence of an id already selected'
    );
    // The same algebra governs every component type, not rules alone.
    assert.deepEqual(effectiveSelection(config, 'codex', 'commands'), ['cmd-b']);
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'commands'), ['cmd-a', 'cmd-b']);
  });
});

test('a rule removed for one app stays out of only that app target bytes', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'alpha.md', 'Alpha body.\n');
    seedRule(homes, 'beta.md', 'Beta body.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["alpha", "beta"]',
        '',
        '[applications.codex.rules]',
        'remove = ["beta"]',
      ].join('\n')
    );
    installApps(homes, 'claude-code', 'codex');

    const report = await runSync();

    assert.equal(report.exitCode, 0);
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Alpha body.\n\nBeta body.\n')
    );
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', 'Alpha body.\n'),
      'the removed rule never reaches the codex render'
    );
  });
});

test('an emptied per-app selection removes that app target and no other', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'alpha.md', 'Alpha body.\n');
    const base = [
      '[applications]',
      'enabled = ["claude-code", "codex"]',
      '',
      '[rules]',
      'enabled = ["alpha"]',
    ];
    writeUserConfig(homes, base.join('\n'));
    installApps(homes, 'claude-code', 'codex');
    await runSync();
    assert.ok(fs.existsSync(ruleFilePath(homes, 'codex')));

    writeUserConfig(homes, [...base, '', '[applications.codex.rules]', 'enabled = []'].join('\n'));
    const report = await runSync();

    assert.equal(report.exitCode, 0);
    assert.equal(report.summary.removed, 1);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false, 'codex target removed');
    assert.equal(fs.existsSync(ruleFilePath(homes, 'claude-code')), true, 'claude-code untouched');
  });
});

test('includeDelimiters can be overridden per app', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'alpha.md', 'Alpha body.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["alpha"]',
        '',
        '[applications.codex.rules]',
        'includeDelimiters = true',
      ].join('\n')
    );
    installApps(homes, 'claude-code', 'codex');

    const config = loadConfig();
    assert.equal(effectiveIncludeDelimiters(config, 'codex'), true);
    assert.equal(effectiveIncludeDelimiters(config, 'claude-code'), false);

    assert.equal((await runSync()).exitCode, 0);
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', '<!-- alpha:start -->\nAlpha body.\n<!-- alpha:end -->\n')
    );
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Alpha body.\n'),
      'the other app renders without per-rule markers'
    );
  });
});

test('a rule missing only from one app effective set blocks only that app', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'alpha.md', 'Alpha body.\n');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["alpha"]',
        '',
        '[applications.codex.rules]',
        'add = ["ghost"]',
      ].join('\n')
    );
    installApps(homes, 'claude-code', 'codex');

    const report = await runSync();

    assert.equal(report.exitCode, 1);
    assert.equal(
      entryFor(report, { app: 'claude-code', type: 'rules' })?.outcome,
      'written',
      'the clean app still syncs'
    );
    const blocked = entryFor(report, { app: 'codex', type: 'rules' });
    assert.equal(blocked?.outcome, 'failed');
    assert.equal(blocked?.detail, 'aggregate-blocked');
    assert.match(blocked?.reason ?? '', /ghost/);
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false);
    assert.equal(entryFor(report, { id: 'ghost' })?.outcome, 'missing');
  });
});
