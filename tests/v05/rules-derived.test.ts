import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  installApps,
  renderedRules,
  ruleFilePath,
  rulesRegion,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

const COMPOSED = 'Baseline rules.\n';

function configFor(apps: readonly string[], rules: readonly string[]): string {
  return `[applications]\nenabled = [${apps.map((id) => `"${id}"`).join(', ')}]\n\n[rules]\nenabled = [${rules.map((id) => `"${id}"`).join(', ')}]\n`;
}

function rulesEntry(report: Report, app: string): ReportEntry | undefined {
  return report.entries.find((entry) => entry.app === app && entry.type === 'rules');
}

test('an occupied shared host keeps its own bytes and gains a marked region', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code'], ['base']));

    const target = ruleFilePath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '# My own notes\n', 'utf-8');

    const report = await runSync();
    const entry = rulesEntry(report, 'claude-code');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      `${rulesRegion(COMPOSED)}\n# My own notes\n`,
      'one run, and the user keeps every byte they wrote'
    );
    assert.equal(report.exitCode, 0);
    assert.equal(
      report.entries.some((row) => row.outcome === 'adopted'),
      false,
      'adoption is gone from the vocabulary'
    );

    const second = await runSync();
    assert.equal(rulesEntry(second, 'claude-code')?.outcome, 'unchanged');
  });
});

test('a target that already holds the render reports unchanged without an ownership record', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], ['base']));

    for (const app of ['claude-code', 'cursor'] as const) {
      const target = ruleFilePath(homes, app);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderedRules(app, COMPOSED), 'utf-8');
    }

    const report = await runSync();
    for (const app of ['claude-code', 'cursor'] as const) {
      assert.equal(rulesEntry(report, app)?.outcome, 'unchanged', app);
    }
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
    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'written');
    assert.equal(
      fs.readFileSync(target, 'utf-8'),
      rulesRegion('Alpha body\n'),
      'the old composition is replaced, not pushed below a second copy'
    );
    assert.equal(report.exitCode, 0);
  });
});

test('deselecting takes the region and leaves everything the user wrote', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code', 'cursor'], ['base']));
    await runSync();

    const shared = ruleFilePath(homes, 'claude-code');
    fs.writeFileSync(shared, `${fs.readFileSync(shared, 'utf-8')}\n# My own notes\n`, 'utf-8');

    writeUserConfig(homes, configFor(['claude-code', 'cursor'], []));
    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    assert.equal(fs.readFileSync(shared, 'utf-8'), '# My own notes\n');

    const dedicated = ruleFilePath(homes, 'cursor');
    assert.equal(rulesEntry(report, 'cursor')?.outcome, 'removed');
    assert.equal(fs.existsSync(dedicated), false, 'the name asb chose is asb to sweep');
    assert.equal(report.exitCode, 0);

    // Silence afterwards: neither file has anything of asb's left in it.
    const later = await runSync();
    assert.equal(rulesEntry(later, 'cursor'), undefined);
    assert.equal(rulesEntry(later, 'claude-code'), undefined);
    assert.equal(later.exitCode, 0);
  });
});

test('a shared host holding only the region is removed when rules are deselected', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code'], ['base']));
    await runSync();

    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    assert.equal(fs.existsSync(ruleFilePath(homes, 'claude-code')), false);
    assert.equal(report.exitCode, 0);
  });
});

test('an edited region is still removed on deselect, and the bytes outside it survive', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code'], ['base']));
    await runSync();

    const target = ruleFilePath(homes, 'claude-code');
    fs.writeFileSync(
      target,
      `# Above\n\n${rulesRegion('Baseline rules.\n\nEdited by hand\n')}\n# Below\n`,
      'utf-8'
    );

    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    assert.equal(rulesEntry(report, 'claude-code')?.outcome, 'removed');
    // The markers bound exactly what goes; the blank lines around them were
    // the user's bytes and stay the user's bytes.
    assert.equal(fs.readFileSync(target, 'utf-8'), '# Above\n\n\n\n# Below\n');
    assert.equal(report.exitCode, 0);
  });
});

test('an asb-rules file an earlier version wrote is swept beside the new one', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['cursor'], ['base']));

    const rulesDir = path.join(homes.agentsHome, '.cursor', 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const legacy = path.join(rulesDir, 'asb-rules.mdc');
    fs.writeFileSync(legacy, renderedRules('cursor', 'Older composed output\n'), 'utf-8');

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(legacy), false, 'the previous filename is swept');
    assert.equal(
      fs.readFileSync(path.join(rulesDir, 'rules.mdc'), 'utf-8'),
      renderedRules('cursor', COMPOSED)
    );

    const later = await runSync();
    assert.equal(
      later.entries.some((row) => row.path === legacy),
      false,
      'nothing to say once it is gone'
    );
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
    assert.equal(rulesEntry(report, 'claude-code'), undefined);
    assert.equal(fs.readFileSync(target, 'utf-8'), 'Notes asb never wrote\n');
    assert.equal(report.exitCode, 0);
  });
});

test('one malformed marker pair conflicts on its own row and the run continues', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    seedRule(homes, 'base.md', COMPOSED);
    writeUserConfig(homes, configFor(['claude-code', 'codex'], ['base']));

    // Half a region: a truncated file, or a hand edit that took the closing
    // delimiter with it. Reading it is what raises, and the raise belongs to
    // this host, not to the run.
    const broken = ruleFilePath(homes, 'claude-code');
    const kept = '# Notes\n\n<!-- rules:start -->\nHalf a region.\n';
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, kept, 'utf-8');

    const report = await runSync();

    const row = rulesEntry(report, 'claude-code');
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
