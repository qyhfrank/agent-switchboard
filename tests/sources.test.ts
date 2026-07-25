import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  getCacheDir,
  getManagedSourceDir,
  getMarketplacePluginCacheDir,
  getPluginsDir,
} from '../src/config/paths.js';
import {
  addLocalSource,
  addRemoteSource,
  getSources,
  getSourcesRecord,
  hasSource,
  inferSourceName,
  isGitUrl,
  parseGitUrl,
  removeSource,
  updateRemoteSources,
  validateSourcePath,
} from '../src/library/sources.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { withCacheEnv, withTempAsbHome, withTempDir } from './helpers/tmp.js';

// ── URL detection ──────────────────────────────────────────────────

test('isGitUrl classifies remote URLs and local paths', () => {
  for (const [value, expected] of [
    ['https://github.com/org/repo', true],
    ['http://example.com/repo.git', true],
    ['git@github.com:org/repo.git', true],
    ['ssh://git@github.com/org/repo', true],
    ['git://example.com/repo.git', true],
    ['file:///srv/git/repo.git', true],
    ['/usr/local/lib', false],
    ['./relative/path', false],
    ['relative/path', false],
  ] as const) {
    assert.equal(isGitUrl(value), expected);
  }
});

// ── GitHub URL parsing ─────────────────────────────────────────────

test('parseGitUrl normalizes GitHub URLs and passes other transports through', () => {
  const cases = [
    ['https://github.com/org/repo', { url: 'https://github.com/org/repo.git' }],
    ['https://github.com/org/repo.git', { url: 'https://github.com/org/repo.git' }],
    ['https://github.com/org/repo/', { url: 'https://github.com/org/repo.git' }],
    [
      'https://github.com/org/repo/tree/main',
      { url: 'https://github.com/org/repo.git', ref: 'main' },
    ],
    [
      'https://github.com/org/repo/tree/main/lib/asb',
      { url: 'https://github.com/org/repo.git', ref: 'main', subdir: 'lib/asb' },
    ],
    ['https://gitlab.com/org/repo.git', { url: 'https://gitlab.com/org/repo.git' }],
    ['git@github.com:org/repo.git', { url: 'git@github.com:org/repo.git' }],
  ] as const;
  for (const [value, expected] of cases) assert.deepEqual(parseGitUrl(value), expected);
});

// ── Name inference ─────────────────────────────────────────────────

test('inferSourceName handles remote and local source paths', () => {
  for (const [value, expected] of [
    ['https://github.com/org/my-repo', 'my-repo'],
    ['https://github.com/org/my-repo.git', 'my-repo'],
    ['https://github.com/org/repo/tree/main/sub', 'repo'],
    ['git@github.com:org/my-lib.git', 'my-lib'],
    ['/path/to/team-library', 'team-library'],
    ['./relative/my-lib', 'my-lib'],
  ]) {
    assert.equal(inferSourceName(value), expected);
  }
});

// ── Local sources ──────────────────────────────────────────────────

test('addLocalSource creates local source and getSourcesRecord returns it', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource('local-team', libDir);

    const record = getSourcesRecord();
    assert.equal(record['local-team'], libDir);

    const sources = getSources();
    const src = sources.find((s) => s.namespace === 'local-team');
    assert.ok(src);
    assert.equal(src.path, libDir);
    assert.equal(src.remote, undefined);
  });
});

test('addLocalSource accepts dotted namespaces without empty segments', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'dotted-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource('team.tools', libDir);

    assert.equal(getSourcesRecord()['team.tools'], libDir);
    assert.throws(() => addLocalSource('team..tools', libDir), /Invalid namespace/);
  });
});

test('configured source namespaces reject path segments before resolution', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      '[plugins.sources."../outside"]\nurl = "https://example.invalid/repo.git"\ntype = "clone"\n'
    );

    assert.throws(() => getSourcesRecord(), /Invalid namespace/);
  });
});

test('source config updates preserve a symlinked config carrier', () => {
  withTempAsbHome((asbHome) => {
    const configPath = path.join(asbHome, 'config.toml');
    const targetPath = path.join(asbHome, 'shared', 'config.toml');
    const libDir = path.join(asbHome, 'symlinked-config-lib');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });
    fs.writeFileSync(targetPath, '[plugins]\nenabled = []\n');
    fs.rmSync(configPath, { force: true });
    fs.symlinkSync(targetPath, configPath);

    addLocalSource('symlinked-config', libDir);

    assert.equal(fs.lstatSync(configPath).isSymbolicLink(), true);
    assert.match(fs.readFileSync(targetPath, 'utf-8'), /symlinked-config/);
  });
});

test('addLocalSource rejects duplicate namespace', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource('dup', libDir);
    assert.throws(() => addLocalSource('dup', libDir), /already exists/);
  });
});

test('addLocalSource rejects invalid namespace characters', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(libDir, { recursive: true });

    assert.throws(() => addLocalSource('bad name', libDir), /Invalid namespace/);
    assert.throws(() => addLocalSource('bad/name', libDir), /Invalid namespace/);
  });
});

test('addLocalSource rejects non-existent path', () => {
  withTempAsbHome(() => {
    assert.throws(() => addLocalSource('test', '/nonexistent/path'), /does not exist/);
  });
});

test('removeSource removes local source', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource('removable', libDir);
    assert.equal(hasSource('removable'), true);

    removeSource('removable');
    assert.equal(hasSource('removable'), false);
  });
});

test('removeSource throws for unknown namespace', () => {
  withTempAsbHome(() => {
    assert.throws(() => removeSource('nonexistent'), /not found/);
  });
});

// ── Source path validation ──────────────────────────────────────────

test('validateSourcePath detects library folders', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(libDir, 'skills'), { recursive: true });

    const result = validateSourcePath(libDir);
    assert.equal(result.valid, true);
    assert.deepEqual(result.found.sort(), ['rules', 'skills']);
    assert.ok(result.missing.includes('commands'));
    assert.ok(result.missing.includes('agents'));
  });
});

test('validateSourcePath detects Codex native plugin manifests', () => {
  withTempAsbHome((asbHome) => {
    const pluginDir = path.join(asbHome, 'codex-plugin');
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'cowart' })
    );

    const result = validateSourcePath(pluginDir);
    assert.equal(result.valid, true);
    assert.deepEqual(result.found, ['plugin']);
    assert.equal(result.kind, 'plugin');
  });
});

