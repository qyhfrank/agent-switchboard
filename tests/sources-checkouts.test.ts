import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type Homes, loadConfig } from '../src/engine/config.js';
import {
  addRemoteSource,
  ensureSourcesReady,
  managedSourceDir,
  pluginsDir,
  removeSource,
  resolveSources,
  updateSources,
} from '../src/engine/sources.js';
import {
  commitAndPush,
  createGitFixture,
  type GitFixture,
  gitFixtureCommand as git,
  withScratchHomes,
  writeFixtureFile,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Managed checkout ownership: provenance verification, readiness, migration
 * from the pre-cache location, dual-location ambiguity, and the subtree
 * lifecycle. This is the block that decides whether asb may delete a
 * directory, so every clause is carried.
 */

/** A bare remote carrying one rules file, plus the work clone that authors it. */
function seedRemote(root: string): GitFixture {
  const fixture = createGitFixture(root, 'remote');
  writeFixtureFile(fixture, 'rules/base.md', '# Base');
  commitAndPush(fixture, 'seed');
  return fixture;
}

/** Publish one more commit upstream. */
function advanceRemote(fixture: GitFixture): void {
  writeFixtureFile(fixture, 'rules/next.md', '# Next');
  commitAndPush(fixture, 'advance');
}

function initAsbAsGitRepo(asbHome: string): void {
  git(['init', '--initial-branch=main'], asbHome);
  git(['config', 'user.name', 'test'], asbHome);
  git(['config', 'user.email', 'test@test.com'], asbHome);
  fs.writeFileSync(path.join(asbHome, 'config.toml'), '');
  git(['add', 'config.toml'], asbHome);
  git(['commit', '-m', 'init'], asbHome);
}

function commitIfDirty(repoDir: string, message: string): void {
  git(['add', '-A'], repoDir);
  if (git(['status', '--porcelain'], repoDir).length === 0) return;
  git(['commit', '-m', message], repoDir);
}

/** Move a managed clone back to the pre-cache location. */
function demoteToLegacyLayout(homes: Homes, namespace: string): string {
  const cacheDir = managedSourceDir(homes, namespace);
  const legacyDir = path.join(pluginsDir(homes), namespace);
  fs.mkdirSync(path.dirname(legacyDir), { recursive: true });
  fs.renameSync(cacheDir, legacyDir);
  return legacyDir;
}

function sourcePathOf(namespace: string): string | undefined {
  return resolveSources(loadConfig()).sources.find((s) => s.namespace === namespace)?.path;
}

function sourceErrorOf(namespace: string): string | undefined {
  return resolveSources(loadConfig()).failed.find((f) => f.namespace === namespace)?.error;
}

// ── Clone lifecycle ───────────────────────────────────────────────────────

test('a remote source clones into the cache and persists its declaration', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);

    addRemoteSource(loadConfig(), 'test-remote', { url: bareRepo, type: 'clone' });

    const cacheDir = managedSourceDir(loadConfig().homes, 'test-remote');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'base.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
    assert.equal(sourcePathOf('test-remote'), cacheDir);
    const source = resolveSources(loadConfig()).sources.find((s) => s.namespace === 'test-remote');
    assert.equal(source?.remote?.url, bareRepo);
  });
});

test('clone errors redact URL query and fragment credentials', async () => {
  await withScratchHomes(async () => {
    assert.throws(
      () =>
        addRemoteSource(loadConfig(), 'secret-source', {
          url: 'http://127.0.0.1:1/repo.git?access_token=query-secret#fragment-secret',
          type: 'clone',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /query-secret|fragment-secret/);
        return true;
      }
    );
  });
});

test('a name collision preserves an existing auto-discovered plugin', async () => {
  await withScratchHomes(async (scratch) => {
    const config = loadConfig();
    const existing = path.join(pluginsDir(config.homes), 'existing');
    fs.mkdirSync(existing, { recursive: true });
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'keep');
    const bareRepo = path.join(scratch.root, 'remote.git');
    git(['init', '--bare', '--initial-branch=main', bareRepo]);

    assert.throws(
      () => addRemoteSource(config, 'existing', { url: bareRepo, type: 'clone' }),
      /already exists/
    );
    assert.equal(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf-8'), 'keep');
  });
});

