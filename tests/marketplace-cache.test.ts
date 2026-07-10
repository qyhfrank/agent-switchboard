import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  type MarketplaceEntryCacheRequest,
  materializeMarketplaceEntry,
  refreshMarketplaceEntryCache,
  removeMarketplaceEntryCache,
} from '../src/marketplace/cache.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { withTempAsbHome } from './helpers/tmp.js';

interface GitFixture {
  bareRepo: string;
  workDir: string;
}

function createGitFixture(asbHome: string, name: string): GitFixture {
  const bareRepo = path.join(asbHome, `${name}.git`);
  const workDir = path.join(asbHome, `${name}-work`);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });
  execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: workDir,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workDir, stdio: 'pipe' });
  return { bareRepo, workDir };
}

function commitAndPush(fixture: GitFixture, message: string): string {
  execFileSync('git', ['add', '.'], { cwd: fixture.workDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', message], { cwd: fixture.workDir, stdio: 'pipe' });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: fixture.workDir, stdio: 'pipe' });
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.workDir,
    encoding: 'utf-8',
  }).trim();
}

function writePluginVersion(fixture: GitFixture, version: string): string {
  const pluginRoot = path.join(fixture.workDir, 'packages', 'plugin');
  const skillDir = path.join(pluginRoot, 'skills', 'remote-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'VERSION'), `${version}\n`);
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: remote-skill\ndescription: ${version}\n---\nBody`
  );
  fs.mkdirSync(path.join(fixture.workDir, 'unrelated'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workDir, 'unrelated', `${version}.txt`), version);
  return commitAndPush(fixture, version);
}

function writeMarketplace(
  asbHome: string,
  remoteUrl: string,
  pin: { ref?: string; sha?: string } = {}
): string {
  const marketplaceDir = path.join(asbHome, 'catalog');
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'catalog-manifest',
      plugins: [
        {
          name: 'remote-plugin',
          source: {
            source: 'git-subdir',
            url: remoteUrl,
            path: 'packages/plugin',
            ...pin,
          },
        },
      ],
    })
  );
  fs.writeFileSync(
    path.join(asbHome, 'config.toml'),
    `[plugins.sources]\ncatalog-source = "${marketplaceDir}"\n`
  );
  return marketplaceDir;
}

function materializePlugin(): string {
  const index = buildPluginIndex();
  const plugin = index.get('remote-plugin@catalog-source');
  assert.ok(plugin);
  assert.deepEqual(index.expand([plugin.id]).skills, ['remote-plugin@catalog-source:remote-skill']);
  return plugin.meta.sourcePath;
}

function findGitRoot(start: string): string {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No Git root found above ${start}`);
    current = parent;
  }
}