test('validateSourcePath detects Codex native marketplace manifests', () => {
  withTempAsbHome((asbHome) => {
    const marketplaceDir = path.join(asbHome, 'codex-marketplace');
    fs.mkdirSync(path.join(marketplaceDir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: 'codex-marketplace', plugins: [] })
    );

    const result = validateSourcePath(marketplaceDir);
    assert.equal(result.valid, true);
    assert.deepEqual(result.found, ['marketplace']);
    assert.equal(result.kind, 'marketplace');
  });
});

test('validateSourcePath reports invalid when no library folders', () => {
  withTempAsbHome((asbHome) => {
    const emptyDir = path.join(asbHome, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = validateSourcePath(emptyDir);
    assert.equal(result.valid, false);
    assert.equal(result.found.length, 0);
  });
});

// ── Remote source config resolution ────────────────────────────────

test('getSourcesRecord resolves remote sources to cache paths', () => {
  withTempAsbHome((asbHome) => {
    const configPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        '[plugins.sources]',
        'local = "/some/local/path"',
        'remote-team = { url = "https://github.com/org/repo.git", ref = "main" }',
      ].join('\n')
    );

    const record = getSourcesRecord();
    assert.equal(record.local, '/some/local/path');

    const expectedCachePath = getManagedSourceDir('remote-team');
    assert.equal(record['remote-team'], expectedCachePath);
  });
});

test('getSourcesRecord includes subdir in resolved path for remote sources', () => {
  withTempAsbHome((asbHome) => {
    const configPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        '[plugins.sources]',
        'with-subdir = { url = "https://github.com/org/repo.git", subdir = "lib/asb" }',
      ].join('\n')
    );

    const record = getSourcesRecord();
    const expectedPath = path.join(getManagedSourceDir('with-subdir'), 'lib/asb');
    assert.equal(record['with-subdir'], expectedPath);
  });
});

test('getSources returns remote field for remote sources', () => {
  withTempAsbHome((asbHome) => {
    const configPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        '[plugins.sources]',
        'my-remote = { url = "https://github.com/org/repo.git", ref = "v2", subdir = "asb" }',
      ].join('\n')
    );

    const sources = getSources();
    assert.equal(sources.length, 1);
    const src = sources[0];
    assert.equal(src.namespace, 'my-remote');
    assert.ok(src.remote);
    assert.equal(src.remote.url, 'https://github.com/org/repo.git');
    assert.equal(src.remote.ref, 'v2');
    assert.equal(src.remote.subdir, 'asb');
  });
});

test('hasSource works for both local and remote', () => {
  withTempAsbHome((asbHome) => {
    const configPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        '[plugins.sources]',
        'local = "/some/path"',
        'remote = { url = "https://github.com/org/repo.git" }',
      ].join('\n')
    );

    assert.equal(hasSource('local'), true);
    assert.equal(hasSource('remote'), true);
    assert.equal(hasSource('nonexistent'), false);
  });
});

// ── Remote source lifecycle (uses local git repos) ─────────────────

test('addRemoteSource clones a local git repo and saves config', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'remote-fixture'));

    addRemoteSource('test-remote', { url: bareRepo, type: 'clone' });

    assert.equal(hasSource('test-remote'), true);

    const cacheDir = getManagedSourceDir('test-remote');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));

    const record = getSourcesRecord();
    assert.equal(record['test-remote'], cacheDir);

    const sources = getSources();
    const src = sources.find((s) => s.namespace === 'test-remote');
    assert.ok(src?.remote);
    assert.equal(src.remote.url, bareRepo);
  });
});

test('source Git errors redact URL query and fragment credentials', () => {
  withTempAsbHome(() => {
    assert.throws(
      () =>
        addRemoteSource('secret-source', {
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

test('marketplace add CLI does not display credential-bearing Git URLs', () => {
  withTempAsbHome(() => {
    const secrets = ['cli-user', 'cli-password', 'query-secret', 'fragment-secret'];
    const url =
      'http://cli-user:cli-password@127.0.0.1:1/repo.git?token=query-secret#fragment-secret';
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(process.cwd(), 'src', 'index.ts'),
        'plugin',
        'marketplace',
        'add',
        url,
      ],
      {
        env: { ...process.env, FORCE_COLOR: '0' },
        encoding: 'utf-8',
      }
    );
    assert.notEqual(result.status, 0);
    const output = `${result.stdout}${result.stderr}`;
    for (const secret of secrets) assert.equal(output.includes(secret), false);
  });
});

test('addRemoteSource preserves an existing auto-discovered plugin on name collision', () => {
  withTempAsbHome((asbHome) => {
    const existingPlugin = path.join(getPluginsDir(), 'existing');
    fs.mkdirSync(existingPlugin, { recursive: true });
    fs.writeFileSync(path.join(existingPlugin, 'keep.txt'), 'keep');
    const bareRepo = path.join(asbHome, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });

    assert.throws(
      () => addRemoteSource('existing', { url: bareRepo, type: 'clone' }),
      /already exists/
    );
    assert.equal(fs.readFileSync(path.join(existingPlugin, 'keep.txt'), 'utf-8'), 'keep');
  });
});

test('removeSource cleans up cache for remote sources', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'remove-fixture'));
    addRemoteSource('cleanup-test', { url: bareRepo, type: 'clone' });

    const cacheDir = getManagedSourceDir('cleanup-test');
    assert.ok(fs.existsSync(cacheDir));
    fs.rmSync(path.join(cacheDir, '.git', 'asb-source.json'));

    removeSource('cleanup-test');

    assert.equal(hasSource('cleanup-test'), false);
    assert.equal(fs.existsSync(cacheDir), false);
  });
});

test('removeSource preserves a modified managed clone', () => {
  withTempAsbHome((asbHome) => {
    const parent = path.join(asbHome, 'modified-clone-fixture');
    fs.mkdirSync(parent, { recursive: true });
    const { bareRepo } = createBareRemote(parent);
    addRemoteSource('modified-clone', { url: bareRepo, type: 'clone' });
    const cloneDir = getManagedSourceDir('modified-clone');
    const userFile = path.join(cloneDir, 'keep.txt');
    fs.writeFileSync(userFile, 'keep me\n');

    assert.throws(() => removeSource('modified-clone'), /unverified or modified/);

    assert.equal(hasSource('modified-clone'), true);
    assert.equal(fs.readFileSync(userFile, 'utf-8'), 'keep me\n');
  });
});