test('removing a source deletes its managed clone', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    addRemoteSource(loadConfig(), 'cleanup-test', { url: bareRepo, type: 'clone' });
    const cacheDir = managedSourceDir(loadConfig().homes, 'cleanup-test');

    removeSource(loadConfig(), 'cleanup-test');

    assert.equal(sourcePathOf('cleanup-test'), undefined);
    assert.equal(fs.existsSync(cacheDir), false);
  });
});

test('removing a source preserves a modified managed clone', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    addRemoteSource(loadConfig(), 'modified-clone', { url: bareRepo, type: 'clone' });
    const cloneDir = managedSourceDir(loadConfig().homes, 'modified-clone');
    const userFile = path.join(cloneDir, 'keep.txt');
    fs.writeFileSync(userFile, 'keep me\n');

    assert.throws(() => removeSource(loadConfig(), 'modified-clone'), /unverified or modified/);

    assert.equal(sourcePathOf('modified-clone'), cloneDir);
    assert.equal(fs.readFileSync(userFile, 'utf-8'), 'keep me\n');
  });
});

test('an update rejects mismatched provenance without fetching', async () => {
  for (const mismatch of ['marker', 'origin', 'ref', 'branch', 'tag'] as const) {
    await withScratchHomes(async (scratch) => {
      const fixture = seedRemote(scratch.root);
      const namespace = `guarded-${mismatch}`;
      addRemoteSource(loadConfig(), namespace, { url: fixture.bareRepo, type: 'clone' });
      const cloneDir = managedSourceDir(loadConfig().homes, namespace);

      advanceRemote(fixture);

      const markerPath = path.join(cloneDir, '.git', 'asb-source.json');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
      if (mismatch === 'origin') {
        git(['remote', 'set-url', 'origin', path.join(scratch.root, 'foreign.git')], cloneDir);
      } else if (mismatch === 'marker' || mismatch === 'ref') {
        const changed =
          mismatch === 'marker' ? { ...marker, namespace: 'foreign' } : { ...marker, ref: 'other' };
        fs.writeFileSync(markerPath, `${JSON.stringify(changed)}\n`);
      } else {
        git([mismatch, 'user-local'], cloneDir);
      }

      const beforeMarker = fs.readFileSync(markerPath, 'utf-8');
      const revsBefore = ['HEAD', 'refs/remotes/origin/main'].map((ref) =>
        git(['rev-parse', ref], cloneDir)
      );
      const objectsBefore = git(['count-objects', '-v'], cloneDir);

      const [result] = updateSources(loadConfig());

      assert.equal(result?.status, 'error');
      assert.match(result?.error ?? '', /unverified or modified/);
      assert.equal(fs.readFileSync(markerPath, 'utf-8'), beforeMarker);
      assert.deepEqual(
        ['HEAD', 'refs/remotes/origin/main'].map((ref) => git(['rev-parse', ref], cloneDir)),
        revsBefore
      );
      assert.equal(git(['count-objects', '-v'], cloneDir), objectsBefore);
      assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'next.md')), false);
    });
  }
});

