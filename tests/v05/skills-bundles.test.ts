import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  detectDir,
  installApps,
  type RuleAppId,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Ported 0.4.35 acceptance: the bundle write mechanics from
 * tests/codex-skills.test.ts and tests/trae-skills.test.ts — byte-for-byte
 * copy, executable bit fidelity, stale-file cleanup, removal — expressed
 * against the one 0.5 reconciliation (`runSync`).
 */

const GUIDE_V1 = 'Consult the guide before answering.\n';
const GUIDE_V2 = 'Consult the revised guide before answering.\n';
const SCRIPT = '#!/bin/sh\necho ok\n';

function bundleDir(homes: ScratchHomes, app: RuleAppId, id: string): string {
  return path.join(skillsParentDir(homes, app), id);
}

function configFor(apps: readonly string[], skills: readonly string[], extraTables = ''): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  const base = `[applications]\nenabled = [${list(apps)}]\n\n[skills]\nenabled = [${list(skills)}]\n`;
  return extraTables ? `${base}\n${extraTables}\n` : base;
}

function skillsEntries(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'skills');
}

function skillsEntry(report: Report, app: string, id: string): ReportEntry | undefined {
  return report.entries.find(
    (entry) => entry.type === 'skills' && entry.app === app && entry.id === id
  );
}

/** Every file under `dir`, keyed by its posix-relative path. */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(current, item.name);
      if (item.isDirectory()) walk(full, rel);
      else out[rel] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(dir, '');
  return out;
}

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

test('first sync copies the library bundle byte-for-byte to every installed app', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex', 'opencode'] as const;
    installApps(homes, ...apps);
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(homes, configFor(apps, ['alpha']));

    const report = await runSync();

    for (const app of apps) {
      const entry = skillsEntry(report, app, 'alpha');
      assert.ok(entry, `expected a skills entry for ${app}`);
      assert.equal(entry.outcome, 'written');
      assert.equal(entry.detail, 'created');
      assert.equal(entry.path, bundleDir(homes, app, 'alpha'));
      assert.deepEqual(treeOf(bundleDir(homes, app, 'alpha')), treeOf(source));
    }
    assert.equal(report.exitCode, 0);
  });
});

test('a re-sync with an untouched library leaves every bundle unchanged', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(homes, configFor(apps, ['alpha']));

    await runSync();
    const before = new Map(
      apps.map((app) => [app, treeOf(bundleDir(homes, app, 'alpha'))] as const)
    );

    const second = await runSync();

    for (const app of apps) {
      assert.equal(skillsEntry(second, app, 'alpha')?.outcome, 'unchanged');
      assert.deepEqual(treeOf(bundleDir(homes, app, 'alpha')), before.get(app));
    }
    assert.equal(second.exitCode, 0);
  });
});

test('a changed source file updates the bundle', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(homes, configFor(apps, ['alpha']));

    await runSync();
    fs.writeFileSync(path.join(source, 'references', 'guide.md'), GUIDE_V2, 'utf-8');

    const second = await runSync();

    for (const app of apps) {
      const entry = skillsEntry(second, app, 'alpha');
      assert.equal(entry?.outcome, 'written');
      assert.equal(entry?.detail, 'updated');
      const target = bundleDir(homes, app, 'alpha');
      assert.equal(fs.readFileSync(path.join(target, 'references', 'guide.md'), 'utf-8'), GUIDE_V2);
      assert.deepEqual(treeOf(target), treeOf(source));
    }
    assert.equal(second.exitCode, 0);
  });
});

test('an executable source keeps its mode and target mode drift is repaired', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'alpha', { files: { 'scripts/run.sh': SCRIPT } });
    const sourceScript = path.join(source, 'scripts', 'run.sh');
    fs.chmodSync(sourceScript, 0o755);
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    const first = await runSync();
    const targetScript = path.join(bundleDir(homes, 'claude-code', 'alpha'), 'scripts', 'run.sh');
    assert.equal(skillsEntry(first, 'claude-code', 'alpha')?.outcome, 'written');
    assert.equal(modeOf(targetScript), 0o755);
    assert.equal(modeOf(targetScript), modeOf(sourceScript));

    fs.chmodSync(targetScript, 0o644);
    const second = await runSync();

    const entry = skillsEntry(second, 'claude-code', 'alpha');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(modeOf(targetScript), 0o755);
    assert.equal(
      fs.readFileSync(targetScript, 'utf-8'),
      SCRIPT,
      'content is untouched by a repair'
    );
    assert.equal(second.exitCode, 0);
  });
});

test('a non-executable source strips exec bits that appeared on the target', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'alpha', { files: { 'scripts/run.sh': SCRIPT } });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    await runSync();
    const targetScript = path.join(bundleDir(homes, 'claude-code', 'alpha'), 'scripts', 'run.sh');
    assert.equal(modeOf(targetScript) & 0o111, 0, 'a plain source never lands executable');

    fs.chmodSync(targetScript, 0o755);
    const second = await runSync();

    const entry = skillsEntry(second, 'claude-code', 'alpha');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(modeOf(targetScript) & 0o111, 0);
    // Frozen 0.4 repair rule: currentMode & 0o666, not the source mode.
    assert.equal(modeOf(targetScript), 0o644);
    assert.equal(
      fs.readFileSync(path.join(source, 'scripts', 'run.sh'), 'utf-8'),
      SCRIPT,
      'the library source is never the write target'
    );
    assert.equal(second.exitCode, 0);
  });
});