test('managed clone update rejects mismatched provenance without fetching', () => {
  for (const mismatch of ['marker', 'origin', 'ref', 'branch', 'tag'] as const) {
    withTempAsbHome((asbHome) => {
      const parent = path.join(asbHome, `provenance-${mismatch}-fixture`);
      fs.mkdirSync(parent, { recursive: true });
      const { bareRepo, workDir } = createBareRemote(parent);
      const namespace = `guarded-${mismatch}`;
      addRemoteSource(namespace, { url: bareRepo, type: 'clone' });
      const cloneDir = getManagedSourceDir(namespace);
      fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
      execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'advance'], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });
      const markerPath = path.join(cloneDir, '.git', 'asb-source.json');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
      if (mismatch === 'origin') {
        execFileSync('git', ['remote', 'set-url', 'origin', path.join(parent, 'foreign.git')], {
          cwd: cloneDir,
          stdio: 'pipe',
        });
      } else if (mismatch === 'marker' || mismatch === 'ref') {
        const changed =
          mismatch === 'marker' ? { ...marker, namespace: 'foreign' } : { ...marker, ref: 'other' };
        fs.writeFileSync(markerPath, `${JSON.stringify(changed)}\n`);
      } else {
        execFileSync('git', [mismatch, 'user-local'], { cwd: cloneDir, stdio: 'pipe' });
      }

      const beforeMarker = fs.readFileSync(markerPath, 'utf-8');
      const gitBefore = ['HEAD', 'refs/remotes/origin/main'].map((ref) =>
        execFileSync('git', ['rev-parse', ref], { cwd: cloneDir, encoding: 'utf-8' })
      );
      const objectsBefore = execFileSync('git', ['count-objects', '-v'], {
        cwd: cloneDir,
        encoding: 'utf-8',
      });

      const [result] = updateRemoteSources();

      assert.equal(result?.status, 'error');
      assert.match(result?.error ?? '', /unverified or modified/);
      assert.equal(fs.readFileSync(markerPath, 'utf-8'), beforeMarker);
      assert.deepEqual(
        ['HEAD', 'refs/remotes/origin/main'].map((ref) =>
          execFileSync('git', ['rev-parse', ref], { cwd: cloneDir, encoding: 'utf-8' })
        ),
        gitBefore
      );
      assert.equal(
        execFileSync('git', ['count-objects', '-v'], { cwd: cloneDir, encoding: 'utf-8' }),
        objectsBefore
      );
      assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'v2.md')), false);
    });
  }
});

test('managed clone adopts and repeatedly updates a force-moved detached tag', () => {
  withTempAsbHome((asbHome) => {
    const parent = path.join(asbHome, 'tag-ref-fixture');
    fs.mkdirSync(parent, { recursive: true });
    const { bareRepo, workDir } = createBareRemote(parent);
    execFileSync('git', ['tag', 'v1'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'v1'], { cwd: workDir, stdio: 'pipe' });

    addRemoteSource('tagged-clone', { url: bareRepo, type: 'clone', ref: 'v1' });
    const cloneDir = getManagedSourceDir('tagged-clone');
    fs.rmSync(path.join(cloneDir, '.git', 'asb-source.json'));
    execFileSync('git', ['checkout', '--orphan', 'replacement'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['rm', '-rf', '.'], { cwd: workDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(workDir, 'replacement.md'), 'replacement\n');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'replacement'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['tag', '--force', 'v1'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', '--force', 'origin', 'refs/tags/v1'], {
      cwd: workDir,
      stdio: 'pipe',
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      const [result] = updateRemoteSources(undefined, 'tagged-clone');
      assert.equal(result?.status, 'updated');
    }
    assert.equal(fs.existsSync(path.join(cloneDir, 'replacement.md')), true);

    removeSource('tagged-clone');
    assert.equal(fs.existsSync(cloneDir), false);
    assert.equal(hasSource('tagged-clone'), false);
  });
});

test('managed clone removal preserves local history and hidden files', () => {
  for (const localChange of ['commit', 'reflog', 'ignored', 'hidden-index'] as const) {
    withTempAsbHome((asbHome) => {
      const parent = path.join(asbHome, `preserve-${localChange}-fixture`);
      fs.mkdirSync(parent, { recursive: true });
      const { bareRepo } = createBareRemote(parent);
      const namespace = `preserve-${localChange}`;
      addRemoteSource(namespace, { url: bareRepo, type: 'clone' });
      const cloneDir = getManagedSourceDir(namespace);
      const localFile =
        localChange === 'hidden-index'
          ? path.join(cloneDir, 'rules', 'v1.md')
          : path.join(cloneDir, `${localChange}.txt`);

      fs.writeFileSync(localFile, `${localChange}\n`);
      if (localChange === 'commit' || localChange === 'reflog') {
        const managedHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: cloneDir,
          encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['add', '.'], { cwd: cloneDir, stdio: 'pipe' });
        execFileSync(
          'git',
          ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'local'],
          { cwd: cloneDir, stdio: 'pipe' }
        );
        if (localChange === 'reflog') {
          execFileSync('git', ['reset', '--hard', managedHead], { cwd: cloneDir, stdio: 'pipe' });
        }
      } else {
        if (localChange === 'ignored') {
          fs.appendFileSync(path.join(cloneDir, '.git', 'info', 'exclude'), '\nignored.txt\n');
        } else {
          execFileSync('git', ['update-index', '--assume-unchanged', 'rules/v1.md'], {
            cwd: cloneDir,
            stdio: 'pipe',
          });
        }
      }

      assert.throws(() => removeSource(namespace), /unverified or modified/);
      if (localChange !== 'reflog') {
        assert.equal(fs.readFileSync(localFile, 'utf-8'), `${localChange}\n`);
      }
      assert.equal(hasSource(namespace), true);
    });
  }
});

