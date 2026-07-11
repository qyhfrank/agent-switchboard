import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { getPluginSourceLocksDir } from '../src/config/paths.js';
import {
  captureMarketplaceCacheLeaseSnapshot,
  type MarketplaceEntryCacheRequest,
  type MarketplaceEntryMaterialization,
  materializeMarketplaceEntry,
  refreshMarketplaceEntryCache,
  releaseMarketplaceCacheLeases,
  releaseMarketplaceCacheLeasesAfter,
  removeMarketplaceEntryCache,
  withMarketplaceSourceLock,
  withTemporaryMarketplaceEntryCache,
} from '../src/marketplace/cache.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { withTempAsbHome } from './helpers/tmp.js';

interface GitFixture {
  bareRepo: string;
  workDir: string;
}

function sourceLockPathForEntry(entryPath: string): string {
  const sourcePath = path.dirname(entryPath);
  return path.join(getPluginSourceLocksDir(), `.${path.basename(sourcePath)}.lock`);
}

function fileIdentity(target: string): { device: string; inode: string } {
  const stat = fs.lstatSync(target, { bigint: true });
  return { device: stat.dev.toString(), inode: stat.ino.toString() };
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
  request: MarketplaceEntryCacheRequest,
  refresh = false,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stderr: string }> {
  const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
  const source =
    `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
    'materializeMarketplaceEntry(JSON.parse(process.argv[1]), { refresh: process.argv[2] === "refresh" });';
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
        JSON.stringify(request),
        refresh ? 'refresh' : 'reuse',
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ASB_HOME: asbHome,
          ASB_AGENTS_HOME: asbHome,
          ...extraEnv,
        },
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

function materializeInChildSync(
  asbHome: string,
  request: MarketplaceEntryCacheRequest,
  timeout = 5_000
): void {
  const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
  const source =
    `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
    'materializeMarketplaceEntry(JSON.parse(process.argv[1]));';
  execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: 'pipe',
      timeout,
    }
  );
}

function interruptReadyMaterialization(
  asbHome: string,
  request: MarketplaceEntryCacheRequest,
  refresh = false
): { intentPath: string; stagePath: string } {
  const wrapperDir = fs.mkdtempSync(path.join(asbHome, 'git-wrapper-'));
  const signalPath = path.join(wrapperDir, 'git-mutated');
  const realGit = fs.realpathSync(execFileSync('which', ['git'], { encoding: 'utf-8' }).trim());
  fs.writeFileSync(
    path.join(wrapperDir, 'git'),
    `#!/usr/bin/env node\n` +
      `const { spawnSync } = require('node:child_process');\n` +
      `const fs = require('node:fs');\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });\n` +
      `if (result.error) throw result.error;\n` +
      `if (result.status !== 0) process.exit(result.status ?? 1);\n` +
      `if (process.argv[2] === 'init') {\n` +
      `  fs.writeFileSync(${JSON.stringify(signalPath)}, 'ready');\n` +
      `  process.kill(process.ppid, 'SIGKILL');\n` +
      `}\n`,
    { mode: 0o755 }
  );
  const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
  const source =
    `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
    `materializeMarketplaceEntry(JSON.parse(process.argv[1]), { refresh: ${refresh} });`;
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ASB_HOME: asbHome,
          ASB_AGENTS_HOME: asbHome,
          PATH: `${wrapperDir}${path.delimiter}${process.env.PATH ?? ''}`,
        },
        stdio: 'pipe',
      }
    )
  );
  assert.equal(fs.readFileSync(signalPath, 'utf-8'), 'ready');

  const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
  const sourceName = fs.readdirSync(cacheRoot).find((name) => !name.startsWith('.'));
  assert.ok(sourceName);
  const sourcePath = path.join(cacheRoot, sourceName);
  const claimName = fs
    .readdirSync(sourcePath)
    .find((name) => name.startsWith('.stage-claim-') && name.endsWith('.json'));
  assert.ok(claimName);
  const intentPath = path.join(sourcePath, claimName);
  const intent = JSON.parse(fs.readFileSync(intentPath, 'utf-8'));
  return { intentPath, stagePath: path.join(sourcePath, intent.stageName) };
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

test('remote-tracking refs are rejected as local checkout state', () => {
  withTempAsbHome((asbHome) => {
    assert.throws(
      () =>
        materializeMarketplaceEntry({
          sourceName: 'catalog',
          marketplacePath: path.join(asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: path.join(asbHome, 'remote.git'),
          ref: 'refs/remotes/origin/main',
        }),
      /remote-tracking ref/
    );
    assert.equal(fs.existsSync(path.join(asbHome, 'state')), false);
  });
});

test('short refs fall back to a same-named tag when no branch exists', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'tagged');
    execFileSync('git', ['tag', 'release-only'], { cwd: remote.workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/tags/release-only'], {
      cwd: remote.workDir,
      stdio: 'pipe',
    });

    const materialized = materializeMarketplaceEntry({
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'release-only',
      subdir: 'packages/plugin',
    });

    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'tagged'
    );
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

test('generation ignores dot-prefixed interrupted stage residue', () => {
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
    const current = materializeMarketplaceEntry(request);
    const currentMetadataPath = path.join(current.entryPath, 'entry.json');
    const currentMetadata = JSON.parse(fs.readFileSync(currentMetadataPath, 'utf-8'));
    const interruptedStage = path.join(path.dirname(current.entryPath), '.tmp-interrupted');
    fs.mkdirSync(interruptedStage);
    fs.writeFileSync(
      path.join(interruptedStage, 'entry.json'),
      `${JSON.stringify({ ...currentMetadata, generation: Number.MAX_SAFE_INTEGER })}\n`
    );
    writePluginVersion(remote, 'v2');

    const refreshed = materializeMarketplaceEntry(request, { refresh: true });
    const refreshedMetadata = JSON.parse(
      fs.readFileSync(path.join(refreshed.entryPath, 'entry.json'), 'utf-8')
    );

    assert.equal(fs.readFileSync(path.join(refreshed.pluginPath, 'VERSION'), 'utf-8'), 'v2\n');
    assert.equal(refreshedMetadata.generation, currentMetadata.generation + 1);
    assert.equal(fs.existsSync(interruptedStage), true);
  });
});

test('retry preserves a pre-claim empty stage replacement', () => {
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
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const source =
      `import fs from 'node:fs';import path from 'node:path';` +
      `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
      `const mkdirSync = fs.mkdirSync.bind(fs);` +
      `fs.mkdirSync = (target, options) => {` +
      `  const result = mkdirSync(target, options);` +
      `  if (path.basename(String(target)).startsWith('.tmp-')) process.kill(process.pid, 'SIGKILL');` +
      `  return result;` +
      `};` +
      'materializeMarketplaceEntry(JSON.parse(process.argv[1]));';

    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ASB_HOME: asbHome,
            ASB_AGENTS_HOME: asbHome,
          },
          stdio: 'pipe',
        }
      )
    );

    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const sourcePath = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]);
    const bindingName = fs
      .readdirSync(sourcePath)
      .find((name) => name.startsWith('.stage-claim-') && name.endsWith('.json.ready'));
    assert.ok(bindingName);
    const bindingPath = path.join(sourcePath, bindingName);
    const binding = JSON.parse(fs.readFileSync(bindingPath, 'utf-8'));
    const claimPath = bindingPath.slice(0, -'.ready'.length);
    const ownedStage = path.join(sourcePath, `.tmp-${binding.token}`);
    assert.equal(binding.version, 0);
    assert.equal(fs.existsSync(claimPath), false);
    assert.deepEqual(fs.readdirSync(ownedStage), []);
    const originalStage = path.join(asbHome, 'original-pre-claim-stage');
    const originalIdentity = fileIdentity(ownedStage);
    fs.renameSync(ownedStage, originalStage);
    fs.mkdirSync(ownedStage);
    assert.notDeepEqual(fileIdentity(ownedStage), originalIdentity);

    const materialized = materializeMarketplaceEntry(request);

    assert.deepEqual(fs.readdirSync(ownedStage), []);
    assert.equal(fs.existsSync(claimPath), false);
    assert.equal(fs.existsSync(bindingPath), true);
    assert.equal(fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
  });
});

