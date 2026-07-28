import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { AGENTS_SKILLS_UNION, APP_ROWS, appRow } from '../../src/engine/apps.js';
import { scanLibrary } from '../../src/engine/library.js';
import {
  bundleFingerprint,
  desiredTargetMode,
  executableBits,
  listBundleFiles,
  targetModeMatchesSourceExecutableBits,
} from '../../src/engine/shapes.js';
import { seedSkill, skillsParentDir, withScratchHomes } from './helpers/scratch.js';

// ---------------------------------------------------------------------------
// Library scan (ported 0.4.35 skills/library.ts semantics; failures contained
// per entry in 0.5 instead of aborting the run)
// ---------------------------------------------------------------------------

test('a skill directory with a valid SKILL.md scans into a component', async () => {
  await withScratchHomes(async (homes) => {
    const dir = seedSkill(homes, 'review-pr', {
      description: 'Review pull requests',
      body: 'Walk the diff.\n',
      files: { 'references/checklist.md': 'be kind\n' },
    });

    const inventory = scanLibrary({ types: ['skills'] });
    assert.equal(inventory.failed.length, 0);
    assert.equal(inventory.components.length, 1);
    const skill = inventory.components[0];
    assert.equal(skill.type, 'skills');
    assert.equal(skill.id, 'review-pr');
    assert.equal(skill.source, 'library');
    assert.equal(skill.path, dir, 'component path is the bundle directory, not SKILL.md');
    assert.equal(skill.metadata.name, 'review-pr');
    assert.equal(skill.metadata.description, 'Review pull requests');
    assert.match(skill.content, /Walk the diff\./);
  });
});

test('the directory name wins over the frontmatter name as the id', async () => {
  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'dir-name', { name: 'frontmatter-name' });

    const inventory = scanLibrary({ types: ['skills'] });
    assert.equal(inventory.components.length, 1);
    assert.equal(inventory.components[0].id, 'dir-name');
    assert.equal(inventory.components[0].metadata.name, 'frontmatter-name');
  });
});

test('dot-directories, SKILL.md-less directories, and plain files are skipped silently', async () => {
  await withScratchHomes(async (homes) => {
    const skillsRoot = path.join(homes.asbHome, 'skills');
    seedSkill(homes, '.hidden');
    fs.mkdirSync(path.join(skillsRoot, 'no-manifest'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'no-manifest', 'notes.md'), 'not a skill\n');
    fs.writeFileSync(path.join(skillsRoot, 'stray.md'), 'a file, not a bundle\n');

    const inventory = scanLibrary({ types: ['skills'] });
    assert.equal(inventory.components.length, 0);
    assert.equal(inventory.failed.length, 0);
  });
});

test('a malformed SKILL.md fails that entry only and keeps the frozen error strings', async () => {
  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'healthy');
    const badDir = path.join(homes.asbHome, 'skills', 'no-description');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, 'SKILL.md'),
      '---\nname: no-description\n---\nBody.\n',
      'utf-8'
    );
    const unterminatedDir = path.join(homes.asbHome, 'skills', 'unterminated');
    fs.mkdirSync(unterminatedDir, { recursive: true });
    fs.writeFileSync(path.join(unterminatedDir, 'SKILL.md'), '---\nname: x\nBody.\n', 'utf-8');

    const inventory = scanLibrary({ types: ['skills'] });
    assert.deepEqual(
      inventory.components.map((component) => component.id),
      ['healthy'],
      'healthy siblings still scan (0.4 aborted the whole run here)'
    );
    assert.equal(inventory.failed.length, 2);
    const byId = new Map(inventory.failed.map((failure) => [failure.id, failure]));

    const noDescription = byId.get('no-description');
    assert.ok(noDescription);
    assert.match(noDescription.error, /^Failed to parse skill "no-description": /);
    assert.match(noDescription.error, /description/);
    assert.equal(noDescription.path, path.join(badDir, 'SKILL.md'));

    const unterminated = byId.get('unterminated');
    assert.ok(unterminated);
    assert.equal(
      unterminated.error,
      'Failed to parse skill "unterminated": Skill frontmatter is missing a closing delimiter (---)'
    );
  });
});

