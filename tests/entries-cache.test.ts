import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type Homes, resolveHomes } from '../src/engine/config.js';
import {
  type EntryRequest,
  entriesRoot,
  materializeEntry,
  refreshEntryCache,
  removeEntryCache,
} from '../src/engine/entries.js';
import { credentialFreeGitUrl, redactGitCredentials } from '../src/engine/git.js';
import {
  commitAndPush,
  createGitFixture,
  type GitFixture,
  gitFixtureCommand as git,
  type ScratchHomes,
  withScratchHomes,
  writeFixtureFile,
} from './helpers/scratch.js';

/**
 * Derived cache for external marketplace entries: pinning and ref resolution,
 * credential safety, refresh generation safety, ownership and symlink defense,
 * and retirement of the predecessor cache under ASB_HOME.
 */

function homesOf(_scratch: ScratchHomes): Homes {
  return resolveHomes();
}

/** A plugin at packages/plugin plus an unrelated tree, so sparse checkout is observable. */
function writePluginVersion(fixture: GitFixture, version: string): string {
  writeFixtureFile(fixture, 'packages/plugin/VERSION', `${version}\n`);
  writeFixtureFile(
    fixture,
    'packages/plugin/skills/remote-skill/SKILL.md',
    `---\nname: remote-skill\ndescription: ${version}\n---\nBody`
  );
  writeFixtureFile(fixture, `unrelated/${version}.txt`, version);
  return commitAndPush(fixture, version);
}

function requestFor(scratch: ScratchHomes, fixture: GitFixture, over: Partial<EntryRequest> = {}) {
  return {
    sourceName: 'catalog',
    marketplacePath: path.join(scratch.asbHome, 'catalog'),
    pluginName: 'remote-plugin',
    url: fixture.bareRepo,
    ref: 'main',
    subdir: 'packages/plugin',
    ...over,
  } satisfies EntryRequest;
}

test('a git-subdir entry checks out sparsely under the reserved cache subtree', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    writePluginVersion(remote, 'v1');

    const materialized = materializeEntry(homes, requestFor(scratch, remote));

    assert.equal(entriesRoot(homes), path.join(homes.cacheHome, '.entries'));
    assert.equal(
      path.relative(entriesRoot(homes), materialized.pluginPath).startsWith('..'),
      false
    );
    assert.equal(path.relative(scratch.asbHome, materialized.pluginPath).startsWith('..'), true);
    assert.equal(fs.existsSync(path.join(materialized.repoPath, 'unrelated')), false);
    assert.equal(git(['sparse-checkout', 'list'], materialized.repoPath), 'packages/plugin');
    // Nothing derived is written into the synchronized home.
    assert.equal(fs.existsSync(path.join(scratch.asbHome, 'state', 'marketplace-plugins')), false);
  });
});

test('a changed sha pin lands in a new entry and drops the superseded one', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    const firstSha = writePluginVersion(remote, 'v1');
    const secondSha = writePluginVersion(remote, 'v2');

    const first = materializeEntry(
      homes,
      requestFor(scratch, remote, { ref: undefined, sha: firstSha })
    );
    assert.equal(fs.readFileSync(path.join(first.pluginPath, 'VERSION'), 'utf-8').trim(), 'v1');

    const second = materializeEntry(
      homes,
      requestFor(scratch, remote, { ref: undefined, sha: secondSha })
    );

    assert.equal(fs.readFileSync(path.join(second.pluginPath, 'VERSION'), 'utf-8').trim(), 'v2');
    assert.notEqual(second.entryPath, first.entryPath);
    assert.equal(fs.existsSync(first.entryPath), false);
  });
});

test('ref and sha pins must resolve to the same exact commit', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    const firstSha = writePluginVersion(remote, 'v1');
    const secondSha = writePluginVersion(remote, 'v2');
    const request = requestFor(scratch, remote, { sha: secondSha });

    const materialized = materializeEntry(homes, request);
    assert.equal(materialized.commit, secondSha);
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v2'
    );

    assert.throws(() => materializeEntry(homes, { ...request, sha: firstSha }), /pin mismatch/);
    assert.equal(fs.existsSync(materialized.pluginPath), true);
  });
});

