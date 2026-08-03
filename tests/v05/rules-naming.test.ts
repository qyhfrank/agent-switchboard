import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP_ROWS } from '../../src/engine/apps.js';
import { runSync } from '../../src/engine/cli.js';
import { seedRule, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

const DEDICATED = [
  { app: 'cursor', dir: ['.cursor', 'rules'], file: 'rules.mdc' },
  { app: 'trae', dir: ['.trae', 'user_rules'], file: 'rules.md' },
  { app: 'trae-cn', dir: ['.trae-cn', 'user_rules'], file: 'rules.md' },
] as const;

test('no rules target asb writes carries the asb name in its path', () => {
  for (const row of APP_ROWS) {
    if (!row.rules) continue;
    const target = row.rules.path({
      agentsHome: '/home/u',
      asbHome: '/home/u/.asb',
      cacheHome: '/home/u/.cache/asb',
      stateHome: '/home/u/.local/state/asb',
    });
    assert.doesNotMatch(path.basename(target), /asb/i, `${row.id} global rules target`);
    const project = row.rules.projectPath?.('/repo');
    if (project) {
      assert.doesNotMatch(path.basename(project), /asb/i, `${row.id} project rules target`);
    }
  }
});

test('the dedicated rules filename is rules.mdc for cursor and rules.md for trae', () => {
  for (const { app, dir, file } of DEDICATED) {
    const row = APP_ROWS.find((candidate) => candidate.id === app);
    assert.ok(row?.rules, `${app} has a rules row`);
    assert.equal(
      row.rules.path({
        agentsHome: '/home/u',
        asbHome: '/home/u/.asb',
        cacheHome: '/home/u/.cache/asb',
        stateHome: '/home/u/.local/state/asb',
      }),
      path.join('/home/u', ...dir, file)
    );
  }
});

test('the rendered rules body names no product, only the rules themselves', () => {
  for (const row of APP_ROWS) {
    if (!row.rules) continue;
    const rendered = row.rules.render('# Shared rule\n', '/home/u/rules.md');
    assert.doesNotMatch(rendered, /asb/i, `${row.id} rendered rules`);
    assert.doesNotMatch(rendered, /agent switchboard/i, `${row.id} rendered rules`);
  }
});

test('a cursor sync writes ~/.cursor/rules/rules.mdc', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.cursor'), { recursive: true });
    seedRule(homes, 'base.md', 'Baseline rules.\n');
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[rules]\nenabled = ["base"]\n');
    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const target = path.join(homes.agentsHome, '.cursor', 'rules', 'rules.mdc');
    assert.ok(fs.existsSync(target), 'rules.mdc written');
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc')),
      false
    );
    assert.doesNotMatch(fs.readFileSync(target, 'utf-8'), /asb|agent switchboard/i);
  });
});
