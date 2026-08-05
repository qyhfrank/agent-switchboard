import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP_ROWS, appRow } from '../src/engine/apps.js';
import { scanLibrary } from '../src/engine/library.js';
import { bundleFingerprint, executableBits, listBundleFiles } from '../src/engine/shapes.js';
import { seedSkill, seedTree, withScratchHomes } from './helpers/scratch.js';

/**
 * The library side of the skills cell: what a bundle directory has to look
 * like to become a component, how a broken one fails without taking the run
 * with it, and the two tree primitives (source walk, tree hash) every bundle
 * write and ownership proof is built on.
 */

/** Write a raw SKILL.md under <asbHome>/skills/<id>/, bypassing the seeder's grammar. */
function seedRawSkill(asbHome: string, id: string, doc: string): string {
  const dir = path.join(asbHome, 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), doc, 'utf-8');
  return dir;
}

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
    seedSkill(homes, '.hidden');
    seedTree(path.join(homes.asbHome, 'skills'), {
      'no-manifest/notes.md': 'not a skill\n',
      'stray.md': 'a file, not a bundle\n',
    });

    const inventory = scanLibrary({ types: ['skills'] });

    assert.equal(inventory.components.length, 0);
    assert.equal(inventory.failed.length, 0);
  });
});

test('a malformed SKILL.md fails that entry alone and carries its id, path and reason', async () => {
  const rows = [
    {
      id: 'no-description',
      doc: '---\nname: no-description\n---\nBody.\n',
      reason: /description/,
    },
    {
      id: 'unterminated',
      doc: '---\nname: x\nBody.\n',
      error:
        'Failed to parse skill "unterminated": Skill frontmatter is missing a closing delimiter (---)',
    },
    {
      id: 'sequence-frontmatter',
      doc: '---\n- not\n- an\n- object\n---\nBody.\n',
      error:
        'Failed to parse skill "sequence-frontmatter": Failed to parse skill frontmatter: Skill frontmatter must evaluate to an object',
    },
    { id: 'no-frontmatter', doc: 'Just a body, no frontmatter.\n' },
  ] as const;

  await withScratchHomes(async (homes) => {
    seedSkill(homes, 'healthy');
    const dirs = new Map(
      rows.map((row) => [row.id, seedRawSkill(homes.asbHome, row.id, row.doc)] as const)
    );

    const inventory = scanLibrary({ types: ['skills'] });

    assert.deepEqual(
      inventory.components.map((component) => component.id),
      ['healthy'],
      'a broken bundle never stops its healthy siblings from scanning'
    );
    assert.equal(inventory.failed.length, rows.length);
    const byId = new Map(inventory.failed.map((failure) => [failure.id, failure]));
    for (const row of rows) {
      const failure = byId.get(row.id);
      assert.ok(failure, `expected a failed entry for ${row.id}`);
      assert.equal(failure.type, 'skills');
      assert.equal(failure.path, path.join(dirs.get(row.id) ?? '', 'SKILL.md'));
      assert.match(failure.error, new RegExp(`^Failed to parse skill "${row.id}": `));
      if ('error' in row) assert.equal(failure.error, row.error);
      if ('reason' in row) assert.match(failure.error, row.reason);
    }
  });
});

test('a BOM before the frontmatter is tolerated', async () => {
  await withScratchHomes(async (homes) => {
    seedRawSkill(homes.asbHome, 'bom', '﻿---\nname: bom\ndescription: with BOM\n---\nBody.\n');

    const inventory = scanLibrary({ types: ['skills'] });

    assert.equal(inventory.failed.length, 0);
    assert.equal(inventory.components[0]?.metadata.description, 'with BOM');
  });
});

test('listBundleFiles walks recursively, skips dot entries and symlinks, keeps bytes and mode', async () => {
  await withScratchHomes(async (homes) => {
    const bundle = seedTree(path.join(homes.root, 'bundle'), {
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
      'per-level name order; dot entries and symlinks never leave the library'
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

test('bundleFingerprint covers paths, bytes and modes and refuses unprovable roots', async () => {
  await withScratchHomes(async (homes) => {
    const files = { 'SKILL.md': 'same\n', 'nested/data.txt': 'payload\n' };
    const a = seedTree(path.join(homes.root, 'tree-a'), files);
    const b = seedTree(path.join(homes.root, 'tree-b'), files);

    const fingerprint = bundleFingerprint(a);
    assert.ok(fingerprint?.startsWith('tree:'));
    assert.equal(bundleFingerprint(b), fingerprint, 'identical trees hash identically');

    fs.writeFileSync(path.join(b, 'nested/data.txt'), 'payload!\n');
    assert.notEqual(bundleFingerprint(b), fingerprint, 'byte changes change the hash');
    fs.writeFileSync(path.join(b, 'nested/data.txt'), 'payload\n');
    assert.equal(bundleFingerprint(b), fingerprint);

    fs.chmodSync(path.join(b, 'SKILL.md'), 0o755);
    assert.notEqual(bundleFingerprint(b), fingerprint, 'mode changes change the hash');
    fs.chmodSync(path.join(b, 'SKILL.md'), 0o644);

    // Target-side hashing has no dot-skip: a dropped-in dot file changes the tree.
    fs.writeFileSync(path.join(b, '.user-note'), 'mine');
    assert.notEqual(bundleFingerprint(b), fingerprint);
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

test('each skills-carrying app declares its parent directory inside its containment root', async () => {
  await withScratchHomes(async (homes) => {
    const home = homes.agentsHome;
    const expected = {
      'claude-code': path.join(home, '.claude', 'skills'),
      codex: path.join(home, '.codex', 'skills'),
      gemini: path.join(home, '.gemini', 'skills'),
      opencode: path.join(home, '.config', 'opencode', 'skills'),
      cursor: path.join(home, '.cursor', 'skills'),
      trae: path.join(home, '.trae', 'skills'),
      'trae-cn': path.join(home, '.trae-cn', 'skills'),
    } as const;

    for (const [id, dir] of Object.entries(expected)) {
      const row = appRow(id);
      assert.ok(row?.skills, `${id} carries a skills row`);
      assert.equal(row.skills.dir(homes), dir);
      const relative = path.relative(row.skills.root(homes), dir);
      assert.ok(!relative.startsWith('..'), `${id} skills dir sits inside its containment root`);
    }
    assert.deepEqual(
      APP_ROWS.filter((row) => row.skills).map((row) => row.id),
      Object.keys(expected),
      'no other app receives skill bundles'
    );
    assert.equal(appRow('claude-desktop')?.skills, undefined, 'claude-desktop is detect-only');
    assert.deepEqual(appRow('codex')?.skills?.reserved, ['.system']);
    assert.deepEqual(appRow('claude-code')?.skills?.reserved, []);
  });
});