test('managed clone rejects symlinked clone and git roots', () => {
  for (const linkedRoot of ['clone', 'git'] as const) {
    withTempAsbHome((asbHome) => {
      const parent = path.join(asbHome, `linked-${linkedRoot}-fixture`);
      fs.mkdirSync(parent, { recursive: true });
      const { bareRepo, workDir } = createBareRemote(parent);
      const namespace = `linked-${linkedRoot}`;
      addRemoteSource(namespace, { url: bareRepo, type: 'clone' });
      const cloneDir = getManagedSourceDir(namespace);
      const moved = path.join(parent, `external-${linkedRoot}`);
      const link = linkedRoot === 'clone' ? cloneDir : path.join(cloneDir, '.git');
      fs.renameSync(link, moved);
      fs.symlinkSync(moved, link);
      const markerPath = path.join(cloneDir, '.git', 'asb-source.json');
      const markerBefore = fs.readFileSync(markerPath, 'utf-8');
      fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
      execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'advance'], { cwd: workDir, stdio: 'pipe' });
      execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

      const [result] = updateRemoteSources(undefined, namespace);

      assert.equal(result?.status, 'error');
      assert.equal(fs.readFileSync(markerPath, 'utf-8'), markerBefore);
      assert.equal(fs.existsSync(path.join(cloneDir, 'rules', 'v2.md')), false);
    });
  }
});

test('updateRemoteSources pulls latest changes', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'update-fixture'));

    addRemoteSource('update-test', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('update-test');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    fs.rmSync(path.join(cacheDir, '.git', 'asb-source.json'));

    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      {
        cwd: workDir,
        stdio: 'pipe',
      }
    );
    execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

    const results = updateRemoteSources();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'updated');
    assert.equal(results[0].namespace, 'update-test');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v2.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
  });
});

test('updateRemoteSources aborts its conflicting clone merge despite rebase config', () => {
  withTempAsbHome((asbHome) => {
    const parent = path.join(asbHome, 'conflict-fixture');
    fs.mkdirSync(parent, { recursive: true });
    const { bareRepo, workDir } = createBareRemote(parent);
    addRemoteSource('conflict-source', { url: bareRepo, type: 'clone' });
    const cloneDir = getManagedSourceDir('conflict-source');
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: cloneDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'pull.rebase', 'true'], { cwd: cloneDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(cloneDir, 'rules', 'v1.md'), '# Local\n');
    execFileSync('git', ['add', '.'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'local'], { cwd: cloneDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(workDir, 'rules', 'v1.md'), '# Remote\n');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'remote'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });

    const results = updateRemoteSources();
    assert.equal(results[0]?.status, 'error');
    const mergeHead = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], {
      cwd: cloneDir,
      encoding: 'utf-8',
    }).trim();
    assert.equal(fs.existsSync(path.resolve(cloneDir, mergeHead)), false);
    assert.equal(fs.readFileSync(path.join(cloneDir, 'rules', 'v1.md'), 'utf-8'), '# Local\n');
  });
});

test('updateRemoteSources preserves a merge that existed before the pull', () => {
  withTempAsbHome((asbHome) => {
    const parent = path.join(asbHome, 'existing-merge-fixture');
    fs.mkdirSync(parent, { recursive: true });
    const { bareRepo, workDir } = createBareRemote(parent);
    addRemoteSource('existing-merge-source', { url: bareRepo, type: 'clone' });
    const cloneDir = getManagedSourceDir('existing-merge-source');
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: cloneDir,
      stdio: 'pipe',
    });
    fs.writeFileSync(path.join(cloneDir, 'rules', 'v1.md'), '# Local\n');
    execFileSync('git', ['add', '.'], { cwd: cloneDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'local'], { cwd: cloneDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(workDir, 'rules', 'v1.md'), '# Remote\n');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'remote'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['fetch', 'origin'], { cwd: cloneDir, stdio: 'pipe' });
    assert.throws(() =>
      execFileSync('git', ['merge', 'origin/main'], { cwd: cloneDir, stdio: 'pipe' })
    );
    fs.writeFileSync(path.join(cloneDir, 'rules', 'v1.md'), 'draft resolution\n');
    const mergeHead = execFileSync('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], {
      cwd: cloneDir,
      encoding: 'utf-8',
    }).trim();

    const results = updateRemoteSources();

    assert.equal(results[0]?.status, 'error');
    assert.equal(fs.existsSync(path.resolve(cloneDir, mergeHead)), true);
    assert.equal(
      fs.readFileSync(path.join(cloneDir, 'rules', 'v1.md'), 'utf-8'),
      'draft resolution\n'
    );
  });
});

test('updateRemoteSources re-clones when cache is missing', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'reclone-fixture'));

    addRemoteSource('reclone-test', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('reclone-test');

    fs.rmSync(cacheDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(cacheDir), false);

    const results = updateRemoteSources();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'updated');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));

    fs.rmSync(path.join(cacheDir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(cacheDir, 'keep.txt'), 'keep me\n');
    const blocked = updateRemoteSources();
    assert.equal(blocked[0]?.status, 'error');
    assert.equal(fs.readFileSync(path.join(cacheDir, 'keep.txt'), 'utf-8'), 'keep me\n');
  });
});