test('retry preserves a stage interrupted before binding publication', () => {
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
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const source =
      `import fs from 'node:fs';` +
      `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
      `const ftruncateSync = fs.ftruncateSync.bind(fs);` +
      `fs.ftruncateSync = (descriptor, length) => {` +
      `  ftruncateSync(descriptor, length);` +
      `  process.kill(process.pid, 'SIGKILL');` +
      `};` +
      'materializeMarketplaceEntry(JSON.parse(process.argv[1]));';

    assert.throws(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ASB_HOME: asbHome,
            ASB_AGENTS_HOME: asbHome,
          },
          stdio: 'pipe',
        }
      )
    );

    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const sourcePath = path.join(cacheRoot, fs.readdirSync(cacheRoot)[0]);
    const claimName = fs
      .readdirSync(sourcePath)
      .find((name) => name.startsWith('.stage-claim-') && name.endsWith('.json'));
    assert.ok(claimName);
    const claimPath = path.join(sourcePath, claimName);
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf-8'));
    const bindingPath = `${claimPath}.ready`;
    const stagePath = path.join(sourcePath, claim.stageName);
    assert.deepEqual(claim.binding, fileIdentity(bindingPath));
    assert.equal(fs.readFileSync(bindingPath, 'utf-8'), '');
    assert.deepEqual(fs.readdirSync(stagePath), []);

    const materialized = materializeMarketplaceEntry(request);

    assert.equal(fs.existsSync(claimPath), true);
    assert.equal(fs.existsSync(bindingPath), true);
    assert.deepEqual(fs.readdirSync(stagePath), []);
    assert.equal(fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
  });
});

test('retry preserves an interrupted ready stage without its creation-time identity', () => {
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
    const current = materializeMarketplaceEntry(request);
    releaseMarketplaceCacheLeases();
    const interrupted = interruptReadyMaterialization(asbHome, request, true);
    assert.equal(fs.existsSync(path.join(interrupted.stagePath, 'repo', '.git')), true);
    assert.equal(fs.existsSync(`${interrupted.intentPath}.ready`), true);

    const reused = materializeMarketplaceEntry(request);

    assert.equal(reused.entryPath, current.entryPath);
    assert.equal(fs.existsSync(path.join(interrupted.stagePath, 'repo', '.git')), true);
    assert.equal(fs.existsSync(interrupted.intentPath), true);
    assert.equal(fs.existsSync(`${interrupted.intentPath}.ready`), true);
  });
});

test('retry preserves a claimed empty stage replacement', () => {
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
    const interrupted = interruptReadyMaterialization(asbHome, request);
    const intentPath = interrupted.intentPath;
    const ownedStage = interrupted.stagePath;
    assert.equal(fs.existsSync(path.join(ownedStage, 'repo', '.git')), true);
    assert.equal(fs.existsSync(`${intentPath}.ready`), true);
    assert.equal(fs.existsSync(path.join(ownedStage, '.stage-owner.json')), false);
    fs.renameSync(ownedStage, path.join(asbHome, 'interrupted-stage'));
    fs.mkdirSync(ownedStage);

    const materialized = materializeMarketplaceEntry(request);

    assert.deepEqual(fs.readdirSync(ownedStage), []);
    assert.equal(fs.existsSync(intentPath), true);
    assert.equal(fs.existsSync(`${intentPath}.ready`), true);
    assert.equal(fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
  });
});

test('retry preserves forged mutually consistent ready-stage records', () => {
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
    const interrupted = interruptReadyMaterialization(asbHome, request);
    const bindingPath = `${interrupted.intentPath}.ready`;
    const claim = JSON.parse(fs.readFileSync(interrupted.intentPath, 'utf-8'));

    fs.renameSync(interrupted.intentPath, path.join(asbHome, 'original-ready-claim'));
    fs.renameSync(bindingPath, path.join(asbHome, 'original-ready-binding'));
    fs.renameSync(interrupted.stagePath, path.join(asbHome, 'original-ready-stage'));
    fs.writeFileSync(bindingPath, '{}\n');
    fs.mkdirSync(interrupted.stagePath);
    fs.writeFileSync(path.join(interrupted.stagePath, 'sentinel'), 'keep');
    const bindingIdentity = fileIdentity(bindingPath);
    const stageIdentity = fileIdentity(interrupted.stagePath);
    fs.writeFileSync(
      interrupted.intentPath,
      `${JSON.stringify({
        ...claim,
        binding: bindingIdentity,
        stage: stageIdentity,
      })}\n`
    );
    fs.writeFileSync(
      bindingPath,
      `${JSON.stringify({
        version: 1,
        token: claim.token,
        claim: fileIdentity(interrupted.intentPath),
        stage: stageIdentity,
      })}\n`
    );

    const materialized = materializeMarketplaceEntry(request);

    assert.equal(fs.readFileSync(path.join(interrupted.stagePath, 'sentinel'), 'utf-8'), 'keep');
    assert.equal(fs.existsSync(bindingPath), true);
    assert.equal(fs.existsSync(interrupted.intentPath), true);
    assert.equal(fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
  });
});

test('retry preserves a stage replacement when ready payloads are rewritten in place', () => {
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
    const interrupted = interruptReadyMaterialization(asbHome, request);
    const bindingPath = `${interrupted.intentPath}.ready`;
    const claim = JSON.parse(fs.readFileSync(interrupted.intentPath, 'utf-8'));
    const claimIdentity = fileIdentity(interrupted.intentPath);
    const bindingIdentity = fileIdentity(bindingPath);
    assert.deepEqual(claim.stage, fileIdentity(interrupted.stagePath));

    fs.renameSync(interrupted.stagePath, path.join(asbHome, 'original-ready-stage'));
    fs.mkdirSync(interrupted.stagePath);
    fs.writeFileSync(path.join(interrupted.stagePath, 'sentinel'), 'keep');
    const stageIdentity = fileIdentity(interrupted.stagePath);
    fs.writeFileSync(
      interrupted.intentPath,
      `${JSON.stringify({ ...claim, stage: stageIdentity })}\n`
    );
    fs.writeFileSync(
      bindingPath,
      `${JSON.stringify({
        version: 1,
        token: claim.token,
        claim: claimIdentity,
        stage: stageIdentity,
      })}\n`
    );
    assert.deepEqual(fileIdentity(interrupted.intentPath), claimIdentity);
    assert.deepEqual(fileIdentity(bindingPath), bindingIdentity);

    const materialized = materializeMarketplaceEntry(request);

    assert.equal(fs.readFileSync(path.join(interrupted.stagePath, 'sentinel'), 'utf-8'), 'keep');
    assert.equal(fs.existsSync(bindingPath), true);
    assert.equal(fs.existsSync(interrupted.intentPath), true);
    assert.equal(fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
  });
});

test('stage containment is revalidated before checkout writes', () => {
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
    const outside = path.join(asbHome, 'outside-stage');
    fs.mkdirSync(outside);
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const source =
      `import fs from 'node:fs';import path from 'node:path';` +
      `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
      `const lstatSync = fs.lstatSync.bind(fs);let stageChecks = 0;` +
      `fs.lstatSync = (target, options) => {` +
      `  const stat = lstatSync(target, options);` +
      `  if (path.basename(String(target)).startsWith('.tmp-') && ++stageChecks === 2) {` +
      `    fs.renameSync(target, path.join(${JSON.stringify(asbHome)}, 'captured-stage'));` +
      `    fs.symlinkSync(${JSON.stringify(outside)}, target, 'dir');` +
      `  }` +
      `  return stat;` +
      `};` +
      `materializeMarketplaceEntry(JSON.parse(process.argv[1]));`;

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
          {
            cwd: process.cwd(),
            env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
            stdio: 'pipe',
          }
        ),
      /Marketplace cache path contains a symbolic link/
    );
    assert.equal(fs.existsSync(path.join(outside, 'repo')), false);
  });
});