function materializeInChild(
  asbHome: string,
  request: MarketplaceEntryCacheRequest
): Promise<{ code: number | null; stderr: string }> {
  const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
  const source =
    `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
    'materializeMarketplaceEntry(JSON.parse(process.argv[1]));';
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('git-subdir entries use a state-owned sparse checkout', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    writeMarketplace(asbHome, remote.bareRepo);

    const pluginPath = materializePlugin();
    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const relative = path.relative(cacheRoot, pluginPath);
    const repoRoot = findGitRoot(pluginPath);

    assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false);
    assert.equal(
      fs.existsSync(path.join(asbHome, 'plugins', '.plugin-cache')),
      false,
      'legacy discovery-adjacent cache must not be used'
    );
    assert.equal(fs.existsSync(path.join(repoRoot, 'unrelated')), false);
    assert.equal(
      execFileSync('git', ['sparse-checkout', 'list'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim(),
      'packages/plugin'
    );
  });
});

test('sha and source identity select exact commits without stale reuse', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const v1Sha = writePluginVersion(remote, 'v1');
    const v2Sha = writePluginVersion(remote, 'v2');
    const marketplaceDir = writeMarketplace(asbHome, remote.bareRepo, { sha: v1Sha });

    const v1Path = materializePlugin();
    assert.equal(fs.readFileSync(path.join(v1Path, 'VERSION'), 'utf-8').trim(), 'v1');

    writeMarketplace(asbHome, remote.bareRepo, { sha: v2Sha });
    clearPluginIndexCache();
    const v2Path = materializePlugin();

    assert.equal(fs.readFileSync(path.join(v2Path, 'VERSION'), 'utf-8').trim(), 'v2');
    assert.notEqual(v2Path, v1Path);
    assert.equal(fs.existsSync(v1Path), false);
    assert.equal(fs.existsSync(marketplaceDir), true);
  });
});

test('ref and sha pins must resolve to the same exact commit', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const v1Sha = writePluginVersion(remote, 'v1');
    const v2Sha = writePluginVersion(remote, 'v2');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      sha: v2Sha,
      subdir: 'packages/plugin',
    };

    const materialized = materializeMarketplaceEntry(request);
    assert.equal(materialized.commit, v2Sha);
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v2'
    );

    assert.throws(() => materializeMarketplaceEntry({ ...request, sha: v1Sha }), /pin mismatch/);
    assert.equal(fs.existsSync(materialized.pluginPath), true);
  });
});

test('sha pins require full object IDs', () => {
  withTempAsbHome((asbHome) => {
    assert.throws(
      () =>
        materializeMarketplaceEntry({
          sourceName: 'catalog',
          marketplacePath: path.join(asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(asbHome, 'remote.git'),
          sha: 'abcdef1',
        }),
      /full 40- or 64-character object ID/
    );
    assert.equal(fs.existsSync(path.join(asbHome, 'state')), false);
  });
});

test('failed refresh preserves the last verified generation and removes temporary state', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const materialized = materializeMarketplaceEntry(request);

    assert.throws(
      () =>
        refreshMarketplaceEntryCache(request.sourceName, request.marketplacePath, [
          { ...request, url: path.join(asbHome, 'missing.git') },
        ]),
      /git fetch failed/
    );

    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(materialized.entryPath)).filter((name) => name.startsWith('.')),
      []
    );
  });
});

test('post-switch verification failure restores the prior generation', (t) => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const materialized = materializeMarketplaceEntry(request);
    writePluginVersion(remote, 'v2');

    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      originalRename(from, to);
      if (String(from).includes('.tmp-') && path.resolve(String(to)) === materialized.entryPath) {
        fs.writeFileSync(path.join(materialized.entryPath, 'repo', '.git', 'config'), '[invalid');
      }
    });

    assert.throws(
      () => materializeMarketplaceEntry(request, { refresh: true }),
      /cache verification failed/
    );
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(materialized.entryPath)).filter((name) => name.startsWith('.')),
      []
    );
  });
});

test('materialization recovers an interrupted backup before fetching', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const materialized = materializeMarketplaceEntry(request);
    const backupPath = path.join(path.dirname(materialized.entryPath), '.backup-interrupted');
    fs.renameSync(materialized.entryPath, backupPath);
    fs.renameSync(remote.bareRepo, `${remote.bareRepo}.offline`);

    const recovered = materializeMarketplaceEntry(request);

    assert.equal(recovered.entryPath, materialized.entryPath);
    assert.equal(fs.readFileSync(path.join(recovered.pluginPath, 'VERSION'), 'utf-8').trim(), 'v1');
    assert.equal(fs.existsSync(backupPath), false);
  });
});

test('concurrent materialization publishes one verified generation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-cache-concurrency-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  try {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => materializeInChild(asbHome, request))
    );

    assert.deepEqual(
      results.filter((result) => result.code !== 0),
      []
    );
    const entries = fs
      .readdirSync(path.join(asbHome, 'state', 'marketplace-plugins'), { recursive: true })
      .filter((entry) => String(entry).endsWith('entry.json'));
    assert.equal(entries.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git fetch errors redact credential-bearing query parameters', () => {
  withTempAsbHome((asbHome) => {
    const secret = 'audit-secret-token';
    assert.throws(
      () =>
        materializeMarketplaceEntry({
          sourceName: 'catalog',
          marketplacePath: path.join(asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: `http://127.0.0.1:1/repo.git?access_token=${secret}`,
          ref: 'main',
        }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret)
    );
  });
});