test('updateRemoteSources skips local sources', () => {
  withTempAsbHome((asbHome) => {
    const libDir = path.join(asbHome, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource('local-only', libDir);

    const results = updateRemoteSources();
    assert.equal(results.length, 0);
  });
});

test('updateRemoteSources can target one namespace without updating others', () => {
  withTempAsbHome((asbHome) => {
    const firstParent = path.join(asbHome, 'first');
    const secondParent = path.join(asbHome, 'second');
    fs.mkdirSync(firstParent, { recursive: true });
    fs.mkdirSync(secondParent, { recursive: true });
    const first = createBareRemote(firstParent);
    const second = createBareRemote(secondParent);
    addRemoteSource('first', { url: first.bareRepo, type: 'clone' });
    addRemoteSource('second', { url: second.bareRepo, type: 'clone' });

    fs.writeFileSync(path.join(first.workDir, 'rules', 'first-v2.md'), '# First V2');
    execFileSync('git', ['add', '.'], { cwd: first.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'first-v2'],
      { cwd: first.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: first.workDir, stdio: 'pipe' });

    fs.writeFileSync(path.join(second.workDir, 'rules', 'second-v2.md'), '# Second V2');
    execFileSync('git', ['add', '.'], { cwd: second.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'second-v2'],
      { cwd: second.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: second.workDir, stdio: 'pipe' });

    const results = updateRemoteSources(undefined, 'first');

    assert.deepEqual(
      results.map((result) => result.namespace),
      ['first']
    );
    assert.equal(
      fs.existsSync(path.join(getManagedSourceDir('first'), 'rules', 'first-v2.md')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(getManagedSourceDir('second'), 'rules', 'second-v2.md')),
      false
    );
  });
});

test('updateRemoteSources refreshes materialized marketplace entries', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'entry-remote');
    const catalogParent = path.join(asbHome, 'catalog-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);

    const pluginRoot = path.join(entryRemote.workDir, 'plugin');
    const skillDir = path.join(pluginRoot, 'skills', 'remote-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: remote-skill\ndescription: remote\n---\nBody'
    );
    fs.writeFileSync(path.join(pluginRoot, 'VERSION'), 'v1\n');
    execFileSync('git', ['add', '.'], { cwd: entryRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin-v1'],
      { cwd: entryRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: entryRemote.workDir, stdio: 'pipe' });

    fs.mkdirSync(path.join(catalogRemote.workDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogRemote.workDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'remote-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo, path: 'plugin' },
          },
        ],
      })
    );
    execFileSync('git', ['add', '.'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    addRemoteSource('catalog-source', { url: catalogRemote.bareRepo, type: 'clone' });
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@catalog-source');
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    assert.equal(fs.readFileSync(path.join(materializedPath, 'VERSION'), 'utf-8').trim(), 'v1');

    fs.writeFileSync(path.join(pluginRoot, 'VERSION'), 'v2\n');
    execFileSync('git', ['add', '.'], { cwd: entryRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin-v2'],
      { cwd: entryRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: entryRemote.workDir, stdio: 'pipe' });

    const results = updateRemoteSources();
    const refreshedIndex = buildPluginIndex();
    const refreshedPlugin = refreshedIndex.get('remote-plugin@catalog-source');
    assert.ok(refreshedPlugin);
    refreshedIndex.expand([refreshedPlugin.id]);

    assert.equal(results[0]?.status, 'updated');
    assert.notEqual(refreshedIndex, index);
    assert.equal(fs.readFileSync(path.join(materializedPath, 'VERSION'), 'utf-8').trim(), 'v2');
    assert.equal(fs.existsSync(path.join(getManagedSourceDir('catalog-source'), '.git')), true);
  });
});

test('updateRemoteSources removes derived cache when a source stops being a marketplace', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'entry-remote');
    const catalogParent = path.join(asbHome, 'catalog-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);

    fs.mkdirSync(path.join(catalogRemote.workDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogRemote.workDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'remote-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    execFileSync('git', ['add', '.'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    addRemoteSource('catalog-source', { url: catalogRemote.bareRepo, type: 'clone' });
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@catalog-source');
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    assert.equal(fs.existsSync(materializedPath), true);

    fs.rmSync(path.join(catalogRemote.workDir, '.claude-plugin'), {
      recursive: true,
      force: true,
    });
    fs.writeFileSync(path.join(catalogRemote.workDir, 'rules', 'ordinary.md'), '# Ordinary');
    execFileSync('git', ['add', '-A'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'ordinary-plugin'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    const results = updateRemoteSources();

    assert.equal(results[0]?.status, 'updated');
    assert.equal(fs.existsSync(materializedPath), false);
    assert.equal(
      fs.existsSync(path.join(getManagedSourceDir('catalog-source'), 'rules', 'ordinary.md')),
      true
    );
  });
});

test('updateRemoteSources removes cache owned by a deleted symlinked marketplace subdir', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'update-symlink-entry');
    const catalogParent = path.join(asbHome, 'update-symlink-catalog');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);

    fs.mkdirSync(path.join(entryRemote.workDir, 'plugin', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(entryRemote.workDir, 'plugin', 'commands', 'remote.md'), 'Remote\n');
    execFileSync('git', ['add', '.'], { cwd: entryRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin'],
      { cwd: entryRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: entryRemote.workDir, stdio: 'pipe' });

    const catalogDir = path.join(catalogRemote.workDir, 'catalog');
    fs.mkdirSync(path.join(catalogDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'update-symlink-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'git-subdir', url: entryRemote.bareRepo, path: 'plugin' },
          },
        ],
      })
    );
    fs.symlinkSync('catalog', path.join(catalogRemote.workDir, 'catalog-link'));
    execFileSync('git', ['add', '.'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    addRemoteSource('update-symlink-source', {
      url: catalogRemote.bareRepo,
      subdir: 'catalog-link',
      type: 'clone',
    });
    const index = buildPluginIndex();
    index.expand(['remote-plugin@update-symlink-source']);
    const derivedRoot = getMarketplacePluginCacheDir();
    assert.equal(fs.readdirSync(derivedRoot).length, 1);

    fs.rmSync(path.join(catalogRemote.workDir, 'catalog-link'));
    execFileSync('git', ['add', '-A'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'remove-link'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    const results = updateRemoteSources();

    assert.equal(results[0]?.status, 'updated');
    assert.deepEqual(fs.existsSync(derivedRoot) ? fs.readdirSync(derivedRoot) : [], []);
  });
});

test('removeSource cleans only its marketplace entry cache', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const pluginRoot = path.join(entryRemote.workDir, 'plugin');
    const skillDir = path.join(pluginRoot, 'skills', 'remote-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: remote-skill\ndescription: remote\n---\nBody'
    );
    execFileSync('git', ['add', '.'], { cwd: entryRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin'],
      { cwd: entryRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: entryRemote.workDir, stdio: 'pipe' });

    const marketplaceDir = path.join(asbHome, 'local-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'local-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo, path: 'plugin' },
          },
        ],
      })
    );
    addLocalSource('local-catalog', marketplaceDir);
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@local-catalog');
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;

    const userPlugin = path.join(getPluginsDir(), 'user-owned');
    const unrelatedState = path.join(asbHome, 'state', 'keep.txt');
    fs.mkdirSync(userPlugin, { recursive: true });
    fs.writeFileSync(path.join(userPlugin, 'keep.txt'), 'keep');
    fs.mkdirSync(path.dirname(unrelatedState), { recursive: true });
    fs.writeFileSync(unrelatedState, 'keep');

    removeSource('local-catalog');

    assert.equal(fs.existsSync(materializedPath), false);
    assert.equal(fs.existsSync(path.join(userPlugin, 'keep.txt')), true);
    assert.equal(fs.existsSync(unrelatedState), true);
  });
});