test('a managed clone adopts and repeatedly updates a force-moved detached tag', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo, workDir } = seedRemote(scratch.root);
    git(['tag', 'pinned'], workDir);
    git(['push', 'origin', 'pinned'], workDir);

    addRemoteSource(loadConfig(), 'tagged-clone', { url: bareRepo, type: 'clone', ref: 'pinned' });
    const cloneDir = managedSourceDir(loadConfig().homes, 'tagged-clone');
    // Drop the marker: the identity path for markerless clones must still
    // recognize the checkout as ours.
    fs.rmSync(path.join(cloneDir, '.git', 'asb-source.json'));

    git(['checkout', '--orphan', 'replacement'], workDir);
    git(['rm', '-rf', '.'], workDir);
    fs.writeFileSync(path.join(workDir, 'replacement.md'), 'replacement\n');
    git(['add', '.'], workDir);
    git(['commit', '-m', 'replacement'], workDir);
    git(['tag', '--force', 'pinned'], workDir);
    git(['push', '--force', 'origin', 'refs/tags/pinned'], workDir);

    for (let attempt = 0; attempt < 2; attempt++) {
      const [result] = updateSources(loadConfig(), { only: ['tagged-clone'] });
      assert.equal(result?.status, 'updated', result?.error);
    }
    assert.equal(fs.existsSync(path.join(cloneDir, 'replacement.md')), true);

    removeSource(loadConfig(), 'tagged-clone');
    assert.equal(fs.existsSync(cloneDir), false);
    assert.equal(sourcePathOf('tagged-clone'), undefined);
  });
});

test('removal preserves local history, ignored files, and index tricks', async () => {
  for (const localChange of ['commit', 'reflog', 'ignored', 'hidden-index'] as const) {
    await withScratchHomes(async (scratch) => {
      const { bareRepo } = seedRemote(scratch.root);
      const namespace = `preserve-${localChange}`;
      addRemoteSource(loadConfig(), namespace, { url: bareRepo, type: 'clone' });
      const cloneDir = managedSourceDir(loadConfig().homes, namespace);
      const localFile =
        localChange === 'hidden-index'
          ? path.join(cloneDir, 'rules', 'base.md')
          : path.join(cloneDir, `${localChange}.txt`);

      fs.writeFileSync(localFile, `${localChange}\n`);
      if (localChange === 'commit' || localChange === 'reflog') {
        const managedHead = git(['rev-parse', 'HEAD'], cloneDir);
        git(['add', '.'], cloneDir);
        git(
          ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'local'],
          cloneDir
        );
        if (localChange === 'reflog') git(['reset', '--hard', managedHead], cloneDir);
      } else if (localChange === 'ignored') {
        fs.writeFileSync(path.join(cloneDir, '.git', 'info', 'exclude'), 'ignored.txt\n');
      } else {
        git(['update-index', '--assume-unchanged', 'rules/base.md'], cloneDir);
      }

      assert.throws(() => removeSource(loadConfig(), namespace), /unverified or modified/);
      // The reflog case resets the worktree back, so only the repository's own
      // history carries the local change; the others keep their file.
      if (localChange !== 'reflog') {
        assert.equal(fs.readFileSync(localFile, 'utf-8'), `${localChange}\n`);
      }
      assert.equal(sourcePathOf(namespace), cloneDir);
    });
  }
});

test('a symlinked clone root or git dir is never treated as ours', async () => {
  for (const linked of ['clone', 'git'] as const) {
    await withScratchHomes(async (scratch) => {
      const fixture = seedRemote(scratch.root);
      addRemoteSource(loadConfig(), 'linked', { url: fixture.bareRepo, type: 'clone' });
      const cloneDir = managedSourceDir(loadConfig().homes, 'linked');
      const moved = path.join(scratch.root, `external-${linked}`);
      const link = linked === 'clone' ? cloneDir : path.join(cloneDir, '.git');
      fs.renameSync(link, moved);
      fs.symlinkSync(moved, link);
      const markerPath = path.join(cloneDir, '.git', 'asb-source.json');
      const markerBefore = fs.readFileSync(markerPath, 'utf-8');

      advanceRemote(fixture);

      const [result] = updateSources(loadConfig(), { only: ['linked'] });

      assert.equal(result?.status, 'error');
      assert.equal(fs.readFileSync(markerPath, 'utf-8'), markerBefore);
      assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'next.md')), false);
      assert.throws(() => removeSource(loadConfig(), 'linked'));
      assert.equal(fs.existsSync(moved), true);
    });
  }
});