test('sha pins require full object IDs and refuse to create state', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(scratch.root, 'remote.git'),
          sha: 'abcdef1',
        }),
      /full 40- or 64-character object ID/
    );
    assert.equal(fs.existsSync(entriesRoot(homes)), false);
  });
});

test('a ref that is not a valid git ref name is refused', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    for (const ref of ['-oops', 'refs/remotes/origin/main', 'bad ref']) {
      assert.throws(
        () =>
          materializeEntry(homes, {
            sourceName: 'catalog',
            marketplacePath: path.join(scratch.asbHome, 'catalog'),
            pluginName: 'remote-plugin',
            url: path.join(scratch.root, 'remote.git'),
            ref,
          }),
        /Invalid marketplace plugin ref/
      );
    }
  });
});

test('a subdirectory that escapes the repository is refused', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(scratch.root, 'remote.git'),
          subdir: '../outside',
        }),
      /escapes the repository/
    );
    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(scratch.root, 'remote.git'),
          subdir: '/etc',
        }),
      /must be relative/
    );
  });
});

test('short refs prefer a same-named branch and fall back to a tag', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    const tagSha = writePluginVersion(remote, 'tag');
    git(['tag', 'main', tagSha], remote.workDir);
    git(['push', 'origin', 'refs/tags/main'], remote.workDir);
    const branchSha = writePluginVersion(remote, 'branch');

    const branch = materializeEntry(homes, requestFor(scratch, remote, { pluginName: 'branch' }));
    assert.equal(branch.commit, branchSha);
    assert.equal(fs.readFileSync(path.join(branch.pluginPath, 'VERSION'), 'utf-8'), 'branch\n');

    const exactBranch = materializeEntry(
      homes,
      requestFor(scratch, remote, { pluginName: 'exact-branch', ref: 'refs/heads/main' })
    );
    assert.equal(exactBranch.commit, branchSha);

    const exactTag = materializeEntry(
      homes,
      requestFor(scratch, remote, { pluginName: 'exact-tag', ref: 'refs/tags/main' })
    );
    assert.equal(exactTag.commit, tagSha);

    git(['tag', 'release-only', branchSha], remote.workDir);
    git(['push', 'origin', 'refs/tags/release-only'], remote.workDir);
    const tagOnly = materializeEntry(
      homes,
      requestFor(scratch, remote, { pluginName: 'tag-only', ref: 'release-only' })
    );
    assert.equal(tagOnly.commit, branchSha);
  });
});

test('git errors redact URL credentials and a successful fetch persists none', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const errorSecret = 'test-query-secret';
    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'broken-plugin',
          url: `http://127.0.0.1:1/repo.git?access_token=${errorSecret}`,
          ref: 'main',
        }),
      (error: unknown) => error instanceof Error && !error.message.includes(errorSecret)
    );

    const remote = createGitFixture(scratch.root, 'credential-remote');
    writePluginVersion(remote, 'v1');
    const persistedSecret = 'test-password';
    const materialized = materializeEntry(
      homes,
      requestFor(scratch, remote, {
        url: `file://test-user:${persistedSecret}@localhost${remote.bareRepo}`,
      })
    );

    const gitDir = path.join(materialized.repoPath, '.git');
    for (const relative of fs.readdirSync(gitDir, { recursive: true })) {
      const candidate = path.join(gitDir, String(relative));
      if (!fs.lstatSync(candidate).isFile()) continue;
      assert.equal(fs.readFileSync(candidate).includes(persistedSecret), false);
    }
  });
});

test('URL sanitization keeps SSH identity and redacts echoed credential values', () => {
  assert.equal(
    credentialFreeGitUrl('ssh://git:password@example.com/repo.git?token=query#fragment'),
    'ssh://git@example.com/repo.git'
  );
  const authenticated =
    'https://test-user:test-password@example.com/repo.git?token=query%2Dsecret&key=space+secret#fragment-secret';
  const redacted = redactGitCredentials(
    'remote rejected test-user test-password query-secret query%2Dsecret space+secret space secret fragment-secret',
    [authenticated]
  );
  assert.doesNotMatch(
    redacted,
    /test-user|test-password|query-secret|space secret|fragment-secret/
  );
  assert.doesNotMatch(redacted, /query%2Dsecret/);
  assert.doesNotMatch(redacted, /space\+secret/);
});