test('removeSource preserves canonical cache ownership for a symlinked remote subdir', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'symlink-entry');
    const catalogParent = path.join(asbHome, 'symlink-catalog');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);

    fs.mkdirSync(path.join(entryRemote.workDir, 'plugin', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(entryRemote.workDir, 'plugin', 'commands', 'remote.md'), 'Remote\n');
    execFileSync('git', ['add', '.'], { cwd: entryRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'plugin'],
      { cwd: entryRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: entryRemote.workDir, stdio: 'pipe' });

    const catalogDir = path.join(catalogRemote.workDir, 'catalog');
    fs.mkdirSync(path.join(catalogDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'symlink-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'git-subdir', url: entryRemote.bareRepo, path: 'plugin' },
          },
        ],
      })
    );
    fs.symlinkSync('catalog', path.join(catalogRemote.workDir, 'catalog-link'));
    execFileSync('git', ['add', '.'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: catalogRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push'], { cwd: catalogRemote.workDir, stdio: 'pipe' });

    addRemoteSource('symlink-source', {
      url: catalogRemote.bareRepo,
      subdir: 'catalog-link',
      type: 'clone',
    });
    const index = buildPluginIndex();
    index.expand(['remote-plugin@symlink-source']);
    const derivedRoot = getMarketplacePluginCacheDir();
    assert.equal(fs.readdirSync(derivedRoot).length, 1);

    removeSource('symlink-source');

    assert.deepEqual(fs.existsSync(derivedRoot) ? fs.readdirSync(derivedRoot) : [], []);
  });
});

test('addRemoteSource with subdir resolves effective path correctly', () => {
  withTempAsbHome((asbHome) => {
    const bareRepo = path.join(asbHome, 'bare-repo.git');
    fs.mkdirSync(bareRepo, { recursive: true });

    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });

    const workDir = path.join(asbHome, 'work');
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, 'nested', 'lib', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'nested', 'lib', 'rules', 'deep.md'), '# Deep');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'],
      {
        cwd: workDir,
        stdio: 'pipe',
      }
    );
    execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

    addRemoteSource('subdir-test', { url: bareRepo, subdir: 'nested/lib', type: 'clone' });

    const record = getSourcesRecord();
    const expectedPath = path.join(getManagedSourceDir('subdir-test'), 'nested/lib');
    assert.equal(record['subdir-test'], expectedPath);

    assert.ok(fs.existsSync(path.join(expectedPath, 'rules', 'deep.md')));
  });
});

// ── Subtree source lifecycle ──────────────────────────────────────

function createBareRemote(parentDir: string): { bareRepo: string; workDir: string } {
  const bareRepo = path.join(parentDir, 'bare-repo.git');
  const workDir = path.join(parentDir, 'work');
  fs.mkdirSync(bareRepo, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });
  execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: workDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'rules', 'v1.md'), '# V1');
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'v1'], { cwd: workDir, stdio: 'pipe' });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
  return { bareRepo, workDir };
}

function initAsbAsGitRepo(asbHome: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: asbHome, stdio: 'pipe' });
  execFileSync('git', ['-C', asbHome, 'config', 'user.name', 'test'], { stdio: 'pipe' });
  execFileSync('git', ['-C', asbHome, 'config', 'user.email', 'test@test.com'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(asbHome, 'config.toml'), '');
  execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'init'],
    { cwd: asbHome, stdio: 'pipe' }
  );
}

test('subtree lifecycle: add → update → remove', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    addRemoteSource('st', { url: bareRepo, type: 'subtree', ref: 'main' });
    assert.equal(hasSource('st'), true);
    const pluginDir = path.join(getPluginsDir(), 'st');
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'v1.md')));
    assert.equal(fs.existsSync(path.join(pluginDir, '.git')), false);

    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@test.com',
        'commit',
        '-m',
        'add source config',
      ],
      { cwd: asbHome, stdio: 'pipe' }
    );

    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });

    const results = updateRemoteSources();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'updated');
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'v2.md')));

    removeSource('st');
    assert.equal(hasSource('st'), false);
    assert.equal(fs.existsSync(pluginDir), false);
  });
});

test('subtree requires explicit ref', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    assert.throws(
      () => addRemoteSource('no-ref', { url: bareRepo, type: 'subtree' }),
      /explicit "ref"/
    );
  });
});

test('subtree errors when ASB_HOME is not a git repo', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));

    assert.throws(
      () => addRemoteSource('no-git', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /git repo root/
    );
  });
});

test('subtree errors when ASB_HOME is a subdirectory of a git repo', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    const parentDir = path.dirname(asbHome);
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: parentDir, stdio: 'pipe' });
    execFileSync('git', ['-C', parentDir, 'config', 'user.name', 'test'], { stdio: 'pipe' });
    execFileSync('git', ['-C', parentDir, 'config', 'user.email', 'test@test.com'], {
      stdio: 'pipe',
    });

    assert.throws(
      () => addRemoteSource('nested', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /git repo root/
    );
  });
});

test('subtree errors on dirty working tree', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    fs.writeFileSync(path.join(asbHome, 'config.toml'), '# dirty');

    assert.throws(
      () => addRemoteSource('dirty', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /uncommitted changes/
    );
  });
});

test('subtree fallback persists type as requested when subtree succeeds', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    addRemoteSource('persist-test', { url: bareRepo, type: 'subtree', ref: 'main' });

    const sources = getSources();
    const src = sources.find((s) => s.namespace === 'persist-test');
    assert.ok(src?.remote);
    assert.equal(src.remote.type, 'subtree');
  });
});

// ── Managed cache root resolution ─────────────────────────────────

test('cache root resolves explicit ASB_CACHE_HOME, then XDG, then ~/.cache/asb', () => {
  withTempDir((root) => {
    const explicit = path.join(root, 'explicit-cache');
    const xdg = path.join(root, 'xdg-cache');
    const home = path.join(root, 'home');

    withCacheEnv({ ASB_CACHE_HOME: explicit, XDG_CACHE_HOME: xdg, HOME: home }, () => {
      assert.equal(getCacheDir(), explicit);
    });
    withCacheEnv({ XDG_CACHE_HOME: xdg, HOME: home }, () => {
      assert.equal(getCacheDir(), path.join(xdg, 'asb'));
    });
    withCacheEnv({ HOME: home }, () => {
      assert.equal(getCacheDir(), path.join(home, '.cache', 'asb'));
    });
  });
});

