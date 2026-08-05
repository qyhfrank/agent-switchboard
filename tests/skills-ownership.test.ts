import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import { bundleFingerprint } from '../src/engine/shapes.js';
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
 * Ownership and removal for the own-dir shape. Ownership is derived from the
 * library rather than recorded: a selected skill is written until the bundle
 * mirrors its render, and a deselected one is removed either on that byte
 * proof or, failing it, on the weaker claim that a library id under a managed
 * skills parent is asb's layout.
 */

const LIBRARY_BODY = 'Walk the diff.\n';
const CHECKLIST = 'be kind\n';
const SCRIPT = '#!/bin/sh\necho hi\n';

/** A library skill with a nested doc and an executable, at <asbHome>/skills/<id>. */
function seedLibrarySkill(homes: ScratchHomes, id = 'review-pr'): string {
  const dir = seedSkill(homes, id, {
    description: 'Review pull requests',
    body: LIBRARY_BODY,
    files: { 'references/checklist.md': CHECKLIST, 'bin/run.sh': SCRIPT },
  });
  fs.chmodSync(path.join(dir, 'bin', 'run.sh'), 0o755);
  return dir;
}

function config(opts: {
  apps: readonly string[];
  skills: readonly string[];
  agentsDir?: boolean;
}): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  const lines = [
    '[applications]',
    `enabled = [${list(opts.apps)}]`,
    '',
    '[skills]',
    `enabled = [${list(opts.skills)}]`,
  ];
  if (opts.agentsDir !== undefined) {
    lines.push('', '[distribution]', `use_agents_dir = ${opts.agentsDir}`);
  }
  return `${lines.join('\n')}\n`;
}

function bundlePath(homes: ScratchHomes, app: RuleAppId | 'agents', id: string): string {
  return path.join(skillsParentDir(homes, app), id);
}

function skillEntry(report: Report, app: string, id: string) {
  return entryFor(report, { app, type: 'skills', id });
}

interface WalkedEntry {
  rel: string;
  full: string;
  dirent: fs.Dirent;
}

/** Every entry under `dir`, symlinks included and never followed. */
function walkTree(dir: string): WalkedEntry[] {
  const found: WalkedEntry[] = [];
  const visit = (current: string, prefix: string): void => {
    for (const dirent of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(current, dirent.name);
      found.push({ rel, full, dirent });
      // withFileTypes reports lstat kinds, so a symlink is never a directory.
      if (dirent.isDirectory()) visit(full, rel);
    }
  };
  visit(dir, '');
  return found;
}

/**
 * Content view of a tree for "nothing was touched" proofs. bundleFingerprint
 * refuses trees holding symlinks, so unprovable-bundle tests compare this.
 */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    walkTree(dir).map(({ rel, full, dirent }) => {
      if (dirent.isSymbolicLink()) return [rel, `link:${fs.readlinkSync(full)}`];
      if (dirent.isDirectory()) return [rel, 'dir'];
      return [rel, `file:${fs.readFileSync(full, 'utf-8')}`];
    })
  );
}

/** Per-file mtimes: identity adoption must not rewrite bytes it already agrees with. */
function mtimesOf(dir: string): Record<string, number> {
  return Object.fromEntries(
    walkTree(dir).map(({ rel, full }) => [rel, fs.lstatSync(full).mtimeMs])
  );
}

function read(...segments: string[]): string {
  return fs.readFileSync(path.join(...segments), 'utf-8');
}

test('a byte-identical bundle asb never recorded is left exactly as it is', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedLibrarySkill(homes);
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr'] }));

    // Hand-copied from the library: exact rel set, exact bytes, source modes.
    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    // A non-executable source only demands no exec bits, so the target keeping
    // its own read/write bits is still an identity match, not a deviation.
    fs.chmodSync(path.join(target, 'SKILL.md'), 0o600);

    const fingerprint = bundleFingerprint(target);
    assert.ok(fingerprint, 'the seeded target is a provable tree');
    const mtimes = mtimesOf(target);

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'unchanged');
    assert.equal(entry?.path, target);
    assert.equal(report.exitCode, 0);
    assert.equal(bundleFingerprint(target), fingerprint, 'the tree is unchanged');
    assert.deepEqual(mtimesOf(target), mtimes, 'no file was rewritten');

    // Identity is recomputed, not remembered, so the next run agrees too.
    const second = await runSync();
    assert.equal(skillEntry(second, 'claude-code', 'review-pr')?.outcome, 'unchanged');
    assert.deepEqual(mtimesOf(target), mtimes);
    assert.equal(second.exitCode, 0);
  });
});