test('a SKILL.md without frontmatter fails because name and description are required', async () => {
  await withScratchHomes(async (homes) => {
    const dir = path.join(homes.asbHome, 'skills', 'bare');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'Just a body, no frontmatter.\n', 'utf-8');

    const inventory = scanLibrary({ types: ['skills'] });
    assert.equal(inventory.components.length, 0);
    assert.equal(inventory.failed.length, 1);
    assert.match(inventory.failed[0].error, /^Failed to parse skill "bare": /);
  });
});

test('a BOM before the frontmatter is tolerated', async () => {
  await withScratchHomes(async (homes) => {
    const dir = path.join(homes.asbHome, 'skills', 'bom');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      '﻿---\nname: bom\ndescription: with BOM\n---\nBody.\n',
      'utf-8'
    );

    const inventory = scanLibrary({ types: ['skills'] });
    assert.equal(inventory.failed.length, 0);
    assert.equal(inventory.components[0]?.metadata.description, 'with BOM');
  });
});

test('scanLibrary scans rules and skills by default', async () => {
  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'a-skill');
    const rulesDir = path.join(homes.asbHome, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'a-rule.md'), 'Rule body.\n', 'utf-8');

    const inventory = scanLibrary();
    assert.deepEqual(
      inventory.components.map((component) => [component.type, component.id]),
      [
        ['rules', 'a-rule'],
        ['skills', 'a-skill'],
      ]
    );
  });
});

// ---------------------------------------------------------------------------
// Own-dir shape mechanics: source walk, tree fingerprint, mode repair
// ---------------------------------------------------------------------------

function seedTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

test('listBundleFiles walks recursively, skips dot entries and symlinks, keeps bytes and mode', async () => {
  await withScratchHomes(async (homes) => {
    const bundle = path.join(homes.root, 'bundle');
    seedTree(bundle, {
      'SKILL.md': '---\nname: x\ndescription: y\n---\n',
      'bin/run.sh': '#!/bin/sh\necho hi\n',
      'references/deep/guide.md': 'guide\n',
      '.hidden': 'skip me',
      'references/.dot-dir/inner.md': 'skip me too',
    });
    fs.chmodSync(path.join(bundle, 'bin/run.sh'), 0o755);
    fs.symlinkSync(path.join(bundle, 'SKILL.md'), path.join(bundle, 'link.md'));

    const files = listBundleFiles(bundle);
    assert.deepEqual(
      files.map((file) => file.rel),
      ['bin/run.sh', 'references/deep/guide.md', 'SKILL.md'],
      'per-level localeCompare order (0.4 fingerprint order); dot entries and symlinks skipped'
    );
    const script = files.find((file) => file.rel === 'bin/run.sh');
    assert.ok(script);
    assert.ok(Buffer.isBuffer(script.bytes));
    assert.equal(script.bytes.toString('utf-8'), '#!/bin/sh\necho hi\n');
    assert.notEqual(executableBits(script.mode), 0, 'source executable bit captured');
    const doc = files.find((file) => file.rel === 'SKILL.md');
    assert.equal(executableBits(doc?.mode ?? 0), 0);
  });
});