test('managed source directory is a flat cache child outside the synchronized config dir', () => {
  withTempAsbHome((asbHome) => {
    const managed = getManagedSourceDir('ppt-master');
    assert.equal(path.basename(managed), 'ppt-master');
    assert.equal(path.dirname(managed), getCacheDir());
    assert.equal(path.relative(asbHome, managed).startsWith('..'), true);
    assert.equal(path.relative(getPluginsDir(), managed).startsWith('..'), true);
  });
});

// ── Managed clone lives in the cache, not ASB_HOME/plugins ────────

test('addRemoteSource materializes a managed clone in the cache and not under ASB_HOME/plugins', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'cache-layout-fixture'));

    addRemoteSource('cached-source', { url: bareRepo, type: 'clone' });

    const cacheDir = getManagedSourceDir('cached-source');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'cached-source')), false);
    assert.equal(getSourcesRecord()['cached-source'], cacheDir);
  });
});

test('a documented string Git URL resolves to a managed cache clone and updates', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'string-url-fixture'));
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      ['[plugins.sources]', `string-remote = "file://${bareRepo}"`].join('\n')
    );

    const cacheDir = getManagedSourceDir('string-remote');
    assert.equal(getSourcesRecord()['string-remote'], cacheDir);

    const [created] = updateRemoteSources();
    assert.equal(created?.status, 'updated');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'string-remote')), false);

    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'v2'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

    const [updated] = updateRemoteSources();
    assert.equal(updated?.status, 'updated');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v2.md')));
  });
});

test('a local path string source stays user-owned and is never cache-resolved', () => {
  withTempAsbHome((asbHome) => {
    const bare = path.join(asbHome, 'user-managed.git');
    fs.mkdirSync(path.join(bare, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(bare, 'rules', 'user.md'), '# User');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      ['[plugins.sources]', `path-like = "${bare}"`].join('\n')
    );

    assert.equal(getSourcesRecord()['path-like'], bare);
    assert.deepEqual(updateRemoteSources(), []);
    assert.equal(fs.existsSync(getManagedSourceDir('path-like')), false);
    assert.equal(fs.readFileSync(path.join(bare, 'rules', 'user.md'), 'utf-8'), '# User');
  });
});

test('cache directories never become auto-discovered sources', () => {
  withTempAsbHome(() => {
    const stray = path.join(getCacheDir(), 'undeclared');
    fs.mkdirSync(path.join(stray, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(stray, 'rules', 'stray.md'), '# Stray');

    assert.equal(hasSource('undeclared'), false);
    assert.equal(getSourcesRecord().undeclared, undefined);
    assert.equal(
      getSources().some((source) => source.namespace === 'undeclared'),
      false
    );
  });
});

test('an ASB_HOME/plugins directory is still auto-discovered next to a cached managed source', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'coexist-fixture'));
    addRemoteSource('managed', { url: bareRepo, type: 'clone' });
    const userPlugin = path.join(getPluginsDir(), 'my-dev-plugin');
    fs.mkdirSync(path.join(userPlugin, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(userPlugin, 'rules', 'dev.md'), '# Dev');

    const record = getSourcesRecord();
    assert.equal(record['my-dev-plugin'], userPlugin);
    assert.equal(record.managed, getManagedSourceDir('managed'));
  });
});

test('removeSource cleans the managed cache checkout and leaves the cache root usable', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'remove-cache-fixture'));
    addRemoteSource('remove-cached', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('remove-cached');
    assert.ok(fs.existsSync(cacheDir));

    removeSource('remove-cached');

    assert.equal(fs.existsSync(cacheDir), false);
    assert.equal(hasSource('remove-cached'), false);
    assert.equal(fs.existsSync(getCacheDir()), true);
  });
});

test('updateRemoteSources reconstructs a deleted managed cache from config', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'reconstruct-fixture'));
    addRemoteSource('reconstruct', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('reconstruct');

    fs.rmSync(getCacheDir(), { recursive: true, force: true });
    assert.equal(fs.existsSync(cacheDir), false);

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'updated');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
  });
});

// ── Legacy managed clone migration ────────────────────────────────

/** Relocate a managed cache checkout back to the pre-cache ASB_HOME/plugins layout. */
function demoteToLegacyLayout(namespace: string): string {
  const legacyDir = path.join(getPluginsDir(), namespace);
  fs.mkdirSync(path.dirname(legacyDir), { recursive: true });
  fs.renameSync(getManagedSourceDir(namespace), legacyDir);
  return legacyDir;
}

test('a verified clean legacy managed clone migrates into the cache on update', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'migrate-fixture'));
    addRemoteSource('migrate-me', { url: bareRepo, type: 'clone' });
    const legacyDir = demoteToLegacyLayout('migrate-me');
    const cacheDir = getManagedSourceDir('migrate-me');
    assert.equal(getSourcesRecord()['migrate-me'], legacyDir);

    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'v2'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'updated');
    assert.equal(fs.existsSync(legacyDir), false);
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v2.md')));
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
    assert.equal(getSourcesRecord()['migrate-me'], cacheDir);
  });
});

test('a modified legacy managed clone is preserved with an actionable error', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'modified-legacy-fixture'));
    addRemoteSource('modified-legacy', { url: bareRepo, type: 'clone' });
    const legacyDir = demoteToLegacyLayout('modified-legacy');
    fs.writeFileSync(path.join(legacyDir, 'keep.txt'), 'keep me\n');

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /unverified or modified/);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'keep.txt'), 'utf-8'), 'keep me\n');
    assert.ok(fs.existsSync(path.join(legacyDir, '.git')));
    assert.equal(fs.existsSync(getManagedSourceDir('modified-legacy')), false);
  });
});

test('an unverifiable legacy managed clone is preserved with an actionable error', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'unverified-legacy-fixture'));
    addRemoteSource('unverified-legacy', { url: bareRepo, type: 'clone' });
    const legacyDir = demoteToLegacyLayout('unverified-legacy');
    const markerPath = path.join(legacyDir, '.git', 'asb-source.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(markerPath, `${JSON.stringify({ ...marker, namespace: 'foreign' })}\n`);

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /unverified or modified/);
    assert.ok(fs.existsSync(path.join(legacyDir, '.git')));
    assert.equal(fs.existsSync(getManagedSourceDir('unverified-legacy')), false);
  });
});

