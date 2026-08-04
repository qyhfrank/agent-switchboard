import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import {
  effectiveIncludeDelimiters,
  effectiveSelection,
  loadConfig,
  mergeIncrementalSelection,
} from '../../src/engine/config.js';
import {
  installApps,
  mdcWrap,
  ruleFilePath,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

// Ported 0.4.35 acceptance: tests/application-config.test.ts merge semantics.
test('mergeIncrementalSelection carries the frozen 0.4 semantics', () => {
  assert.deepEqual(mergeIncrementalSelection(['a', 'b', 'c'], undefined), ['a', 'b', 'c']);
  assert.deepEqual(mergeIncrementalSelection(['a', 'b', 'c'], { enabled: ['x', 'y'] }), ['x', 'y']);
  assert.deepEqual(mergeIncrementalSelection(['a', 'b', 'c'], { remove: ['b'], add: ['d'] }), [
    'a',
    'c',
    'd',
  ]);
  assert.deepEqual(mergeIncrementalSelection(['a', 'b', 'c'], { remove: ['a', 'c'] }), ['b']);
  assert.deepEqual(mergeIncrementalSelection(['a', 'b'], { add: ['c', 'd'] }), [
    'a',
    'b',
    'c',
    'd',
  ]);
  assert.deepEqual(mergeIncrementalSelection(['a', 'b'], { add: ['b', 'c'] }), ['a', 'b', 'c']);
  // An explicitly empty enabled list replaces the base with nothing.
  assert.deepEqual(mergeIncrementalSelection(['a', 'b'], { enabled: [] }), []);
});

test('per-app override resolves through loadConfig exactly as 0.4 did', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["rule-a", "rule-b", "rule-c"]',
        '',
        '[applications.codex.rules]',
        'remove = ["rule-b"]',
        'add = ["rule-d"]',
      ].join('\n')
    );
    const config = loadConfig();
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), [
      'rule-a',
      'rule-b',
      'rule-c',
    ]);
    assert.deepEqual(effectiveSelection(config, 'codex', 'rules'), ['rule-a', 'rule-c', 'rule-d']);
  });
});

test('per-app enabled replaces the global selection completely', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "codex"]',
        '',
        '[rules]',
        'enabled = ["rule-a", "rule-b", "rule-c"]',
        '',
        '[applications.codex.rules]',
        'enabled = ["rule-x", "rule-y"]',
      ].join('\n')
    );
    const config = loadConfig();
    assert.deepEqual(effectiveSelection(config, 'codex', 'rules'), ['rule-x', 'rule-y']);
    assert.deepEqual(effectiveSelection(config, 'claude-code', 'rules'), [
      'rule-a',
      'rule-b',
      'rule-c',
    ]);
  });
});

test('a removed rule for one app changes only that app target bytes', async () => {
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
    const claudeBytes = fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8');
    const codexBytes = fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8');
    assert.match(claudeBytes, /Alpha body\./);
    assert.match(claudeBytes, /Beta body\./);
    assert.match(codexBytes, /Alpha body\./);
    assert.ok(!codexBytes.includes('Beta body.'), 'removed rule stays out of the codex render');

    const { slices } = await runExplain('codex');
    assert.deepEqual(
      slices[0].components.map((component) => component.id),
      ['alpha'],
      'explain lists the app effective components'
    );
  });
});

test('an emptied per-app selection plans removal for that app only', async () => {
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

    await runSync();
    const codexBytes = fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8');
    const claudeBytes = fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8');
    assert.match(codexBytes, /<!-- alpha:start -->/);
    assert.match(codexBytes, /<!-- alpha:end -->/);
    assert.ok(!claudeBytes.includes('<!-- alpha:start -->'));
    assert.notEqual(mdcWrap(''), codexBytes);
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
    const byApp = new Map(report.entries.map((entry) => [entry.app, entry]));
    assert.equal(byApp.get('claude-code')?.outcome, 'written', 'clean app still syncs');
    assert.equal(byApp.get('codex')?.outcome, 'failed');
    assert.equal(byApp.get('codex')?.detail, 'aggregate-blocked');
    assert.equal(fs.existsSync(ruleFilePath(homes, 'codex')), false);
    const missing = report.entries.find((entry) => entry.outcome === 'missing');
    assert.equal(missing?.id, 'ghost');
  });
});