test('a failed refresh preserves the last verified generation and removes temp state', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const request = requestFor(scratch, remote);
    const materialized = materializeEntry(homes, request);

    const unavailable = `${remote.bareRepo}.unavailable`;
    fs.renameSync(remote.bareRepo, unavailable);
    try {
      assert.throws(
        () => refreshEntryCache(homes, request.sourceName, request.marketplacePath, [request]),
        /git fetch failed/
      );
    } finally {
      fs.renameSync(unavailable, remote.bareRepo);
    }

    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );
    assert.equal(git(['rev-parse', 'HEAD'], materialized.repoPath), materialized.commit);
    assert.deepEqual(
      fs.readdirSync(path.dirname(materialized.entryPath)).filter((name) => name.startsWith('.')),
      []
    );
  });
});

test('refresh reuses a verified immutable sha pin without fetching again', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    const sha = writePluginVersion(remote, 'v1');
    const request = requestFor(scratch, remote, { ref: undefined, sha });
    const materialized = materializeEntry(homes, request);
    fs.renameSync(remote.bareRepo, `${remote.bareRepo}.offline`);

    const result = refreshEntryCache(homes, 'catalog', request.marketplacePath, [request]);

    assert.deepEqual(result, { refreshed: 1, removed: 0 });
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );
  });
});

test('refresh touches materialized plugins only and drops undeclared entries', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    const unfetched = createGitFixture(scratch.root, 'unfetched-remote');
    writePluginVersion(remote, 'v1');
    writePluginVersion(unfetched, 'v1');
    const kept = requestFor(scratch, remote, { pluginName: 'kept-plugin' });
    const dropped = requestFor(scratch, remote, { pluginName: 'dropped-plugin' });
    const declaredOnly = requestFor(scratch, unfetched, { pluginName: 'declared-plugin' });
    const materialized = materializeEntry(homes, kept);
    const droppedEntry = materializeEntry(homes, dropped);

    const result = refreshEntryCache(homes, 'catalog', kept.marketplacePath, [kept, declaredOnly]);

    assert.deepEqual(result, { refreshed: 1, removed: 1 });
    assert.equal(fs.existsSync(droppedEntry.entryPath), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(materialized.entryPath)).filter((name) => !name.startsWith('.')),
      [path.basename(materialized.entryPath)],
      'the declared-but-unmaterialized plugin is never fetched'
    );
  });
});

test('cache ownership covers the source name and the canonical marketplace root', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const remote = createGitFixture(scratch.root, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const firstRoot = path.join(scratch.asbHome, 'catalog-one');
    const secondRoot = path.join(scratch.asbHome, 'catalog-two');
    const base = requestFor(scratch, remote, { sourceName: 'shared-name' });
    const first = materializeEntry(homes, { ...base, marketplacePath: firstRoot });
    const second = materializeEntry(homes, { ...base, marketplacePath: secondRoot });

    assert.notEqual(first.entryPath, second.entryPath);
    removeEntryCache(homes, 'shared-name', firstRoot);
    removeEntryCache(homes, 'shared-name', firstRoot);

    assert.equal(fs.existsSync(first.entryPath), false);
    assert.equal(fs.existsSync(second.entryPath), true);
  });
});

test('a symlinked entry root is rejected without touching its target', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const outside = path.join(scratch.root, 'outside-state');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.mkdirSync(homes.cacheHome, { recursive: true });
    fs.symlinkSync(outside, entriesRoot(homes));

    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(scratch.root, 'remote.git'),
          ref: 'main',
        }),
      /cache root contains a symbolic link/
    );
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  });
});

test('a symlinked cache home is rejected without touching its target', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = homesOf(scratch);
    const outside = path.join(scratch.root, 'outside-cache-home');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.symlinkSync(outside, homes.cacheHome);

    assert.throws(
      () =>
        materializeEntry(homes, {
          sourceName: 'catalog',
          marketplacePath: path.join(scratch.asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(scratch.root, 'remote.git'),
          ref: 'main',
        }),
      /cache root contains a symbolic link/
    );
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  });
});

// ── The predecessor cache under ASB_HOME: read to retire, never written ────

function compatibilityCacheRoot(scratch: ScratchHomes): string {
  return path.join(scratch.asbHome, 'state', 'marketplace-plugins');
}