test('a user-owned directory at the legacy path is never moved or deleted', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'user-legacy-fixture'));
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      ['[plugins.sources]', `user-owned-ns = { url = "${bareRepo}", type = "clone" }`].join('\n')
    );
    const userDir = path.join(getPluginsDir(), 'user-owned-ns');
    fs.mkdirSync(path.join(userDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(userDir, 'rules', 'mine.md'), '# Mine');

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /unverified or modified/);
    assert.equal(fs.readFileSync(path.join(userDir, 'rules', 'mine.md'), 'utf-8'), '# Mine');
    assert.equal(fs.existsSync(getManagedSourceDir('user-owned-ns')), false);
    assert.throws(() => removeSource('user-owned-ns'), /unverified or modified/);
    assert.equal(fs.readFileSync(path.join(userDir, 'rules', 'mine.md'), 'utf-8'), '# Mine');
  });
});

test('removeSource refuses a namespace held in both the cache and ASB_HOME/plugins', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'remove-conflict-fixture'));
    addRemoteSource('two-copies', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('two-copies');
    const legacyDir = path.join(getPluginsDir(), 'two-copies');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.cpSync(cacheDir, legacyDir, { recursive: true });

    assert.throws(() => removeSource('two-copies'), /both/i);

    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
    assert.ok(fs.existsSync(path.join(legacyDir, 'rules', 'v1.md')));
    assert.match(fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'), /two-copies/);
  });
});

test('a legacy checkout conflicting with an existing cache checkout preserves both', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'conflict-legacy-fixture'));
    addRemoteSource('both-paths', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('both-paths');
    const legacyDir = path.join(getPluginsDir(), 'both-paths');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.cpSync(cacheDir, legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'legacy-marker.txt'), 'legacy\n');

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /both/i);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'legacy-marker.txt'), 'utf-8'), 'legacy\n');
    assert.ok(fs.existsSync(path.join(cacheDir, '.git', 'asb-source.json')));
  });
});

test('subtree sources stay under ASB_HOME/plugins and never enter the cache', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    addRemoteSource('subtree-ns', { url: bareRepo, type: 'subtree', ref: 'main' });

    const subtreeDir = path.join(getPluginsDir(), 'subtree-ns');
    assert.ok(fs.existsSync(path.join(subtreeDir, 'rules', 'v1.md')));
    assert.equal(getSourcesRecord()['subtree-ns'], subtreeDir);
    assert.equal(fs.existsSync(getManagedSourceDir('subtree-ns')), false);
  });
});

// ── Ownership of a migrated or adopted checkout ────────────────────

test('a markerless legacy clone is preserved and reported instead of migrated', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'markerless-fixture'));
    addRemoteSource('markerless', { url: bareRepo, type: 'clone' });
    const legacyDir = demoteToLegacyLayout('markerless');
    fs.rmSync(path.join(legacyDir, '.git', 'asb-source.json'));

    const [result] = updateRemoteSources();

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /unverified or modified/);
    assert.ok(fs.existsSync(path.join(legacyDir, 'rules', 'v1.md')));
    assert.equal(fs.existsSync(getManagedSourceDir('markerless')), false);
  });
});

test('a namespace held in both locations errors on read, not only on mutation', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'both-read-fixture'));
    addRemoteSource('both-read', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('both-read');
    const legacyDir = path.join(getPluginsDir(), 'both-read');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'user-file.md'), '# mine\n');

    assert.throws(() => getSourcesRecord(), /both the managed cache/);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'user-file.md'), 'utf-8'), '# mine\n');
    assert.ok(fs.existsSync(cacheDir));
  });
});

test('an unrelated cache child is never adopted as a managed checkout', () => {
  withTempAsbHome((asbHome) => {
    const foreignDir = getManagedSourceDir('foreign-tool');
    fs.mkdirSync(path.join(foreignDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'commands', 'not-a-plugin.md'), '# other tool\n');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      ['[plugins.sources]', 'foreign-tool = { url = "https://example.com/org/repo.git" }'].join(
        '\n'
      )
    );

    assert.throws(() => getSourcesRecord(), /not an ASB-managed checkout/);
    assert.equal(
      fs.readFileSync(path.join(foreignDir, 'commands', 'not-a-plugin.md'), 'utf-8'),
      '# other tool\n'
    );
    assert.equal(path.dirname(foreignDir), getCacheDir());
  });
});

test('a documented GitHub tree URL string carries its ref and subdir', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[plugins.sources]',
        'mono-sub = "https://github.com/org/monorepo/tree/main/plugins/my-plugin"',
      ].join('\n')
    );

    const [source] = getSources();
    assert.equal(source?.remote?.url, 'https://github.com/org/monorepo.git');
    assert.equal(source?.remote?.ref, 'main');
    assert.equal(source?.remote?.subdir, 'plugins/my-plugin');
    assert.equal(
      getSourcesRecord()['mono-sub'],
      path.join(getManagedSourceDir('mono-sub'), 'plugins/my-plugin')
    );
  });
});

test('removing a subtree source reports a managed cache checkout left by a former clone', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);
    addRemoteSource('flipped', { url: bareRepo, type: 'clone' });
    const cacheDir = getManagedSourceDir('flipped');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      ['[plugins.sources.flipped]', `url = "${bareRepo}"`, 'type = "subtree"', 'ref = "main"'].join(
        '\n'
      )
    );

    assert.throws(() => removeSource('flipped'), /managed cache/);
    assert.ok(fs.existsSync(path.join(cacheDir, '.git')));
  });
});

test('marketplace add CLI validates the cached checkout for a file:// Git source', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'cli-fixture'));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(process.cwd(), 'src', 'index.ts'),
        'plugin',
        'marketplace',
        'add',
        `file://${bareRepo}`,
        'cli-cached',
      ],
      { env: { ...process.env, FORCE_COLOR: '0' }, encoding: 'utf-8' }
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(fs.existsSync(path.join(getManagedSourceDir('cli-cached'), 'rules', 'v1.md')));
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'cli-cached')), false);
  });
});