test('refresh reuses a verified immutable sha pin without fetching again', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const sha = writePluginVersion(remote, 'v1');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      sha,
      subdir: 'packages/plugin',
    };
    const materialized = materializeMarketplaceEntry(request);
    fs.renameSync(remote.bareRepo, `${remote.bareRepo}.offline`);

    const result = refreshMarketplaceEntryCache('catalog', request.marketplacePath, [request]);

    assert.deepEqual(result, { refreshed: 1, removed: 0 });
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );
  });
});

test('refresh touches materialized plugins only', () => {
  withTempAsbHome((asbHome) => {
    const firstRemote = createGitFixture(asbHome, 'first-remote');
    const secondRemote = createGitFixture(asbHome, 'second-remote');
    writePluginVersion(firstRemote, 'v1');
    writePluginVersion(secondRemote, 'v1');
    const marketplacePath = path.join(asbHome, 'catalog');
    const first: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath,
      pluginName: 'first-plugin',
      url: firstRemote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const second: MarketplaceEntryCacheRequest = {
      ...first,
      pluginName: 'second-plugin',
      url: secondRemote.bareRepo,
    };
    const materialized = materializeMarketplaceEntry(first);

    const result = refreshMarketplaceEntryCache('catalog', marketplacePath, [first, second]);

    assert.deepEqual(result, { refreshed: 1, removed: 0 });
    assert.deepEqual(
      fs.readdirSync(path.dirname(materialized.entryPath)).filter((name) => !name.startsWith('.')),
      [path.basename(materialized.entryPath)]
    );
  });
});

test('refresh ignores invalid metadata on plugins that were never materialized', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const marketplacePath = path.join(asbHome, 'catalog');
    const selected: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath,
      pluginName: 'selected-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const disabled: MarketplaceEntryCacheRequest = {
      ...selected,
      pluginName: 'disabled-plugin',
      sha: 'abcdef1',
    };
    materializeMarketplaceEntry(selected);

    assert.deepEqual(
      refreshMarketplaceEntryCache('catalog', marketplacePath, [selected, disabled]),
      {
        refreshed: 1,
        removed: 0,
      }
    );
  });
});

test('cache ownership includes the configured source and canonical marketplace root', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const base: Omit<MarketplaceEntryCacheRequest, 'marketplacePath'> = {
      sourceName: 'shared-name',
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const firstRoot = path.join(asbHome, 'catalog-one');
    const secondRoot = path.join(asbHome, 'catalog-two');
    const first = materializeMarketplaceEntry({ ...base, marketplacePath: firstRoot });
    const second = materializeMarketplaceEntry({ ...base, marketplacePath: secondRoot });

    assert.notEqual(first.entryPath, second.entryPath);
    removeMarketplaceEntryCache('shared-name', firstRoot);
    removeMarketplaceEntryCache('shared-name', firstRoot);

    assert.equal(fs.existsSync(first.entryPath), false);
    assert.equal(fs.existsSync(second.entryPath), true);
  });
});

test('cache root symlinks are rejected without touching their target', () => {
  withTempAsbHome((asbHome) => {
    const outside = path.join(path.dirname(asbHome), 'outside-state');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
    fs.symlinkSync(outside, path.join(asbHome, 'state'));

    assert.throws(
      () =>
        materializeMarketplaceEntry({
          sourceName: 'catalog',
          marketplacePath: path.join(asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(asbHome, 'remote.git'),
          ref: 'main',
        }),
      /cache root contains a symbolic link/
    );
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf-8'), 'keep');
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  });
});