test('a diverged bundle is brought to the render in one sync, mirroring the library', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr'] }));

    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.mkdirSync(path.join(target, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(target, 'SKILL.md'),
      '---\nname: review-pr\ndescription: an older copy\n---\nOld body.\n'
    );
    fs.writeFileSync(path.join(target, 'references', 'checklist.md'), 'stale\n');
    fs.writeFileSync(path.join(target, 'my-notes.md'), 'hand-written, not asb\n');
    fs.writeFileSync(path.join(target, 'references', 'mine.md'), 'also mine\n');

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(report.exitCode, 0);

    assert.match(read(target, 'SKILL.md'), /Walk the diff\./);
    assert.equal(read(target, 'references', 'checklist.md'), CHECKLIST);
    assert.equal(read(target, 'bin', 'run.sh'), SCRIPT);
    // A distributed bundle is a copy of its library directory, so files the
    // render does not name are cleared. That is what keeps the tree provably
    // asb's for a later deselection.
    assert.equal(fs.existsSync(path.join(target, 'my-notes.md')), false);
    assert.equal(fs.existsSync(path.join(target, 'references', 'mine.md')), false);

    const third = await runSync();
    assert.equal(skillEntry(third, 'claude-code', 'review-pr')?.outcome, 'unchanged');
    assert.equal(third.exitCode, 0);
  });
});

test('a name-matching bundle holding a symlink is left behind unproven and untouched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    seedLibrarySkill(homes, 'write-tests');
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr', 'write-tests'] }));

    const outside = path.join(homes.root, 'elsewhere.md');
    fs.writeFileSync(outside, 'somewhere else entirely\n');
    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.mkdirSync(path.join(target, 'references'), { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'not asb content\n');
    fs.symlinkSync(outside, path.join(target, 'references', 'alias.md'));
    const before = snapshot(target);

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'unproven');
    assert.equal(report.exitCode, 0, 'leaving an unprovable tree alone is not a failure');
    assert.deepEqual(snapshot(target), before, 'nothing inside an unprovable bundle is touched');
    assert.equal(bundleFingerprint(target), undefined, 'the tree is still unprovable');
    assert.equal(read(outside), 'somewhere else entirely\n', 'never written through the link');

    // Containment: one unprovable bundle never stops its siblings.
    assert.equal(skillEntry(report, 'claude-code', 'write-tests')?.outcome, 'written');
    assert.match(
      read(bundlePath(homes, 'claude-code', 'write-tests'), 'SKILL.md'),
      /Walk the diff/
    );
  });
});

test('deselecting a bundle that matches no render sweeps it as a stale copy', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedLibrarySkill(homes, 'hand-edited');
    seedLibrarySkill(homes, 'moved-on');
    writeUserConfig(homes, config({ apps: ['codex'], skills: ['hand-edited', 'moved-on'] }));

    await runSync();

    // Two routes to the same unprovable copy: the target drifts from the
    // render, or the library moves on and leaves the copy behind.
    fs.writeFileSync(
      path.join(bundlePath(homes, 'codex', 'hand-edited'), 'SKILL.md'),
      'hand-edited since asb wrote it\n'
    );
    fs.writeFileSync(
      path.join(homes.asbHome, 'skills', 'moved-on', 'SKILL.md'),
      '---\nname: moved-on\ndescription: moved on\n---\n\nRewritten upstream.\n'
    );
    writeUserConfig(homes, config({ apps: ['codex'], skills: [] }));

    const report = await runSync();

    assert.equal(report.exitCode, 0);
    for (const id of ['hand-edited', 'moved-on'] as const) {
      const entry = skillEntry(report, 'codex', id);
      assert.equal(entry?.outcome, 'removed', id);
      assert.equal(entry?.detail, 'stale-copy', id);
      assert.equal(fs.existsSync(bundlePath(homes, 'codex', id)), false);
    }

    // Nothing is left to report, so the run after it is silent about the ids.
    const third = await runSync();
    assert.equal(skillEntry(third, 'codex', 'hand-edited'), undefined);
    assert.equal(skillEntry(third, 'codex', 'moved-on'), undefined);
  });
});

