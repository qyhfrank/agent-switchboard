import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  entryFor,
  installApps,
  type RuleAppId,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Writing the own-dir shape: a distributed bundle is a byte-for-byte copy of
 * its library directory, kept that way on every run — content, modes, and the
 * absence of files the library no longer names.
 */

const GUIDE = 'Consult the guide before answering.\n';
const REVISED_GUIDE = 'Consult the revised guide before answering.\n';
const SCRIPT = '#!/bin/sh\necho ok\n';

function bundlePath(homes: ScratchHomes, app: RuleAppId, id: string): string {
  return path.join(skillsParentDir(homes, app), id);
}

function config(apps: readonly string[], skills: readonly string[]): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${list(apps)}]\n\n[skills]\nenabled = [${list(skills)}]\n`;
}

function skillsEntry(report: Report, app: string, id: string) {
  return entryFor(report, { app, type: 'skills', id });
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
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE } });
    writeUserConfig(homes, config(apps, ['alpha']));

    const report = await runSync();

    for (const app of apps) {
      const entry = skillsEntry(report, app, 'alpha');
      assert.ok(entry, `expected a skills entry for ${app}`);
      assert.equal(entry.outcome, 'written');
      assert.equal(entry.detail, 'created');
      assert.equal(entry.path, bundlePath(homes, app, 'alpha'));
      assert.deepEqual(treeOf(bundlePath(homes, app, 'alpha')), treeOf(source));
    }
    assert.equal(report.exitCode, 0);
  });
});

test('a re-sync with an untouched library leaves every bundle unchanged', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE } });
    writeUserConfig(homes, config(apps, ['alpha']));

    await runSync();
    const before = new Map(
      apps.map((app) => [app, treeOf(bundlePath(homes, app, 'alpha'))] as const)
    );

    const second = await runSync();

    for (const app of apps) {
      assert.equal(skillsEntry(second, app, 'alpha')?.outcome, 'unchanged');
      assert.deepEqual(treeOf(bundlePath(homes, app, 'alpha')), before.get(app));
    }
    assert.equal(second.exitCode, 0);
  });
});

test('a changed source file updates the bundle', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE } });
    writeUserConfig(homes, config(apps, ['alpha']));

    await runSync();
    fs.writeFileSync(path.join(source, 'references', 'guide.md'), REVISED_GUIDE, 'utf-8');

    const second = await runSync();

    for (const app of apps) {
      const entry = skillsEntry(second, app, 'alpha');
      assert.equal(entry?.outcome, 'written');
      assert.equal(entry?.detail, 'updated');
      const target = bundlePath(homes, app, 'alpha');
      assert.equal(
        fs.readFileSync(path.join(target, 'references', 'guide.md'), 'utf-8'),
        REVISED_GUIDE
      );
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
    writeUserConfig(homes, config(['claude-code'], ['alpha']));

    const first = await runSync();

    const targetScript = path.join(bundlePath(homes, 'claude-code', 'alpha'), 'scripts', 'run.sh');
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

test('a non-executable source strips exec bits from the target and keeps its rw bits', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'alpha', { files: { 'scripts/run.sh': SCRIPT } });
    writeUserConfig(homes, config(['claude-code'], ['alpha']));

    await runSync();
    const targetScript = path.join(bundlePath(homes, 'claude-code', 'alpha'), 'scripts', 'run.sh');
    assert.equal(modeOf(targetScript) & 0o111, 0, 'a plain source never lands executable');

    // A non-executable source demands no exec bits and nothing more, so the
    // target's own read/write bits are not drift.
    fs.chmodSync(targetScript, 0o600);
    const tightened = await runSync();
    assert.equal(skillsEntry(tightened, 'claude-code', 'alpha')?.outcome, 'unchanged');
    assert.equal(modeOf(targetScript), 0o600);

    fs.chmodSync(targetScript, 0o755);
    const repaired = await runSync();

    const entry = skillsEntry(repaired, 'claude-code', 'alpha');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(modeOf(targetScript), 0o644, 'the repair keeps the target rw bits, minus exec');
    assert.equal(
      fs.readFileSync(path.join(source, 'scripts', 'run.sh'), 'utf-8'),
      SCRIPT,
      'the library source is never the write target'
    );
    assert.equal(repaired.exitCode, 0);
  });
});

test('a file dropped from the source is deleted and its emptied dir pruned', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE } });
    writeUserConfig(homes, config(['claude-code'], ['alpha']));

    await runSync();
    const target = bundlePath(homes, 'claude-code', 'alpha');
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

test('a dry run reports the bundle actions the real run performs and writes nothing', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedSkill(homes, 'alpha', { files: { 'references/guide.md': GUIDE } });
    seedSkill(homes, 'beta');
    writeUserConfig(homes, config(apps, ['alpha', 'beta']));

    const shape = (report: Report) =>
      report.entries
        .filter((entry) => entry.type === 'skills')
        .map((entry) => ({
          app: entry.app,
          id: entry.id,
          path: entry.path,
          outcome: entry.outcome,
          detail: entry.detail,
        }))
        .sort((a, b) => `${a.app}/${a.id}`.localeCompare(`${b.app}/${b.id}`));

    const dryCreate = await runSync({ dryRun: true });

    for (const app of apps) {
      for (const id of ['alpha', 'beta'] as const) {
        assert.equal(fs.existsSync(bundlePath(homes, app, id)), false, 'a dry run writes nothing');
        const entry = skillsEntry(dryCreate, app, id);
        assert.equal(entry?.outcome, 'written');
        assert.equal(entry?.detail, 'created');
      }
    }
    assert.equal(shape(dryCreate).length, apps.length * 2, 'one entry per app and skill');
    assert.equal(dryCreate.exitCode, 0);

    assert.deepEqual(shape(dryCreate), shape(await runSync()));

    // A hand-edited bundle is named as the rewrite it will get, and the drifted
    // bytes are still there afterwards.
    const drifted = path.join(bundlePath(homes, 'claude-code', 'alpha'), 'references', 'guide.md');
    fs.writeFileSync(drifted, 'drifted by hand\n');

    const dryDrift = await runSync({ dryRun: true });

    const entry = skillsEntry(dryDrift, 'claude-code', 'alpha');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(entry?.path, bundlePath(homes, 'claude-code', 'alpha'));
    assert.equal(skillsEntry(dryDrift, 'codex', 'alpha')?.outcome, 'unchanged');
    assert.equal(dryDrift.exitCode, 0, 'a rewrite the library will do is not a failure');
    assert.equal(fs.readFileSync(drifted, 'utf-8'), 'drifted by hand\n');

    assert.deepEqual(shape(dryDrift), shape(await runSync()));
    assert.equal(fs.readFileSync(drifted, 'utf-8'), GUIDE, 'the real run performs the rewrite');
  });
});

test('a stale file that cannot be deleted is left behind and the next run finishes it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    const source = seedSkill(homes, 'alpha', { files: { 'old.txt': 'old\n' } });
    writeUserConfig(homes, config(['codex'], ['alpha']));

    const first = await runSync();
    const bundle = skillsEntry(first, 'codex', 'alpha')?.path;
    assert.ok(bundle);
    fs.unlinkSync(path.join(source, 'old.txt'));

    const staleTarget = path.join(bundle, 'old.txt');
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (path.resolve(String(target)) === staleTarget) throw new Error('simulated busy file');
      return originalUnlink(target);
    }) as typeof fs.unlinkSync;
    let report: Report;
    try {
      report = await runSync();
    } finally {
      fs.unlinkSync = originalUnlink;
    }

    const entry = skillsEntry(report, 'codex', 'alpha');
    assert.equal(entry?.outcome, 'left-behind', JSON.stringify(report.entries, null, 2));
    assert.equal(entry?.detail, 'remove-failed');
    assert.ok(fs.existsSync(staleTarget));

    // The bundle is asb's because the library renders it, so nothing about the
    // failure has to be remembered: the next run takes the file again.
    const retry = await runSync();
    assert.equal(retry.exitCode, 0, JSON.stringify(retry.entries, null, 2));
    assert.equal(fs.existsSync(staleTarget), false);
  });
});

test('two apps sharing a project skills directory plan one physical writer', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'trae', 'trae-cn');
    seedSkill(homes, 'shared');
    writeUserConfig(homes, '[applications]\nenabled = ["trae", "trae-cn"]\n');
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\ncollision = "warn-skip"\n\n[skills]\nenabled = ["shared"]\n'
    );

    const report = await runSync({ project });

    const target = path.join(project, '.trae', 'skills', 'shared');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.existsSync(path.join(target, 'SKILL.md')), true);
    assert.equal(report.entries.filter((entry) => entry.path === target).length, 1);
  });
});