test('checkout requires a freshly created owned repository directory', () => {
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
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const source =
      `import fs from 'node:fs';import path from 'node:path';` +
      `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
      `const lstatSync = fs.lstatSync.bind(fs);let stageChecks = 0;` +
      `fs.lstatSync = (target, options) => {` +
      `  const stat = lstatSync(target, options);` +
      `  if (path.basename(String(target)).startsWith('.tmp-') && ++stageChecks === 2) {` +
      `    const repoPath = path.join(String(target), 'repo');` +
      `    fs.mkdirSync(repoPath);` +
      `    fs.writeFileSync(path.join(repoPath, 'sentinel'), 'keep');` +
      `  }` +
      `  return stat;` +
      `};` +
      `materializeMarketplaceEntry(JSON.parse(process.argv[1]));`;

    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', source, JSON.stringify(request)],
          {
            cwd: process.cwd(),
            env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
            stdio: 'pipe',
          }
        ),
      /EEXIST/
    );
  });
});

test('publication rejects a replacement of the captured stage identity', () => {
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
    let ownerChecks = 0;
    let replacementStage = '';
    const ownerIsCurrent = () => {
      ownerChecks++;
      if (ownerChecks === 2) {
        const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
        const sourceName = fs.readdirSync(cacheRoot).find((name) => !name.startsWith('.'));
        assert.ok(sourceName);
        const sourcePath = path.join(cacheRoot, sourceName);
        const stageName = fs.readdirSync(sourcePath).find((name) => name.startsWith('.tmp-'));
        assert.ok(stageName);
        replacementStage = path.join(sourcePath, stageName);
        const capturedStage = path.join(asbHome, 'captured-publish-stage');
        fs.renameSync(replacementStage, capturedStage);
        fs.cpSync(capturedStage, replacementStage, { recursive: true });
        fs.writeFileSync(path.join(replacementStage, 'sentinel'), 'keep');
      }
      return true;
    };

    assert.throws(
      () => materializeMarketplaceEntry(request, { ownerIsCurrent }),
      /Marketplace cache stage changed/
    );

    assert.equal(ownerChecks, 2);
    assert.equal(fs.readFileSync(path.join(replacementStage, 'sentinel'), 'utf-8'), 'keep');
    assert.deepEqual(
      fs.readdirSync(path.dirname(replacementStage)).filter((name) => !name.startsWith('.')),
      []
    );
  });
});

test('cache hits rebuild selected checkout after Git-visible or hidden tampering', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const tamperCases: Array<{
      name: string;
      apply: (materialized: MarketplaceEntryMaterialization) => void;
    }> = [
      {
        name: 'tracked-worktree',
        apply: ({ pluginPath }) => fs.writeFileSync(path.join(pluginPath, 'VERSION'), 'tampered\n'),
      },
      {
        name: 'staged-index',
        apply: ({ repoPath, pluginPath }) => {
          fs.writeFileSync(path.join(pluginPath, 'VERSION'), 'tampered\n');
          execFileSync('git', ['add', '--', 'packages/plugin/VERSION'], {
            cwd: repoPath,
            stdio: 'pipe',
          });
        },
      },
      {
        name: 'untracked',
        apply: ({ pluginPath }) => fs.writeFileSync(path.join(pluginPath, 'untracked.txt'), 'bad'),
      },
      {
        name: 'ignored',
        apply: ({ repoPath, pluginPath }) => {
          fs.appendFileSync(
            path.join(repoPath, '.git', 'info', 'exclude'),
            'packages/plugin/ignored.txt\n'
          );
          fs.writeFileSync(path.join(pluginPath, 'ignored.txt'), 'bad');
        },
      },
      {
        name: 'assume-unchanged',
        apply: ({ repoPath, pluginPath }) => {
          execFileSync('git', ['update-index', '--assume-unchanged', 'packages/plugin/VERSION'], {
            cwd: repoPath,
            stdio: 'pipe',
          });
          fs.writeFileSync(path.join(pluginPath, 'VERSION'), 'tampered\n');
        },
      },
      {
        name: 'skip-worktree',
        apply: ({ repoPath, pluginPath }) => {
          execFileSync('git', ['update-index', '--skip-worktree', 'packages/plugin/VERSION'], {
            cwd: repoPath,
            stdio: 'pipe',
          });
          fs.writeFileSync(path.join(pluginPath, 'VERSION'), 'tampered\n');
        },
      },
    ];

    for (const tamper of tamperCases) {
      const request: MarketplaceEntryCacheRequest = {
        sourceName: 'catalog',
        marketplacePath: path.join(asbHome, 'catalog'),
        pluginName: `remote-plugin-${tamper.name}`,
        url: remote.bareRepo,
        ref: 'main',
        subdir: 'packages/plugin',
      };
      const first = materializeMarketplaceEntry(request);
      const firstGeneration = JSON.parse(
        fs.readFileSync(path.join(first.entryPath, 'entry.json'), 'utf-8')
      ).generation;
      tamper.apply(first);

      const rebuilt = materializeMarketplaceEntry(request);

      assert.equal(
        JSON.parse(fs.readFileSync(path.join(rebuilt.entryPath, 'entry.json'), 'utf-8')).generation,
        firstGeneration + 1,
        tamper.name
      );
      assert.equal(
        fs.readFileSync(path.join(rebuilt.pluginPath, 'VERSION'), 'utf-8'),
        'v1\n',
        tamper.name
      );
      assert.equal(
        execFileSync(
          'git',
          [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            ':(literal)packages/plugin',
          ],
          { cwd: rebuilt.repoPath, encoding: 'utf-8' }
        ),
        '',
        tamper.name
      );
      assert.match(
        execFileSync('git', ['ls-files', '-v', '--', ':(literal)packages/plugin'], {
          cwd: rebuilt.repoPath,
          encoding: 'utf-8',
        }),
        /^(?:H .+\n)+$/,
        tamper.name
      );
    }
  });
});

test('cache hits bind persisted selector metadata to the normalized request', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const sha = writePluginVersion(remote, 'v1');
    const tamperCases = [
      ['ref', 'forged-ref'],
      ['sha', '0'.repeat(40)],
      ['subdir', 'packages'],
    ] as const;

    for (const [field, forgedValue] of tamperCases) {
      const request: MarketplaceEntryCacheRequest = {
        sourceName: 'catalog',
        marketplacePath: path.join(asbHome, 'catalog'),
        pluginName: `remote-plugin-${field}`,
        url: remote.bareRepo,
        ref: 'main',
        sha,
        subdir: 'packages/plugin',
      };
      const first = materializeMarketplaceEntry(request);
      const metadataPath = path.join(first.entryPath, 'entry.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify({ ...metadata, [field]: forgedValue }, null, 2)}\n`
      );

      const rebuilt = materializeMarketplaceEntry(request);
      const rebuiltMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));

      assert.equal(rebuiltMetadata.generation, metadata.generation + 1, field);
      assert.equal(rebuiltMetadata[field], request[field], field);
      assert.equal(rebuilt.commit, sha, field);
    }
  });
});