test('deselecting an unmodified bundle removes it and leaves the others alone', async () => {
  await withScratchHomes(async (homes) => {
    const apps = ['claude-code', 'codex'] as const;
    installApps(homes, ...apps);
    seedLibrarySkill(homes);
    seedLibrarySkill(homes, 'keeper');
    writeUserConfig(homes, config({ apps, skills: ['review-pr', 'keeper'] }));

    await runSync();
    const kept = new Map(
      apps.map((app) => [app, snapshot(bundlePath(homes, app, 'keeper'))] as const)
    );

    writeUserConfig(homes, config({ apps, skills: ['keeper'] }));
    const report = await runSync();

    assert.equal(report.exitCode, 0);
    for (const app of apps) {
      const entry = skillEntry(report, app, 'review-pr');
      assert.equal(entry?.outcome, 'removed');
      assert.equal(entry?.detail, undefined, 'the bundle still matched its render, so no sweep');
      assert.equal(entry?.path, bundlePath(homes, app, 'review-pr'));
      assert.equal(fs.existsSync(bundlePath(homes, app, 'review-pr')), false);
      assert.equal(
        fs.existsSync(skillsParentDir(homes, app)),
        true,
        'the managed parent itself is never removed'
      );
      assert.equal(skillEntry(report, app, 'keeper')?.outcome, 'unchanged');
      assert.deepEqual(snapshot(bundlePath(homes, app, 'keeper')), kept.get(app));
    }

    const third = await runSync();
    assert.equal(skillEntry(third, 'claude-code', 'review-pr'), undefined);
    assert.equal(third.exitCode, 0);
  });
});

test('a bundle whose name matches no library skill is never reported or touched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr'] }));

    const foreign = bundlePath(homes, 'claude-code', 'my-own-skill');
    fs.mkdirSync(path.join(foreign, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(foreign, 'SKILL.md'),
      '---\nname: my-own-skill\ndescription: hand-made\n---\nMine alone.\n'
    );
    fs.writeFileSync(path.join(foreign, 'references', 'notes.md'), 'private\n');
    const before = snapshot(foreign);

    for (let run = 0; run < 3; run += 1) {
      const report = await runSync();
      assert.equal(
        report.entries.some((entry) => entry.id === 'my-own-skill' || entry.path === foreign),
        false,
        `run ${run}: an unrelated bundle produces no report entry at all`
      );
      assert.deepEqual(snapshot(foreign), before, `run ${run}: untouched`);
    }

    // Still nothing to say once the library skill is deselected as well.
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: [] }));
    const final = await runSync();
    assert.equal(
      final.entries.some((entry) => entry.path === foreign),
      false
    );
    assert.deepEqual(snapshot(foreign), before);
  });
});

test('an enabled skill with no library directory reports missing and blocks nothing else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr', 'ghost'] }));

    const report = await runSync();

    const missing = report.entries.find(
      (entry) => entry.id === 'ghost' && entry.outcome === 'missing'
    );
    assert.ok(missing, 'expected a missing entry for the absent skill');
    assert.equal(missing.type, 'skills');
    assert.equal(fs.existsSync(bundlePath(homes, 'claude-code', 'ghost')), false);

    // Per-bundle slices have no aggregate to block: healthy siblings deploy.
    assert.equal(skillEntry(report, 'claude-code', 'review-pr')?.outcome, 'written');
    assert.match(read(bundlePath(homes, 'claude-code', 'review-pr'), 'SKILL.md'), /Walk the diff/);
    assert.equal(report.exitCode, 1);
  });
});