test('bundleFingerprint reproduces the 0.4 tree hash semantics', async () => {
  await withScratchHomes(async (homes) => {
    const a = path.join(homes.root, 'tree-a');
    const b = path.join(homes.root, 'tree-b');
    const files = { 'SKILL.md': 'same\n', 'nested/data.txt': 'payload\n' };
    seedTree(a, files);
    seedTree(b, files);

    const fingerprintA = bundleFingerprint(a);
    const fingerprintB = bundleFingerprint(b);
    assert.ok(fingerprintA?.startsWith('tree:'));
    assert.equal(fingerprintA, fingerprintB, 'identical trees hash identically');

    fs.writeFileSync(path.join(b, 'nested/data.txt'), 'payload!\n');
    assert.notEqual(bundleFingerprint(b), fingerprintA, 'byte changes change the hash');

    fs.writeFileSync(path.join(b, 'nested/data.txt'), 'payload\n');
    assert.equal(bundleFingerprint(b), fingerprintA);
    fs.chmodSync(path.join(b, 'SKILL.md'), 0o755);
    assert.notEqual(bundleFingerprint(b), fingerprintA, 'mode changes change the hash');
    fs.chmodSync(path.join(b, 'SKILL.md'), 0o644);

    // Target-side hashing has no dot-skip: a dropped-in dot file changes the tree.
    fs.writeFileSync(path.join(b, '.user-note'), 'mine');
    assert.notEqual(bundleFingerprint(b), fingerprintA);
    fs.rmSync(path.join(b, '.user-note'));

    fs.symlinkSync(path.join(b, 'SKILL.md'), path.join(b, 'alias.md'));
    assert.equal(bundleFingerprint(b), undefined, 'any symlink makes the tree unprovable');
    fs.rmSync(path.join(b, 'alias.md'));

    assert.equal(bundleFingerprint(path.join(homes.root, 'absent')), undefined);
    assert.equal(bundleFingerprint(path.join(a, 'SKILL.md')), undefined, 'file roots unprovable');
    const linkRoot = path.join(homes.root, 'link-root');
    fs.symlinkSync(a, linkRoot);
    assert.equal(bundleFingerprint(linkRoot), undefined, 'symlinked roots unprovable');
  });
});

test('mode helpers carry the frozen 0.4 repair semantics', () => {
  assert.equal(executableBits(0o755), 0o111);
  assert.equal(executableBits(0o644), 0);

  assert.equal(targetModeMatchesSourceExecutableBits(0o755, 0o755), true);
  assert.equal(targetModeMatchesSourceExecutableBits(0o755, 0o744), false);
  assert.equal(targetModeMatchesSourceExecutableBits(0o755, 0o644), false);
  assert.equal(targetModeMatchesSourceExecutableBits(0o644, 0o644), true);
  assert.equal(targetModeMatchesSourceExecutableBits(0o644, 0o600), true);
  assert.equal(targetModeMatchesSourceExecutableBits(0o644, 0o755), false);

  assert.equal(desiredTargetMode(0o755, 0o644), 0o755, 'executable source imposes its exact mode');
  assert.equal(desiredTargetMode(0o750, 0o644), 0o750);
  assert.equal(desiredTargetMode(0o644, 0o755), 0o644, 'non-executable source strips exec bits');
  assert.equal(desiredTargetMode(0o644, 0o600), 0o600, 'read/write bits of the target survive');
});

// ---------------------------------------------------------------------------
// App table: skills rows (frozen 0.4.35 paths) and the agents union row
// ---------------------------------------------------------------------------

test('the app table declares the frozen skills parent directories', async () => {
  await withScratchHomes(async (homes) => {
    const skillApps = [
      'claude-code',
      'codex',
      'gemini',
      'opencode',
      'cursor',
      'trae',
      'trae-cn',
    ] as const;
    for (const id of skillApps) {
      const row = appRow(id);
      assert.ok(row?.skills, `${id} carries a skills row`);
      assert.equal(row.skills.dir(homes), skillsParentDir(homes, id));
      const root = row.skills.root(homes);
      const relative = path.relative(root, row.skills.dir(homes));
      assert.ok(!relative.startsWith('..'), `${id} skills dir sits inside its containment root`);
    }
    assert.equal(appRow('claude-desktop')?.skills, undefined, 'claude-desktop is detect-only');
    assert.deepEqual(appRow('codex')?.skills?.reserved, ['.system']);
    assert.deepEqual(appRow('claude-code')?.skills?.reserved, []);
    const withSkills = APP_ROWS.filter((row) => row.skills).map((row) => row.id);
    assert.deepEqual(withSkills, [...skillApps]);
  });
});

test('the agents union row unions codex, gemini, and opencode at ~/.agents/skills', async () => {
  await withScratchHomes(async (homes) => {
    assert.deepEqual([...AGENTS_SKILLS_UNION.members], ['codex', 'gemini', 'opencode']);
    assert.equal(AGENTS_SKILLS_UNION.dir(homes), skillsParentDir(homes, 'agents'));
    assert.equal(AGENTS_SKILLS_UNION.root(homes), path.join(homes.agentsHome, '.agents'));
    assert.deepEqual([...AGENTS_SKILLS_UNION.reserved], ['.system']);
  });
});