test('a file dropped from the source is deleted and its emptied dir pruned', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));

    await runSync();
    const target = bundleDir(homes, 'claude-code', 'alpha');
    assert.equal(fs.existsSync(path.join(target, 'references', 'guide.md')), true);

    fs.rmSync(path.join(source, 'references', 'guide.md'));
    const second = await runSync();

    const entry = skillsEntry(second, 'claude-code', 'alpha');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(fs.existsSync(path.join(target, 'references', 'guide.md')), false);
    assert.equal(fs.existsSync(path.join(target, 'references')), false, 'emptied dir is pruned');
    assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
    assert.deepEqual(treeOf(target), treeOf(source));
    assert.equal(second.exitCode, 0);
  });
});

test('deselecting a skill removes its bundle and leaves the others alone', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    seedSkill(homes, 'beta');
    writeUserConfig(homes, configFor(apps, ['alpha', 'beta']));

    await runSync();
    const before = new Map(
      apps.map((app) => [app, treeOf(bundleDir(homes, app, 'alpha'))] as const)
    );
    writeUserConfig(homes, configFor(apps, ['alpha']));

    const second = await runSync();

    for (const app of apps) {
      const removed = skillsEntry(second, app, 'beta');
      assert.equal(removed?.outcome, 'removed');
      assert.equal(removed?.path, bundleDir(homes, app, 'beta'));
      assert.equal(fs.existsSync(bundleDir(homes, app, 'beta')), false);
      assert.equal(skillsEntry(second, app, 'alpha')?.outcome, 'unchanged');
      assert.deepEqual(treeOf(bundleDir(homes, app, 'alpha')), before.get(app));
    }
    assert.equal(second.exitCode, 0);
  });
});

test('dry-run reports the same bundle actions the real run performs and writes nothing', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    seedSkill(homes, 'beta');
    writeUserConfig(homes, configFor(apps, ['alpha', 'beta']));

    const dry = await runSync({ dryRun: true });

    for (const app of apps) {
      assert.equal(fs.existsSync(bundleDir(homes, app, 'alpha')), false);
      assert.equal(fs.existsSync(bundleDir(homes, app, 'beta')), false);
    }
    assert.equal(dry.exitCode, 0);
    assert.equal(skillsEntries(dry).length, apps.length * 2, 'one entry per app and skill');
    for (const app of apps) {
      for (const id of ['alpha', 'beta'] as const) {
        const entry = skillsEntry(dry, app, id);
        assert.equal(entry?.outcome, 'written');
        assert.equal(entry?.detail, 'created');
      }
    }

    const real = await runSync();

    const shape = (report: Report) =>
      skillsEntries(report)
        .map((entry) => ({
          app: entry.app,
          id: entry.id,
          path: entry.path,
          outcome: entry.outcome,
          detail: entry.detail,
        }))
        .sort((a, b) => `${a.app}/${a.id}`.localeCompare(`${b.app}/${b.id}`));
    assert.deepEqual(shape(dry), shape(real));
  });
});

test('an enabled app that is not installed is skipped and the installed apps are written', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(homes, configFor(['claude-code', 'codex'], ['alpha']));

    const report = await runSync();

    assert.equal(skillsEntry(report, 'claude-code', 'alpha')?.outcome, 'written');
    const skipped = report.entries.find(
      (entry) => entry.app === 'codex' && entry.outcome === 'skipped'
    );
    assert.ok(skipped, 'expected the app-level skipped entry for the undetected app');
    assert.equal(skipped.detail, 'app-not-installed');
    assert.equal(
      report.entries.some((entry) => entry.app === 'codex' && entry.type === 'skills'),
      false,
      'no skills slice is planned for an undetected app'
    );
    assert.equal(fs.existsSync(detectDir(homes, 'codex')), false, 'the app root is never created');
    assert.equal(fs.existsSync(bundleDir(homes, 'codex', 'alpha')), false);
    assert.equal(report.exitCode, 0);
  });
});

test('a per-app skills override keeps one bundle out of that app only', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha');
    const beta = seedSkill(homes, 'beta', { files: { 'references/guide.md': GUIDE_V1 } });
    writeUserConfig(
      homes,
      configFor(apps, ['alpha', 'beta'], '[applications.codex.skills]\nremove = ["beta"]')
    );

    const report = await runSync();

    assert.equal(skillsEntry(report, 'claude-code', 'beta')?.outcome, 'written');
    assert.deepEqual(treeOf(bundleDir(homes, 'claude-code', 'beta')), treeOf(beta));
    assert.equal(skillsEntry(report, 'codex', 'alpha')?.outcome, 'written');
    assert.equal(fs.existsSync(bundleDir(homes, 'codex', 'beta')), false);
    const codexBeta = report.entries.find(
      (entry) => entry.app === 'codex' && entry.id === 'beta' && entry.outcome === 'written'
    );
    assert.equal(codexBeta, undefined, 'the removed skill is never written for that app');
    assert.equal(report.exitCode, 0);
  });
});

test('two selected skills each get their own bundle and report entry', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const alpha = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE_V1 } });
    const beta = seedSkill(homes, 'beta', { files: { 'scripts/run.sh': SCRIPT } });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    const report = await runSync();

    assert.deepEqual(
      skillsEntries(report)
        .map((entry) => entry.id)
        .sort(),
      ['alpha', 'beta']
    );
    for (const [id, source] of [
      ['alpha', alpha],
      ['beta', beta],
    ] as const) {
      const entry = skillsEntry(report, 'claude-code', id);
      assert.equal(entry?.outcome, 'written');
      assert.equal(entry?.detail, 'created');
      assert.deepEqual(treeOf(bundleDir(homes, 'claude-code', id)), treeOf(source));
    }
    assert.equal(report.exitCode, 0);
  });
});