test('an update fast-forwards a clean clone and re-markers it', async () => {
  await withScratchHomes(async (scratch) => {
    const fixture = seedRemote(scratch.root);
    addRemoteSource(loadConfig(), 'ff-clone', { url: fixture.bareRepo, type: 'clone' });
    const cloneDir = managedSourceDir(loadConfig().homes, 'ff-clone');

    advanceRemote(fixture);

    const [result] = updateSources(loadConfig());

    assert.equal(result?.status, 'updated', result?.error);
    assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'next.md')), true);
    const marker = JSON.parse(
      fs.readFileSync(path.join(cloneDir, '.git', 'asb-source.json'), 'utf-8')
    ) as { commit: string };
    assert.equal(marker.commit, git(['rev-parse', 'HEAD'], cloneDir));
  });
});

// ── Readiness ─────────────────────────────────────────────────────────────

test('readiness materializes a configured clone once and never refreshes it', async () => {
  await withScratchHomes(async (scratch) => {
    const fixture = seedRemote(scratch.root);
    writeUserConfig(
      scratch,
      ['[plugins.sources]', `ready-ns = { url = "${fixture.bareRepo}", type = "clone" }`].join('\n')
    );

    const first = ensureSourcesReady(loadConfig());
    assert.deepEqual(
      first.map((row) => [row.namespace, row.status, row.action]),
      [['ready-ns', 'ready', 'clone']]
    );
    const cloneDir = managedSourceDir(loadConfig().homes, 'ready-ns');
    assert.ok(fs.existsSync(path.join(cloneDir, 'rules', 'base.md')));

    advanceRemote(fixture);

    // Ready means present, not current: readiness never fetches again.
    assert.deepEqual(ensureSourcesReady(loadConfig()), []);
    assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'next.md')), false);
  });
});

test('one broken source does not block the healthy ones', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'broken-ns = { url = "http://127.0.0.1:1/missing.git", type = "clone" }',
        `healthy-ns = { url = "${bareRepo}", type = "clone" }`,
      ].join('\n')
    );

    const rows = ensureSourcesReady(loadConfig());

    assert.equal(rows.find((row) => row.namespace === 'broken-ns')?.status, 'error');
    assert.equal(rows.find((row) => row.namespace === 'healthy-ns')?.status, 'ready');
    assert.ok(
      fs.existsSync(
        path.join(managedSourceDir(loadConfig().homes, 'healthy-ns'), 'rules', 'base.md')
      )
    );
  });
});

test('a namespace that escapes the cache root never reaches a clone or a refresh', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    const escaped = path.join(scratch.root, 'escaped-source');
    writeUserConfig(
      scratch,
      ['[plugins.sources]', `"../escaped-source" = { url = "${bareRepo}", type = "clone" }`].join(
        '\n'
      )
    );

    // The namespace fails alone at read time and contributes no source.
    assert.match(sourceErrorOf('../escaped-source') ?? '', /Invalid namespace/);
    assert.deepEqual(resolveSources(loadConfig()).sources, []);

    const readiness = ensureSourcesReady(loadConfig());
    assert.deepEqual(
      readiness.map((row) => [row.namespace, row.status]),
      [['../escaped-source', 'error']]
    );
    assert.match(readiness[0]?.error ?? '', /Invalid namespace/);
    assert.equal(fs.existsSync(escaped), false, 'nothing was created outside the cache root');

    const updates = updateSources(loadConfig());
    assert.deepEqual(
      updates.map((row) => [row.namespace, row.status]),
      [['../escaped-source', 'error']]
    );
    assert.equal(fs.existsSync(escaped), false);
  });
});

test('readiness re-clones when the cache directory went missing, and skips local sources', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    const localDir = path.join(scratch.root, 'local-src');
    fs.mkdirSync(localDir, { recursive: true });
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        `reclone-ns = { url = "${bareRepo}", type = "clone" }`,
        `local-ns = "${localDir}"`,
      ].join('\n')
    );
    ensureSourcesReady(loadConfig());
    const cloneDir = managedSourceDir(loadConfig().homes, 'reclone-ns');
    fs.rmSync(cloneDir, { recursive: true, force: true });

    const rows = ensureSourcesReady(loadConfig());

    assert.deepEqual(
      rows.map((row) => [row.namespace, row.action]),
      [['reclone-ns', 'clone']]
    );
    assert.ok(fs.existsSync(path.join(cloneDir, 'rules', 'base.md')));
  });
});