test('sha-pinned cache hits require HEAD itself to equal the full pin', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const v1Sha = writePluginVersion(remote, 'v1');
    const v2Sha = writePluginVersion(remote, 'v2');
    const request: MarketplaceEntryCacheRequest = {
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      sha: v1Sha,
      subdir: 'packages/plugin',
    };
    const first = materializeMarketplaceEntry(request);
    const metadataPath = path.join(first.entryPath, 'entry.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    execFileSync('git', ['fetch', '--depth', '1', 'origin', v2Sha], {
      cwd: first.repoPath,
      stdio: 'pipe',
    });
    execFileSync('git', ['checkout', '--detach', v2Sha], { cwd: first.repoPath, stdio: 'pipe' });
    fs.writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, commit: v2Sha }, null, 2)}\n`);

    const rebuilt = materializeMarketplaceEntry(request);

    assert.equal(rebuilt.commit, v1Sha);
    assert.equal(fs.readFileSync(path.join(rebuilt.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
    assert.equal(
      JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation,
      metadata.generation + 1
    );
  });
});

test('ref-only and default-ref cache hits bind HEAD to the fetched commit', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    const mainSha = writePluginVersion(remote, 'main');
    execFileSync('git', ['checkout', '-b', 'side'], { cwd: remote.workDir, stdio: 'pipe' });
    const sideSha = writePluginVersion(remote, 'side-only');
    execFileSync('git', ['push', 'origin', 'side'], { cwd: remote.workDir, stdio: 'pipe' });
    execFileSync('git', ['checkout', 'main'], { cwd: remote.workDir, stdio: 'pipe' });

    for (const selector of [
      { name: 'ref-only', ref: 'main' },
      { name: 'default-ref', ref: undefined },
    ]) {
      const request: MarketplaceEntryCacheRequest = {
        sourceName: 'catalog',
        marketplacePath: path.join(asbHome, 'catalog'),
        pluginName: `remote-plugin-${selector.name}`,
        url: remote.bareRepo,
        ref: selector.ref,
        subdir: 'packages/plugin',
      };
      const first = materializeMarketplaceEntry(request);
      const metadataPath = path.join(first.entryPath, 'entry.json');
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      execFileSync('git', ['fetch', '--depth', '1', 'origin', sideSha], {
        cwd: first.repoPath,
        stdio: 'pipe',
      });
      execFileSync('git', ['checkout', '--detach', sideSha], {
        cwd: first.repoPath,
        stdio: 'pipe',
      });
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify({ ...metadata, commit: sideSha }, null, 2)}\n`
      );

      const rebuilt = materializeMarketplaceEntry(request);

      assert.equal(rebuilt.commit, mainSha, selector.name);
      assert.equal(
        fs.readFileSync(path.join(rebuilt.pluginPath, 'VERSION'), 'utf-8'),
        'main\n',
        selector.name
      );
      assert.equal(
        JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation,
        metadata.generation + 1,
        selector.name
      );

      const offlineRepo = `${remote.bareRepo}.${selector.name}.offline`;
      fs.renameSync(remote.bareRepo, offlineRepo);
      try {
        assert.equal(materializeMarketplaceEntry(request).commit, mainSha, selector.name);
      } finally {
        fs.renameSync(offlineRepo, remote.bareRepo);
      }
    }
  });
});

