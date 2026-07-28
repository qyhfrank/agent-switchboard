import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import { bundleFingerprint } from '../../src/engine/shapes.js';
import {
  installApps,
  type RuleAppId,
  type ScratchHomes,
  seedSkill,
  skillsParentDir,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Ownership, adoption, and removal for the own-dir shape. 0.4 deleted any
 * child of the managed skills parent whose name matched a library skill; 0.5
 * deletes only what it can prove it wrote, adopts what it can prove is
 * identical, updates what convention grants, and leaves everything else
 * exactly as the user left it.
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

function configFor(apps: readonly string[], skills: readonly string[]): string {
  const appList = apps.map((id) => `"${id}"`).join(', ');
  const skillList = skills.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${appList}]\n\n[skills]\nenabled = [${skillList}]\n`;
}

function bundlePath(homes: ScratchHomes, app: RuleAppId, id: string): string {
  return path.join(skillsParentDir(homes, app), id);
}

function skillEntry(report: Report, app: string, id: string): ReportEntry | undefined {
  return report.entries.find(
    (entry) => entry.app === app && entry.type === 'skills' && entry.id === id
  );
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

// ---------------------------------------------------------------------------
// Adoption: identity and convention
// ---------------------------------------------------------------------------

test('a byte-identical unrecorded bundle is adopted by identity and never rewritten', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

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
    assert.equal(entry?.outcome, 'adopted');
    assert.equal(entry?.detail, 'identity');
    assert.equal(entry?.path, target);
    assert.equal(report.exitCode, 0);
    assert.equal(bundleFingerprint(target), fingerprint, 'the adopted tree is unchanged');
    assert.deepEqual(mtimesOf(target), mtimes, 'no file was rewritten');

    // Adoption records the target's own tree, so the next run agrees with it.
    const second = await runSync();
    assert.equal(skillEntry(second, 'claude-code', 'review-pr')?.outcome, 'unchanged');
    assert.deepEqual(mtimesOf(target), mtimes);
    assert.equal(second.exitCode, 0);
  });
});

test('an unrecorded plain bundle adopts by convention, then updates keeping foreign files', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.mkdirSync(path.join(target, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(target, 'SKILL.md'),
      '---\nname: review-pr\ndescription: an older copy\n---\nOld body.\n'
    );
    fs.writeFileSync(path.join(target, 'references', 'checklist.md'), 'stale\n');
    fs.writeFileSync(path.join(target, 'my-notes.md'), 'hand-written, not asb\n');
    fs.writeFileSync(path.join(target, 'references', 'mine.md'), 'also mine\n');

    const adoption = await runSync();
    const adopted = skillEntry(adoption, 'claude-code', 'review-pr');
    assert.equal(adopted?.outcome, 'adopted');
    assert.equal(adopted?.detail, 'convention');
    assert.match(read(target, 'SKILL.md'), /Old body\./, 'adoption writes nothing');
    assert.equal(adoption.exitCode, 0);

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'written');
    assert.equal(entry?.detail, 'updated');
    assert.equal(report.exitCode, 0);

    assert.match(read(target, 'SKILL.md'), /Walk the diff\./);
    assert.equal(read(target, 'references', 'checklist.md'), CHECKLIST);
    assert.equal(read(target, 'bin', 'run.sh'), SCRIPT);
    assert.equal(read(target, 'my-notes.md'), 'hand-written, not asb\n', 'foreign file preserved');
    assert.equal(read(target, 'references', 'mine.md'), 'also mine\n', 'nested foreign preserved');

    const third = await runSync();
    assert.equal(skillEntry(third, 'claude-code', 'review-pr')?.outcome, 'unchanged');
    assert.equal(third.exitCode, 0);
  });
});

test('deselecting between adoption and the first rewrite preserves the bundle', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'their own take on this skill\n');

    await runSync();
    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'unproven');
    assert.equal(
      read(target, 'SKILL.md'),
      'their own take on this skill\n',
      'a convention claim never deletes'
    );
  });
});

test('a name-matching bundle holding a symlink is left behind unproven and untouched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    seedLibrarySkill(homes, 'write-tests');
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr', 'write-tests']));

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
    assert.equal(report.exitCode, 1);
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

// ---------------------------------------------------------------------------
// Owned bundles the user edited
// ---------------------------------------------------------------------------

test('a user edit inside an owned bundle conflicts while the skill stays selected', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    const first = await runSync();
    assert.equal(skillEntry(first, 'claude-code', 'review-pr')?.outcome, 'written');
    assert.equal(skillEntry(first, 'claude-code', 'review-pr')?.detail, 'created');

    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.writeFileSync(path.join(target, 'references', 'checklist.md'), 'be exacting\n');

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'conflict');
    assert.equal(entry?.path, target);
    assert.equal(report.exitCode, 1);
    assert.equal(read(target, 'references', 'checklist.md'), 'be exacting\n', 'the edit survives');
    assert.match(read(target, 'SKILL.md'), /Walk the diff\./, 'no partial rewrite of the bundle');
  });
});

test('deselecting a user-modified bundle leaves it behind and drops the ownership record', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    await runSync();
    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'hand-edited since asb wrote it\n');
    writeUserConfig(homes, configFor(['claude-code'], []));

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'modified');
    assert.equal(report.exitCode, 1);
    assert.equal(read(target, 'SKILL.md'), 'hand-edited since asb wrote it\n');

    // The record goes with the report: a later run makes no claim on the dir.
    const third = await runSync();
    assert.equal(
      third.entries.some(
        (candidate) => candidate.path === target && candidate.outcome === 'removed'
      ),
      false,
      'a dropped record never authorizes a later deletion'
    );
    assert.equal(fs.existsSync(target), true);

    // Re-selecting meets a foreign dir: convention adoption first (writing
    // nothing), then the update — not a resurrected ledger claim reporting
    // `unchanged` over the user's bytes.
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));
    const fourth = await runSync();
    assert.equal(skillEntry(fourth, 'claude-code', 'review-pr')?.outcome, 'adopted');
    assert.equal(skillEntry(fourth, 'claude-code', 'review-pr')?.detail, 'convention');
    assert.equal(read(target, 'SKILL.md'), 'hand-edited since asb wrote it\n');

    const fifth = await runSync();
    assert.equal(skillEntry(fifth, 'claude-code', 'review-pr')?.outcome, 'written');
    assert.equal(skillEntry(fifth, 'claude-code', 'review-pr')?.detail, 'updated');
    assert.match(read(target, 'SKILL.md'), /Walk the diff\./);
  });
});

test('a foreign file dropped into an owned bundle stops deletion at deselection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    await runSync();
    const target = bundlePath(homes, 'claude-code', 'review-pr');
    fs.writeFileSync(path.join(target, 'notes.txt'), 'my own notes\n');
    writeUserConfig(homes, configFor(['claude-code'], []));

    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'left-behind');
    assert.equal(entry?.detail, 'modified');
    assert.equal(report.exitCode, 1);
    assert.equal(read(target, 'notes.txt'), 'my own notes\n', 'the added file survives');
    assert.match(read(target, 'SKILL.md'), /Walk the diff\./, 'nothing is partially pruned');
    assert.equal(read(target, 'references', 'checklist.md'), CHECKLIST);
  });
});

// ---------------------------------------------------------------------------
// Removal: only by deselection, only with proof
// ---------------------------------------------------------------------------

test('deselecting an unmodified recorded bundle removes it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

    await runSync();
    const target = bundlePath(homes, 'claude-code', 'review-pr');
    assert.equal(fs.existsSync(target), true);

    writeUserConfig(homes, configFor(['claude-code'], []));
    const report = await runSync();

    const entry = skillEntry(report, 'claude-code', 'review-pr');
    assert.equal(entry?.outcome, 'removed');
    assert.equal(entry?.path, target);
    assert.equal(report.exitCode, 0);
    assert.equal(fs.existsSync(target), false);
    assert.equal(
      fs.existsSync(skillsParentDir(homes, 'claude-code')),
      true,
      'the managed parent itself is never removed'
    );

    const third = await runSync();
    assert.equal(skillEntry(third, 'claude-code', 'review-pr'), undefined);
    assert.equal(third.exitCode, 0);
  });
});

test('a bundle whose name matches no library skill is never reported or touched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

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
    writeUserConfig(homes, configFor(['claude-code'], []));
    const final = await runSync();
    assert.equal(
      final.entries.some((entry) => entry.path === foreign),
      false
    );
    assert.deepEqual(snapshot(foreign), before);
  });
});

// ---------------------------------------------------------------------------
// Library-side failures and app-reserved names
// ---------------------------------------------------------------------------

test('an enabled skill with no library directory reports missing and blocks nothing else', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr', 'ghost']));

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
    fs.writeFileSync(
      path.join(badDir, 'SKILL.md'),
      '---\nname: no-description\n---\nBody.\n',
      'utf-8'
    );
    writeUserConfig(homes, configFor(['claude-code'], ['review-pr']));

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
  });
});

test('the codex .system directory is never reported, claimed, or touched', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedLibrarySkill(homes);
    writeUserConfig(homes, configFor(['codex'], ['review-pr']));

    const reserved = path.join(skillsParentDir(homes, 'codex'), '.system');
    fs.mkdirSync(path.join(reserved, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(reserved, 'state.json'), '{"codex":"owns this"}\n');
    fs.writeFileSync(path.join(reserved, 'cache', 'index.bin'), 'binary-ish\n');
    const before = snapshot(reserved);
    const mtimes = mtimesOf(reserved);

    const report = await runSync();

    assert.equal(skillEntry(report, 'codex', 'review-pr')?.outcome, 'written');
    assert.equal(
      report.entries.some((entry) => entry.id === '.system' || entry.path === reserved),
      false,
      'a reserved child is not a bundle and never reaches the report'
    );
    assert.deepEqual(snapshot(reserved), before);
    assert.deepEqual(mtimesOf(reserved), mtimes, 'not even rewritten with identical bytes');

    // Deselection walks the same parent and still stays out of the app's own dir.
    writeUserConfig(homes, configFor(['codex'], []));
    const second = await runSync();
    assert.equal(
      second.entries.some((entry) => entry.path === reserved),
      false
    );
    assert.deepEqual(snapshot(reserved), before);
    assert.equal(fs.existsSync(bundlePath(homes, 'codex', 'review-pr')), false);
  });
});