// ── Migration from the pre-cache location ─────────────────────────────────

test('a verified legacy checkout migrates into the cache without fetching', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);
    addRemoteSource(loadConfig(), 'migrating', { url: bareRepo, type: 'clone' });
    const homes = loadConfig().homes;
    const legacyDir = demoteToLegacyLayout(homes, 'migrating');
    const headBefore = git(['rev-parse', 'HEAD'], legacyDir);

    const rows = ensureSourcesReady(loadConfig());

    assert.deepEqual(
      rows.map((row) => [row.namespace, row.status, row.action]),
      [['migrating', 'ready', 'migrate']]
    );
    const cacheDir = managedSourceDir(homes, 'migrating');
    assert.equal(fs.existsSync(legacyDir), false);
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'base.md')));
    // Migration carries the generation already on disk; it does not fetch.
    assert.equal(git(['rev-parse', 'HEAD'], cacheDir), headBefore);
  });
});

test('a modified, unverifiable, markerless, or user-owned legacy directory is preserved', async () => {
  for (const kind of ['modified', 'unverifiable', 'markerless', 'user-owned'] as const) {
    await withScratchHomes(async (scratch) => {
      const { bareRepo } = seedRemote(scratch.root);
      const namespace = `legacy-${kind}`;
      let legacyDir: string;

      if (kind === 'user-owned') {
        writeUserConfig(
          scratch,
          ['[plugins.sources]', `${namespace} = { url = "${bareRepo}", type = "clone" }`].join('\n')
        );
        legacyDir = path.join(pluginsDir(loadConfig().homes), namespace);
        fs.mkdirSync(path.join(legacyDir, 'rules'), { recursive: true });
        fs.writeFileSync(path.join(legacyDir, 'rules', 'mine.md'), '# Mine');
      } else {
        addRemoteSource(loadConfig(), namespace, { url: bareRepo, type: 'clone' });
        legacyDir = demoteToLegacyLayout(loadConfig().homes, namespace);
        const markerPath = path.join(legacyDir, '.git', 'asb-source.json');
        if (kind === 'modified') fs.writeFileSync(path.join(legacyDir, 'keep.txt'), 'keep me\n');
        else if (kind === 'markerless') fs.rmSync(markerPath);
        else {
          const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Record<
            string,
            unknown
          >;
          fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, namespace: 'foreign' })}\n`);
        }
      }

      const [row] = ensureSourcesReady(loadConfig());

      assert.equal(row?.status, 'error');
      assert.match(row?.error ?? '', /unverified or modified/);
      assert.equal(fs.existsSync(managedSourceDir(loadConfig().homes, namespace)), false);
      assert.equal(fs.existsSync(legacyDir), true);
      if (kind === 'modified') {
        assert.equal(fs.readFileSync(path.join(legacyDir, 'keep.txt'), 'utf-8'), 'keep me\n');
      }
      if (kind === 'user-owned') {
        assert.equal(fs.readFileSync(path.join(legacyDir, 'rules', 'mine.md'), 'utf-8'), '# Mine');
        assert.throws(() => removeSource(loadConfig(), namespace), /unverified or modified/);
        assert.equal(fs.readFileSync(path.join(legacyDir, 'rules', 'mine.md'), 'utf-8'), '# Mine');
      }
    });
  }
});

test('a namespace occupied in two locations fails on read, not only on mutation', async () => {
  for (const occupancy of ['legacy-directory', 'subtree-declaration'] as const) {
    await withScratchHomes(async (scratch) => {
      const { bareRepo } = seedRemote(scratch.root);
      if (occupancy === 'subtree-declaration') initAsbAsGitRepo(scratch.asbHome);
      addRemoteSource(loadConfig(), 'occupied', { url: bareRepo, type: 'clone' });
      const homes = loadConfig().homes;
      const cacheDir = managedSourceDir(homes, 'occupied');
      const userFile = path.join(pluginsDir(homes), 'occupied', 'user-file.md');

      if (occupancy === 'legacy-directory') {
        fs.mkdirSync(path.dirname(userFile), { recursive: true });
        fs.writeFileSync(userFile, '# mine\n');
      } else {
        writeUserConfig(
          scratch,
          [
            '[plugins.sources.occupied]',
            `url = "${bareRepo}"`,
            'type = "subtree"',
            'ref = "main"',
          ].join('\n')
        );
      }

      assert.match(sourceErrorOf('occupied') ?? '', /managed cache/);
      assert.throws(() => removeSource(loadConfig(), 'occupied'), /managed cache/);

      assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
      if (occupancy === 'legacy-directory') {
        assert.equal(fs.readFileSync(userFile, 'utf-8'), '# mine\n');
      }
    });
  }
});

test('an unrelated cache child is never adopted as a managed checkout', async () => {
  await withScratchHomes(async (scratch) => {
    const config = loadConfig();
    const foreignDir = managedSourceDir(config.homes, 'foreign-tool');
    fs.mkdirSync(path.join(foreignDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'commands', 'not-a-plugin.md'), '# other tool\n');
    writeUserConfig(
      scratch,
      ['[plugins.sources]', 'foreign-tool = { url = "https://example.com/org/repo.git" }'].join(
        '\n'
      )
    );

    assert.match(sourceErrorOf('foreign-tool') ?? '', /not an ASB-managed checkout/);
    assert.equal(
      fs.readFileSync(path.join(foreignDir, 'commands', 'not-a-plugin.md'), 'utf-8'),
      '# other tool\n'
    );
  });
});

// ── Subtree ───────────────────────────────────────────────────────────────

test('a subtree source adds, updates, and removes inside the library repository', async () => {
  await withScratchHomes(async (scratch) => {
    const fixture = seedRemote(scratch.root);
    initAsbAsGitRepo(scratch.asbHome);

    addRemoteSource(loadConfig(), 'subtree-ns', {
      url: fixture.bareRepo,
      type: 'subtree',
      ref: 'main',
    });
    const homes = loadConfig().homes;
    const subtreeDir = path.join(pluginsDir(homes), 'subtree-ns');

    assert.ok(fs.existsSync(path.join(subtreeDir, 'rules', 'base.md')));
    assert.equal(sourcePathOf('subtree-ns'), subtreeDir);
    assert.equal(fs.existsSync(managedSourceDir(homes, 'subtree-ns')), false);

    commitIfDirty(scratch.asbHome, 'declare source');
    advanceRemote(fixture);

    const [updated] = updateSources(loadConfig());
    assert.equal(updated?.status, 'updated', updated?.error);
    assert.ok(fs.existsSync(path.join(subtreeDir, 'rules', 'next.md')));

    commitIfDirty(scratch.asbHome, 'sync');
    removeSource(loadConfig(), 'subtree-ns');
    assert.equal(fs.existsSync(subtreeDir), false);
    assert.equal(sourcePathOf('subtree-ns'), undefined);
  });
});

test('a subtree source requires a repo root, a clean tree, and an explicit ref', async () => {
  await withScratchHomes(async (scratch) => {
    const { bareRepo } = seedRemote(scratch.root);

    assert.throws(
      () =>
        addRemoteSource(loadConfig(), 'no-repo', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /git repo root/
    );

    initAsbAsGitRepo(scratch.asbHome);
    assert.throws(
      () => addRemoteSource(loadConfig(), 'no-ref', { url: bareRepo, type: 'subtree' }),
      /explicit "ref"/
    );

    fs.writeFileSync(path.join(scratch.asbHome, 'dirty.txt'), 'dirty');
    assert.throws(
      () => addRemoteSource(loadConfig(), 'dirty', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /uncommitted changes/
    );
  });
});