test('cache hits bind Git to the expected worktree root', () => {
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
    const first = materializeMarketplaceEntry(request);
    const metadataPath = path.join(first.entryPath, 'entry.json');
    const generation = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation;
    const shadow = path.join(asbHome, 'shadow-worktree');
    fs.cpSync(first.pluginPath, path.join(shadow, 'packages', 'plugin'), { recursive: true });
    execFileSync('git', ['config', 'core.worktree', shadow], {
      cwd: first.repoPath,
      stdio: 'pipe',
    });
    fs.writeFileSync(path.join(first.pluginPath, 'VERSION'), 'tampered\n');

    const rebuilt = materializeMarketplaceEntry(request);

    assert.equal(fs.readFileSync(path.join(rebuilt.pluginPath, 'VERSION'), 'utf-8'), 'v1\n');
    assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation, generation + 1);
    assert.equal(
      fs.realpathSync.native(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: rebuilt.repoPath,
          encoding: 'utf-8',
        }).trim()
      ),
      fs.realpathSync.native(rebuilt.repoPath)
    );
  });
});

test('cache hits require the Git directory at repoPath/.git', () => {
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
    const first = materializeMarketplaceEntry(request);
    const metadataPath = path.join(first.entryPath, 'entry.json');
    const generation = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation;
    const movedGitDir = path.join(asbHome, 'moved-git-dir');
    fs.renameSync(path.join(first.repoPath, '.git'), movedGitDir);
    fs.writeFileSync(path.join(first.repoPath, '.git'), `gitdir: ${movedGitDir}\n`);

    const rebuilt = materializeMarketplaceEntry(request);

    assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf-8')).generation, generation + 1);
    assert.equal(fs.lstatSync(path.join(rebuilt.repoPath, '.git')).isDirectory(), true);
    assert.equal(
      fs.realpathSync.native(
        execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
          cwd: rebuilt.repoPath,
          encoding: 'utf-8',
        }).trim()
      ),
      fs.realpathSync.native(path.join(rebuilt.repoPath, '.git'))
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

test('persistent backup cleanup failure keeps the verified replacement readable', (t) => {
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

    const originalRemove = fs.rmSync.bind(fs);
    t.mock.method(fs, 'rmSync', (target, options) => {
      if (path.basename(String(target)).startsWith('.backup-')) {
        throw new Error('injected backup cleanup failure');
      }
      return originalRemove(target, options);
    });

    const refreshed = materializeMarketplaceEntry(request, { refresh: true });

    assert.equal(fs.readFileSync(path.join(refreshed.pluginPath, 'VERSION'), 'utf-8').trim(), 'v2');
    assert.equal(refreshed.entryPath, materialized.entryPath);
    fs.renameSync(remote.bareRepo, `${remote.bareRepo}.offline`);
    const reused = materializeMarketplaceEntry(request);
    assert.equal(reused.entryPath, materialized.entryPath);
    assert.equal(
      fs
        .readdirSync(path.dirname(materialized.entryPath))
        .some((name) => name.startsWith('.backup-')),
      true
    );
  });
});

