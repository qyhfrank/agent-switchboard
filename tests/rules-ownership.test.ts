import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import {
  entryFor,
  installApps,
  renderedRules,
  ruleFilePath,
  rulesRegion,
  type ScratchHomes,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const COMPOSED = 'Baseline rules.\n';

function configFor(apps: readonly string[], rules: readonly string[]): string {
  const appList = apps.map((id) => `"${id}"`).join(', ');
  const ruleList = rules.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${appList}]\n\n[rules]\nenabled = [${ruleList}]\n`;
}

function seedBase(homes: ScratchHomes, apps: readonly string[]): void {
  seedRule(homes, 'base.md', COMPOSED);
  writeUserConfig(homes, configFor(apps, ['base']));
}

test('an occupied shared host keeps its own bytes and gains a marked region', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedBase(homes, ['claude-code']);

    const target = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# My own notes\n', 'utf-8');

    const report = await runSync();
    const entry = entryFor(report, { app: 'claude-code', type: 'rules' });
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      `${rulesRegion(COMPOSED)}\n# My own notes\n`,
      'one run, and the user keeps every byte they wrote'
    );
    assert.equal(report.exitCode, 0);

    const second = await runSync();
    assert.equal(entryFor(second, { app: 'claude-code', type: 'rules' })?.outcome, 'unchanged');
  });
});

test('deselecting takes the region and leaves everything the user wrote', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex', 'cursor'] as const;
    installApps(homes, ...apps);
    seedBase(homes, apps);
    await runSync();

    // A hand edit outside the region in one of the shared hosts.
    const shared = ruleFilePath(homes, 'claude-code');
    fs.writeFileSync(shared, `${fs.readFileSync(shared, 'utf-8')}\n# My own notes\n`, 'utf-8');

    writeUserConfig(homes, configFor(apps, []));
    const report = await runSync();

    for (const app of apps) {
      assert.equal(entryFor(report, { app, type: 'rules' })?.outcome, 'removed', app);
    }
    assert.equal(fs.readFileSync(shared, 'utf-8'), '# My own notes\n');
    assert.equal(
      fs.existsSync(ruleFilePath(homes, 'codex')),
      false,
      'a host holding nothing but the region goes with it'
    );
    assert.equal(
      fs.existsSync(ruleFilePath(homes, 'cursor')),
      false,
      'the name asb chose is asb to sweep'
    );
    assert.equal(report.exitCode, 0);

    // Silence afterwards: no file has anything of asb's left in it.
    const later = await runSync();
    for (const app of apps) assert.equal(entryFor(later, { app, type: 'rules' }), undefined, app);
    assert.equal(later.exitCode, 0);
  });
});

test('a hand-written file at a shared rules path is untouched while rules are off', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code'], []));

    const target = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'Notes asb never wrote\n', 'utf-8');

    const report = await runSync();

    assert.equal(entryFor(report, { app: 'claude-code', type: 'rules' }), undefined);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'Notes asb never wrote\n');
    assert.equal(report.exitCode, 0);
  });
});

test('a whole-file rules target an earlier version wrote gains markers without duplicating', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'alpha.md', 'Alpha body\n');
    seedRule(homes, 'beta.md', 'Beta body\n');
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    // The unmarked whole-file composition a previous version left behind,
    // holding a rule that is no longer selected.
    const target = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'Alpha body\n\nBeta body\n', 'utf-8');

    const report = await runSync();

    assert.equal(entryFor(report, { app: 'claude-code', type: 'rules' })?.outcome, 'written');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      rulesRegion('Alpha body\n'),
      'the old composition is replaced, not pushed below a second copy'
    );
    assert.equal(report.exitCode, 0);
  });
});

test('an edited region is still removed on deselect, and the bytes outside it survive', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedBase(homes, ['claude-code']);
    await runSync();

    const target = ruleFilePath(homes, 'claude-code');
    fs.writeFileSync(
      target,
      `# Above\n\n${rulesRegion('Baseline rules.\n\nEdited by hand\n')}\n# Below\n`,
      'utf-8'
    );

    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    assert.equal(entryFor(report, { app: 'claude-code', type: 'rules' })?.outcome, 'removed');
    // The markers bound exactly what goes; the blank lines around them were
    // the user's bytes and stay the user's bytes.
    assert.equal(fs.readFileSync(target, 'utf-8'), '# Above\n\n\n\n# Below\n');
    assert.equal(report.exitCode, 0);
  });
});

test('a retired dedicated filename is swept while the current one is written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedBase(homes, ['cursor']);

    const rulesDir = path.join(homes.agentsHome, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const retired = path.join(rulesDir, 'asb-rules.mdc');
    fs.writeFileSync(retired, renderedRules('cursor', 'Older composed output\n'), 'utf-8');

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(retired), false, 'the previous filename is swept');
    assert.equal(
      fs.readFileSync(path.join(rulesDir, 'rules.mdc'), 'utf-8'),
      renderedRules('cursor', COMPOSED)
    );

    const later = await runSync();
    assert.equal(
      later.entries.some((row) => row.path === retired),
      false,
      'nothing to say once it is gone'
    );
  });
});

test('one malformed marker pair conflicts on its own row and the run continues', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedBase(homes, apps);

    // Half a region: a truncated file, or a hand edit that took the closing
    // delimiter with it. Reading it is what raises, and the raise belongs to
    // this host, not to the run.
    const broken = ruleFilePath(homes, 'claude-code');
    const kept = '# Notes\n\n<!-- rules:start -->\nHalf a region.\n';
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, kept, 'utf-8');

    const report = await runSync();

    const row = entryFor(report, { app: 'claude-code', type: 'rules' });
    assert.equal(row?.outcome, 'conflict', JSON.stringify(report.entries, null, 2));
    assert.equal(row?.detail, 'malformed-marker');
    assert.equal(fs.readFileSync(broken, 'utf-8'), kept, 'the host is left exactly as it was');
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8'),
      renderedRules('codex', COMPOSED),
      'and the app beside it still gets its rules'
    );
  });
});