test('a malformed library SKILL.md fails alone while healthy skills deploy', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    const badDir = path.join(homes.asbHome, 'skills', 'no-description');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: no-description\n---\nBody.\n');
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr'] }));

    const report = await runSync();

    const failure = report.entries.find(
      (entry) => entry.id === 'no-description' && entry.outcome === 'failed'
    );
    assert.ok(failure, 'expected a failed entry for the malformed skill');
    assert.equal(failure.detail, 'parse-error');
    assert.match(failure.reason ?? '', /description/);

    assert.equal(skillEntry(report, 'claude-code', 'review-pr')?.outcome, 'written');
    assert.equal(fs.existsSync(bundlePath(homes, 'claude-code', 'no-description')), false);
    assert.equal(report.exitCode, 1);

    // explain plans the same way, so it names the same parse failure.
    const { slices } = await runExplain('no-description');
    assert.equal(slices.length, 1);
    assert.equal(slices[0]?.app, null);
    assert.equal(slices[0]?.outcome, 'failed');
    assert.equal(slices[0]?.detail, 'parse-error');
    assert.match(slices[0]?.reason ?? '', /description/);
  });
});

test('a reserved child of a managed skills parent is never reported, claimed, or touched', async () => {
  const rows = [
    { app: 'codex' as const, agentsDir: false },
    { app: 'agents' as const, agentsDir: true },
  ];

  for (const row of rows) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'codex');
      seedLibrarySkill(homes);
      writeUserConfig(
        homes,
        config({ apps: ['codex'], skills: ['review-pr'], agentsDir: row.agentsDir })
      );

      const reserved = path.join(skillsParentDir(homes, row.app), '.system');
      fs.mkdirSync(path.join(reserved, 'cache'), { recursive: true });
      fs.writeFileSync(path.join(reserved, 'state.json'), '{"the app":"owns this"}\n');
      fs.writeFileSync(path.join(reserved, 'cache', 'index.bin'), 'binary-ish\n');
      const before = snapshot(reserved);
      const mtimes = mtimesOf(reserved);

      const report = await runSync();

      assert.equal(skillEntry(report, row.app, 'review-pr')?.outcome, 'written', row.app);
      assert.equal(
        report.entries.some((entry) => entry.id === '.system' || entry.path === reserved),
        false,
        'a reserved child is not a bundle and never reaches the report'
      );
      assert.deepEqual(snapshot(reserved), before);
      assert.deepEqual(mtimesOf(reserved), mtimes, 'not even rewritten with identical bytes');

      // Deselection walks the same parent and still stays out of the app's own dir.
      writeUserConfig(homes, config({ apps: ['codex'], skills: [], agentsDir: row.agentsDir }));
      const second = await runSync();
      assert.equal(
        second.entries.some((entry) => entry.path === reserved),
        false
      );
      assert.deepEqual(snapshot(reserved), before);
      assert.equal(fs.existsSync(bundlePath(homes, row.app, 'review-pr')), false, row.app);
    });
  }
});

test('explain joins a live bundle to its library source and follows it out of proof', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedSkill(homes, 'review-pr');
    writeUserConfig(homes, config({ apps: ['claude-code'], skills: ['review-pr'] }));
    await runSync();
    const target = bundlePath(homes, 'claude-code', 'review-pr');

    const { slices } = await runExplain('review-pr');

    assert.equal(slices.length, 1);
    const slice = slices[0];
    assert.equal(slice.app, 'claude-code');
    assert.equal(slice.path, target);
    assert.equal(slice.outcome, 'unchanged');
    assert.equal(slice.provenance, 'identity');
    assert.equal(slice.currentHash, bundleFingerprint(target));
    assert.deepEqual(
      slice.components.map((component) => component.id),
      ['review-pr']
    );
    assert.equal(slice.components[0]?.path, source);

    fs.writeFileSync(path.join(target, 'SKILL.md'), 'edited\n');

    const edited = (await runExplain('review-pr')).slices[0];

    assert.equal(edited?.outcome, 'written', 'the pending rewrite is named');
    assert.equal(edited?.currentHash, bundleFingerprint(target));
    assert.notEqual(edited?.currentHash, slice.currentHash, 'the edit moved the live tree');
    assert.equal(edited?.provenance, null, 'an edited tree stops being provably asb’s');
  });
});