test('cache hits remove unreadable internal backups', () => {
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
    const corruptBackup = path.join(path.dirname(materialized.entryPath), '.backup-corrupt');
    fs.mkdirSync(corruptBackup);
    fs.writeFileSync(path.join(corruptBackup, 'partial'), 'derived');

    const reused = materializeMarketplaceEntry(request);

    assert.equal(reused.entryPath, materialized.entryPath);
    assert.equal(fs.existsSync(corruptBackup), false);
  });
});

test('backup recovery restores the newest verified generation', () => {
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
    const first = materializeMarketplaceEntry(request);
    const snapshots = path.join(asbHome, 'snapshots');
    fs.mkdirSync(snapshots);
    fs.cpSync(first.entryPath, path.join(snapshots, 'v1'), { recursive: true });
    writePluginVersion(remote, 'v2');
    const second = materializeMarketplaceEntry(request, { refresh: true });
    fs.cpSync(second.entryPath, path.join(snapshots, 'v2'), { recursive: true });
    writePluginVersion(remote, 'v3');
    const third = materializeMarketplaceEntry(request, { refresh: true });
    const sourcePath = path.dirname(third.entryPath);
    fs.cpSync(path.join(snapshots, 'v1'), path.join(sourcePath, '.backup-1'), {
      recursive: true,
    });
    fs.cpSync(path.join(snapshots, 'v2'), path.join(sourcePath, '.backup-2'), {
      recursive: true,
    });
    fs.renameSync(third.entryPath, path.join(sourcePath, '.backup-3'));
    fs.renameSync(remote.bareRepo, `${remote.bareRepo}.offline`);

    const recovered = materializeMarketplaceEntry(request);

    assert.equal(fs.readFileSync(path.join(recovered.pluginPath, 'VERSION'), 'utf-8').trim(), 'v3');
    assert.deepEqual(
      fs.readdirSync(sourcePath).filter((name) => name.startsWith('.backup-')),
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

test('materialization cleans an interrupted backup after request identity changes', () => {
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

    const changed = materializeMarketplaceEntry({ ...request, ref: 'HEAD' });

    assert.equal(fs.existsSync(changed.entryPath), true);
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

test('source lock publishes its owner before the live lock path', (t) => {
  withTempAsbHome((asbHome) => {
    const lockRoot = getPluginSourceLocksDir();
    const originalWrite = fs.writeFileSync.bind(fs);
    let ownerObserved = false;
    t.mock.method(fs, 'writeFileSync', (target, data, options) => {
      if (
        path.dirname(String(target)) === lockRoot &&
        path.basename(String(target)).endsWith('.tmp')
      ) {
        ownerObserved = true;
        const liveLocks = fs.existsSync(lockRoot)
          ? fs.readdirSync(lockRoot).filter((entry) => entry.endsWith('.lock'))
          : [];
        assert.deepEqual(liveLocks, []);
      }
      return originalWrite(target, data, options);
    });

    withMarketplaceSourceLock('atomic-lock', path.join(asbHome, 'catalog'), () => {});

    assert.equal(ownerObserved, true);
  });
});

test('lease rollback releases only locks acquired after its snapshot', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const base: Omit<MarketplaceEntryCacheRequest, 'marketplacePath'> = {
      sourceName: 'catalog',
      pluginName: 'remote-plugin',
      url: remote.bareRepo,
      ref: 'main',
      subdir: 'packages/plugin',
    };
    const first = materializeMarketplaceEntry({
      ...base,
      marketplacePath: path.join(asbHome, 'catalog-one'),
    });
    const firstLock = sourceLockPathForEntry(first.entryPath);
    const snapshot = captureMarketplaceCacheLeaseSnapshot();
    const second = materializeMarketplaceEntry({
      ...base,
      marketplacePath: path.join(asbHome, 'catalog-two'),
    });
    const secondLock = sourceLockPathForEntry(second.entryPath);
    assert.equal(fs.existsSync(firstLock), true);
    assert.equal(fs.existsSync(secondLock), true);

    releaseMarketplaceCacheLeasesAfter(snapshot);

    assert.equal(fs.existsSync(firstLock), true);
    assert.equal(fs.existsSync(secondLock), false);
    releaseMarketplaceCacheLeases();
    assert.equal(fs.existsSync(firstLock), false);
  });
});

test('lease rollback releases a replacement lease at the same lock path', () => {
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
    const first = materializeMarketplaceEntry(request);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    const firstOwner = JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token;
    const snapshot = captureMarketplaceCacheLeaseSnapshot();
    withMarketplaceSourceLock(request.sourceName, request.marketplacePath, () => {});
    materializeMarketplaceEntry(request);
    assert.notEqual(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token, firstOwner);

    releaseMarketplaceCacheLeasesAfter(snapshot);

    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('temporary cache cleanup preserves untouched leases and releases replacements', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-cache-temporary-lease-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
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
    const materialized = materializeMarketplaceEntry(request);
    const lockPath = sourceLockPathForEntry(materialized.entryPath);
    assert.equal(fs.existsSync(lockPath), true);

    await withTemporaryMarketplaceEntryCache(async () => {});

    assert.equal(fs.existsSync(lockPath), true);

    await withTemporaryMarketplaceEntryCache(async () => {
      withMarketplaceSourceLock(request.sourceName, request.marketplacePath, () => {});
      materializeMarketplaceEntry(request);
    });

    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    releaseMarketplaceCacheLeases();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale lock recovery rejects a reused PID with a different process identity', () => {
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
    const first = materializeMarketplaceEntry(request);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    releaseMarketplaceCacheLeases();
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        token: 'stale-owner',
        pid: process.pid,
        startedAt: Date.now() - 300_000,
        processIdentity: 'ps-lstart-utc-v1:different process birth',
      })}\n`
    );

    const recovered = materializeMarketplaceEntry(request);

    assert.equal(recovered.entryPath, first.entryPath);
    assert.notEqual(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).token, 'stale-owner');
  });
});

test('stale ownerless lock directories recover without resetting their age', () => {
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
    const first = materializeMarketplaceEntry(request);
    const sourcePath = path.dirname(first.entryPath);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    releaseMarketplaceCacheLeases();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    fs.writeFileSync(lockPath, '');
    const staleTime = new Date(Date.now() - 300_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    assert.doesNotThrow(() => materializeInChildSync(asbHome, request));
  });
});

test('ownerless stale locks recover after a recovery claimant crashes', () => {
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
    const first = materializeMarketplaceEntry(request);
    const sourcePath = path.dirname(first.entryPath);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    const claimPath = `${lockPath}.recovering`;
    releaseMarketplaceCacheLeases();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    fs.writeFileSync(lockPath, '');
    const staleTime = new Date(Date.now() - 300_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    fs.writeFileSync(
      claimPath,
      `${JSON.stringify({
        token: 'dead-claim',
        pid: 99_999_999,
        startedAt: Date.now() - 300_000,
        processIdentity: 'ps-lstart-utc-v1:dead process',
      })}\n`
    );

    assert.doesNotThrow(() => materializeInChildSync(asbHome, request));
    assert.equal(fs.existsSync(claimPath), false);
  });
});

test('stale recovery rejects a symlinked claim directory without touching its target', () => {
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
    const first = materializeMarketplaceEntry(request);
    const sourcePath = path.dirname(first.entryPath);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    releaseMarketplaceCacheLeases();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        token: 'dead-owner',
        pid: 99_999_999,
        startedAt: Date.now() - 300_000,
        processIdentity: 'ps-lstart-utc-v1:dead process',
      })}\n`
    );
    const outside = path.join(path.dirname(asbHome), 'outside-claim');
    const victim = path.join(outside, 'victim.json');
    fs.mkdirSync(outside);
    fs.writeFileSync(
      victim,
      `${JSON.stringify({
        token: 'victim',
        pid: 99_999_999,
        startedAt: Date.now() - 300_000,
        processIdentity: 'ps-lstart-utc-v1:dead process',
      })}\n`
    );
    fs.symlinkSync(outside, `${lockPath}.recovering`);

    assert.throws(() => materializeInChildSync(asbHome, request), /symbolic link/);
    assert.equal(fs.existsSync(victim), true);
  });
});