/** Move a materialized entry into the layout a predecessor peer would have left behind. */
function moveToCompatibilityCache(
  scratch: ScratchHomes,
  homes: Homes,
  request: EntryRequest,
  entryPath: string
): string {
  const ownerIdentity = createHash('sha256')
    .update(
      JSON.stringify({
        sourceName: request.sourceName,
        marketplacePath: fs.realpathSync.native(request.marketplacePath),
      })
    )
    .digest('hex');
  const retiredEntry = path.join(
    compatibilityCacheRoot(scratch),
    `${request.sourceName}-${ownerIdentity.slice(0, 10)}`,
    path.basename(entryPath)
  );
  fs.mkdirSync(path.dirname(retiredEntry), { recursive: true });
  fs.renameSync(entryPath, retiredEntry);
  fs.rmSync(entriesRoot(homes), { recursive: true, force: true });
  return retiredEntry;
}

test('a verified predecessor retires only after a successful replacement', async () => {
  for (const owner of ['unchanged-path', 'migrated-source'] as const) {
    await withScratchHomes(async (scratch) => {
      const homes = homesOf(scratch);
      const remote = createGitFixture(scratch.root, 'retire-remote');
      writePluginVersion(remote, 'v1');
      const previousSourceDir = path.join(scratch.asbHome, 'plugins', 'retire-source');
      const cacheSourceDir = path.join(homes.cacheHome, 'retire-source');
      const firstOwner =
        owner === 'unchanged-path' ? path.join(scratch.asbHome, 'catalog') : previousSourceDir;
      fs.mkdirSync(firstOwner, { recursive: true });
      const base = requestFor(scratch, remote, { sourceName: 'retire-source' });

      const before = materializeEntry(homes, { ...base, marketplacePath: firstOwner });
      const retiredEntry = moveToCompatibilityCache(
        scratch,
        homes,
        { ...base, marketplacePath: firstOwner },
        before.entryPath
      );
      const secondOwner = owner === 'unchanged-path' ? firstOwner : cacheSourceDir;
      if (owner === 'migrated-source') {
        fs.rmSync(previousSourceDir, { recursive: true, force: true });
        fs.mkdirSync(secondOwner, { recursive: true });
      }

      const after = materializeEntry(homes, { ...base, marketplacePath: secondOwner });

      assert.equal(fs.readFileSync(path.join(after.pluginPath, 'VERSION'), 'utf-8').trim(), 'v1');
      assert.equal(path.relative(homes.cacheHome, after.entryPath).startsWith('..'), false);
      assert.equal(fs.existsSync(retiredEntry), false);
    });
  }
});

test('the predecessor cache preserves unsafe or unreplaced entries', async () => {
  for (const guard of ['materialization-failed', 'entry-unverified', 'root-symlink'] as const) {
    await withScratchHomes(async (scratch) => {
      const homes = homesOf(scratch);
      const remote = createGitFixture(scratch.root, 'preserve-remote');
      writePluginVersion(remote, 'v1');
      const marketplacePath = path.join(scratch.asbHome, 'catalog');
      fs.mkdirSync(marketplacePath, { recursive: true });
      const request = requestFor(scratch, remote, {
        sourceName: 'preserve-source',
        marketplacePath,
      });
      const before = materializeEntry(homes, request);
      const retiredEntry = moveToCompatibilityCache(scratch, homes, request, before.entryPath);

      if (guard === 'materialization-failed') {
        const offline = `${remote.bareRepo}.offline`;
        fs.renameSync(remote.bareRepo, offline);
        try {
          assert.throws(() => materializeEntry(homes, request), /git fetch failed/);
        } finally {
          fs.renameSync(offline, remote.bareRepo);
        }
      } else if (guard === 'entry-unverified') {
        fs.writeFileSync(path.join(retiredEntry, 'entry.json'), '{ not json\n');
        materializeEntry(homes, request);
      } else {
        const compatibilityRoot = compatibilityCacheRoot(scratch);
        const outside = path.join(scratch.root, 'linked-compatibility-cache');
        fs.renameSync(compatibilityRoot, outside);
        fs.symlinkSync(outside, compatibilityRoot);
        materializeEntry(homes, request);
      }

      assert.equal(fs.existsSync(retiredEntry), true);
      assert.equal(
        fs.existsSync(path.join(retiredEntry, 'repo', 'packages', 'plugin', 'VERSION')),
        true
      );
    });
  }
});