test('concurrent stale lock recovery admits one cache publisher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-cache-stale-lock-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
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
    const first = materializeMarketplaceEntry(request);
    const sourcePath = path.dirname(first.entryPath);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    releaseMarketplaceCacheLeases();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    const deadOwner = spawn(process.execPath, ['--eval', '']);
    const deadPid = deadOwner.pid;
    await new Promise<void>((resolve, reject) => {
      deadOwner.on('error', reject);
      deadOwner.on('close', () => resolve());
    });
    assert.ok(deadPid);
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        token: 'dead-owner',
        pid: deadPid,
        startedAt: Date.now() - 300_000,
        processIdentity: 'ps-lstart-utc-v1:dead process',
      })}\n`
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => materializeInChild(asbHome, request))
    );

    assert.deepEqual(
      results.filter((result) => result.code !== 0),
      []
    );
    assert.equal(
      fs
        .readdirSync(path.join(asbHome, 'state', 'marketplace-plugins'), { recursive: true })
        .filter((entry) => String(entry).endsWith('entry.json')).length,
      1
    );
  } finally {
    releaseMarketplaceCacheLeases();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent stale recovery-claim takeover preserves one publisher', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-cache-stale-claim-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
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
    const first = materializeMarketplaceEntry(request);
    const sourcePath = path.dirname(first.entryPath);
    const lockPath = sourceLockPathForEntry(first.entryPath);
    const claimPath = `${lockPath}.recovering`;
    releaseMarketplaceCacheLeases();
    fs.rmSync(sourcePath, { recursive: true, force: true });
    const deadOwner = spawn(process.execPath, ['--eval', '']);
    const deadPid = deadOwner.pid;
    await new Promise<void>((resolve, reject) => {
      deadOwner.on('error', reject);
      deadOwner.on('close', () => resolve());
    });
    assert.ok(deadPid);
    const staleMetadata = {
      token: 'dead-owner',
      pid: deadPid,
      startedAt: Date.now() - 300_000,
      processIdentity: 'ps-lstart-utc-v1:dead process',
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(staleMetadata)}\n`);
    fs.writeFileSync(
      claimPath,
      `${JSON.stringify({ ...staleMetadata, token: 'dead-claim', lockToken: 'dead-owner' })}\n`
    );

    const results = await Promise.all(
      Array.from({ length: 5 }, () => materializeInChild(asbHome, request))
    );

    assert.deepEqual(
      results.filter((result) => result.code !== 0),
      []
    );
    assert.equal(fs.existsSync(claimPath), false);
    assert.equal(
      fs
        .readdirSync(path.join(asbHome, 'state', 'marketplace-plugins'), { recursive: true })
        .filter((entry) => String(entry).endsWith('entry.json')).length,
      1
    );
  } finally {
    releaseMarketplaceCacheLeases();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a reader lease blocks cross-timezone refresh until the consuming process exits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-cache-reader-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const children: Array<ReturnType<typeof spawn>> = [];
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
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const readerSource =
      `import { materializeMarketplaceEntry } from ${JSON.stringify(cacheModule)};` +
      'const result = materializeMarketplaceEntry(JSON.parse(process.argv[1]));' +
      'process.stdout.write(JSON.stringify(result) + "\\n");' +
      'process.stdin.resume();';
    const reader = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', readerSource, JSON.stringify(request)],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ASB_HOME: asbHome,
          ASB_AGENTS_HOME: asbHome,
          TZ: 'Asia/Hong_Kong',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.push(reader);
    reader.stdout.setEncoding('utf-8');
    const materialized = await new Promise<MarketplaceEntryMaterialization>((resolve, reject) => {
      let output = '';
      reader.stdout.on('data', (chunk) => {
        output += chunk;
        const newline = output.indexOf('\n');
        if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)));
      });
      reader.on('error', reject);
      reader.on('close', (code) => {
        if (!output.includes('\n')) reject(new Error(`reader exited before ready: ${code}`));
      });
    });
    writePluginVersion(remote, 'v2');

    let refreshFinished = false;
    const refresh = materializeInChild(asbHome, request, true, { TZ: 'UTC' }).then((result) => {
      refreshFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    assert.equal(refreshFinished, false);
    assert.equal(
      fs.readFileSync(path.join(materialized.pluginPath, 'VERSION'), 'utf-8').trim(),
      'v1'
    );

    reader.stdin.end();
    const result = await refresh;
    assert.equal(result.code, 0, result.stderr);
  } finally {
    for (const child of children) child.kill('SIGKILL');
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

test('git fetch errors redact credential-bearing URL fragments', () => {
  withTempAsbHome((asbHome) => {
    const secret = 'audit-secret-fragment';
    assert.throws(
      () =>
        materializeMarketplaceEntry({
          sourceName: 'catalog',
          marketplacePath: path.join(asbHome, 'catalog'),
          pluginName: 'remote-plugin',
          url: `http://127.0.0.1:1/repo.git#access_token=${secret}`,
          ref: 'main',
        }),
      (error: unknown) => error instanceof Error && !error.message.includes(secret)
    );
  });
});

test('successful sparse fetch does not persist URL credentials', () => {
  withTempAsbHome((asbHome) => {
    const remote = createGitFixture(asbHome, 'plugin-remote');
    writePluginVersion(remote, 'v1');
    const secret = 'audit-secret-password';
    const materialized = materializeMarketplaceEntry({
      sourceName: 'catalog',
      marketplacePath: path.join(asbHome, 'catalog'),
      pluginName: 'remote-plugin',
      url: `file://audit-user:${secret}@localhost${remote.bareRepo}`,
      ref: 'main',
      subdir: 'packages/plugin',
    });

    const gitDir = path.join(materialized.repoPath, '.git');
    const gitConfig = fs.readFileSync(path.join(gitDir, 'config'), 'utf-8');
    assert.doesNotMatch(gitConfig, /audit-user/);
    assert.doesNotMatch(gitConfig, new RegExp(secret));
    for (const relative of fs.readdirSync(gitDir, { recursive: true })) {
      const candidate = path.join(gitDir, String(relative));
      if (!fs.lstatSync(candidate).isFile()) continue;
      const content = fs.readFileSync(candidate);
      assert.equal(content.includes(secret), false, `secret persisted in ${relative}`);
    }
    assert.equal(fs.existsSync(path.join(gitDir, 'FETCH_HEAD')), false);
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
