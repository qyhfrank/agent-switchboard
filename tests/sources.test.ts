import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  getMarketplacePluginCacheDir,
  getPluginSourceLocksDir,
  getPluginSourceStateDir,
  getPluginsDir,
  getProfileConfigPath,
  getProjectConfigPath,
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
import { withTemporaryMarketplaceEntryCache } from '../src/marketplace/cache.js';
import { credentialFreeGitUrl, normalizeGitIdentity } from '../src/marketplace/git-identity.js';
import { buildPluginIndex, clearPluginIndexCache } from '../src/plugins/index.js';
import { withTempAsbHome } from './helpers/tmp.js';

async function waitForReadyFiles(
  paths: string[],
  minimum: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (paths.filter((filePath) => fs.existsSync(filePath)).length < minimum) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── URL detection ──────────────────────────────────────────────────

test('isGitUrl detects HTTPS URLs', () => {
  assert.equal(isGitUrl('https://github.com/org/repo'), true);
  assert.equal(isGitUrl('http://example.com/repo.git'), true);
});

test('isGitUrl detects SSH and git protocol URLs', () => {
  assert.equal(isGitUrl('git@github.com:org/repo.git'), true);
  assert.equal(isGitUrl('ssh://git@github.com/org/repo'), true);
  assert.equal(isGitUrl('git://example.com/repo.git'), true);
});

test('isGitUrl rejects local paths', () => {
  assert.equal(isGitUrl('/usr/local/lib'), false);
  assert.equal(isGitUrl('./relative/path'), false);
  assert.equal(isGitUrl('relative/path'), false);
});

// ── GitHub URL parsing ─────────────────────────────────────────────

test('parseGitUrl extracts bare GitHub repo URL', () => {
  const result = parseGitUrl('https://github.com/org/repo');
  assert.deepEqual(result, { url: 'https://github.com/org/repo.git' });
});

test('parseGitUrl handles .git suffix on GitHub URL', () => {
  const result = parseGitUrl('https://github.com/org/repo.git');
  assert.deepEqual(result, { url: 'https://github.com/org/repo.git' });
});

test('parseGitUrl handles trailing slash', () => {
  const result = parseGitUrl('https://github.com/org/repo/');
  assert.deepEqual(result, { url: 'https://github.com/org/repo.git' });
});

test('parseGitUrl extracts ref from /tree/branch', () => {
  const result = parseGitUrl('https://github.com/org/repo/tree/main');
  assert.deepEqual(result, { url: 'https://github.com/org/repo.git', ref: 'main' });
});

test('parseGitUrl extracts ref and subdir from /tree/branch/subdir', () => {
  const result = parseGitUrl('https://github.com/org/repo/tree/main/lib/asb');
  assert.deepEqual(result, {
    url: 'https://github.com/org/repo.git',
    ref: 'main',
    subdir: 'lib/asb',
  });
});

test('parseGitUrl passes through non-GitHub URLs unchanged', () => {
  const result = parseGitUrl('https://gitlab.com/org/repo.git');
  assert.deepEqual(result, { url: 'https://gitlab.com/org/repo.git' });
});

test('parseGitUrl passes through SSH URLs unchanged', () => {
  const result = parseGitUrl('git@github.com:org/repo.git');
  assert.deepEqual(result, { url: 'git@github.com:org/repo.git' });
});

// ── Name inference ─────────────────────────────────────────────────

test('inferSourceName extracts repo name from GitHub HTTPS URL', () => {
  assert.equal(inferSourceName('https://github.com/org/my-repo'), 'my-repo');
  assert.equal(inferSourceName('https://github.com/org/my-repo.git'), 'my-repo');
});

test('inferSourceName extracts repo name from GitHub tree URL', () => {
  assert.equal(inferSourceName('https://github.com/org/repo/tree/main/sub'), 'repo');
});

test('inferSourceName extracts repo name from SSH URL', () => {
  assert.equal(inferSourceName('git@github.com:org/my-lib.git'), 'my-lib');
});

test('inferSourceName uses basename for local paths', () => {
  assert.equal(inferSourceName('/path/to/team-library'), 'team-library');
  assert.equal(inferSourceName('./relative/my-lib'), 'my-lib');
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

test('source addition collision checks stay bound to the locked config target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-add-config-target-'));
  const asbHome = path.join(root, 'asb-home');
  const originalConfig = path.join(root, 'original.toml');
  const retargetedConfig = path.join(root, 'retargeted.toml');
  const configCarrier = path.join(root, 'config.toml');
  const libraryPath = path.join(root, 'library');
  const readyPath = path.join(root, 'holder.ready');
  const releasePath = path.join(root, 'holder.release');
  fs.mkdirSync(path.join(libraryPath, 'rules'), { recursive: true });
  fs.mkdirSync(asbHome, { recursive: true });
  fs.writeFileSync(originalConfig, '[plugins]\nenabled = []\n');
  fs.writeFileSync(retargetedConfig, '[plugins.sources]\nlocked-target = "/foreign/source"\n');
  fs.symlinkSync(originalConfig, configCarrier);
  const configModule = pathToFileURL(path.resolve('src/config/layered-config.ts')).href;
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const env = {
    ...process.env,
    ASB_HOME: asbHome,
    ASB_AGENTS_HOME: asbHome,
    ASB_CONFIG: configCarrier,
  };
  const holder = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `import fs from "node:fs";import { withConfigFileTransaction } from ${JSON.stringify(configModule)};withConfigFileTransaction(${JSON.stringify(originalConfig)},()=>{fs.writeFileSync(${JSON.stringify(readyPath)},"ready");while(!fs.existsSync(${JSON.stringify(releasePath)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);});`,
    ],
    { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let adder: ReturnType<typeof spawn> | undefined;
  try {
    await waitForReadyFiles([readyPath], 1, 10_000);
    assert.equal(fs.existsSync(readyPath), true);
    adder = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { addLocalSource } from ${JSON.stringify(sourcesModule)};addLocalSource("locked-target",${JSON.stringify(libraryPath)});`,
      ],
      { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const preparedPrefix = '.original.toml.asb-lock.';
    const deadline = Date.now() + 10_000;
    while (!fs.readdirSync(root).some((name) => name.startsWith(preparedPrefix))) {
      if (adder.exitCode !== null) break;
      if (Date.now() >= deadline)
        throw new Error('source addition did not wait on the config lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(adder.exitCode, null);

    fs.rmSync(configCarrier);
    fs.symlinkSync(retargetedConfig, configCarrier);
    const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));
    const adderClosed = new Promise<number | null>((resolve) => adder?.once('close', resolve));
    fs.writeFileSync(releasePath, 'release');
    const [holderCode, adderCode] = await Promise.all([holderClosed, adderClosed]);

    assert.equal(holderCode, 0);
    assert.equal(adderCode, 0);
    assert.match(fs.readFileSync(originalConfig, 'utf-8'), new RegExp(libraryPath));
    assert.match(fs.readFileSync(retargetedConfig, 'utf-8'), /\/foreign\/source/);
  } finally {
    holder.kill('SIGKILL');
    adder?.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('config transactions preserve concurrent updates from different processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-config-concurrency-'));
  const asbHome = path.join(root, 'asb-home');
  const goPath = path.join(root, 'go');
  fs.mkdirSync(asbHome, { recursive: true });
  fs.writeFileSync(path.join(asbHome, 'config.toml'), '[plugins]\nenabled = []\n');
  const configModule = pathToFileURL(path.resolve('src/config/layered-config.ts')).href;
  const children = ['alpha', 'beta'].map((key) => {
    const readyPath = path.join(root, `${key}.ready`);
    const source =
      'import fs from "node:fs";' +
      `import { updateConfigLayer } from ${JSON.stringify(configModule)};` +
      `const ready = ${JSON.stringify(readyPath)};` +
      `const go = ${JSON.stringify(goPath)};` +
      `const key = ${JSON.stringify(key)};` +
      'updateConfigLayer((layer) => {' +
      'fs.writeFileSync(ready, "ready");' +
      'while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);' +
      'return { ...layer, plugins: { ...layer.plugins, sources: { ...(layer.plugins?.sources ?? {}), [key]: "/tmp/" + key } } };' +
      '});';
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const result = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stderr }));
    });
    return {
      readyPath,
      child,
      result,
    };
  });
  try {
    await waitForReadyFiles(
      children.map(({ readyPath }) => readyPath),
      1,
      10_000
    );
    await waitForReadyFiles(
      children.map(({ readyPath }) => readyPath),
      2,
      500
    );
    fs.writeFileSync(goPath, 'go');
    const results = await Promise.all(children.map(({ result }) => result));
    assert.deepEqual(
      results.filter(({ code }) => code !== 0),
      []
    );
    const config = fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8');
    assert.match(config, /alpha/);
    assert.match(config, /beta/);
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent source adds admit one namespace owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-add-concurrency-'));
  const asbHome = path.join(root, 'asb-home');
  const goPath = path.join(root, 'go');
  fs.mkdirSync(asbHome, { recursive: true });
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const children = ['alpha', 'beta'].map((key) => {
    const libraryPath = path.join(root, key);
    const readyPath = path.join(root, `${key}.ready`);
    fs.mkdirSync(path.join(libraryPath, 'rules'), { recursive: true });
    const source =
      'import fs from "node:fs";' +
      `import { addLocalSource } from ${JSON.stringify(sourcesModule)};` +
      `const configPath = ${JSON.stringify(path.join(fs.realpathSync.native(asbHome), 'config.toml'))};` +
      `const ready = ${JSON.stringify(readyPath)};` +
      `const go = ${JSON.stringify(goPath)};` +
      'const originalRename = fs.renameSync.bind(fs);' +
      'fs.renameSync = (from, to) => {' +
      'if (String(to) === configPath) {' +
      'fs.writeFileSync(ready, "ready");' +
      'while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);' +
      '}' +
      'return originalRename(from, to);' +
      '};' +
      `try { addLocalSource("shared", ${JSON.stringify(libraryPath)}); process.stdout.write("OK"); }` +
      'catch (error) { process.stdout.write("ERROR:" + error.message); }';
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const result = new Promise<string>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(output) : reject(new Error(stderr || output))
      );
    });
    return {
      key,
      libraryPath,
      readyPath,
      child,
      result,
    };
  });
  try {
    await waitForReadyFiles(
      children.map(({ readyPath }) => readyPath),
      1,
      10_000
    );
    await waitForReadyFiles(
      children.map(({ readyPath }) => readyPath),
      2,
      500
    );
    fs.writeFileSync(goPath, 'go');
    const outputs = await Promise.all(children.map(({ result }) => result));
    assert.equal(outputs.filter((output) => output === 'OK').length, 1);
    assert.equal(outputs.filter((output) => output.startsWith('ERROR:')).length, 1);
    const winner = children[outputs.indexOf('OK')];
    assert.match(
      fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'),
      new RegExp(winner.key)
    );
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('user local source does not retire a profile-owned managed checkout', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'layered-owner';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'layered-owner-remote'));
    const profile = { profile: 'team' };
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, profile);
    const checkout = path.join(getPluginsDir(), namespace);
    const local = path.join(asbHome, 'local-owner');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });

    addLocalSource(namespace, local);

    assert.equal(getSourcesRecord()[namespace], local);
    assert.equal(getSourcesRecord(profile)[namespace], checkout);
    assert.equal(fs.existsSync(path.join(checkout, 'rules', 'v1.md')), true);
  });
});

test('profile local override keeps the user managed owner independently usable', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'layered-view';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'layered-view-remote'));
    const profile = { profile: 'team' };
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    const local = path.join(asbHome, 'profile-local');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });

    addLocalSource(namespace, local, profile);

    assert.equal(getSourcesRecord()[namespace], checkout);
    assert.equal(getSourcesRecord(profile)[namespace], local);
    assert.deepEqual(updateRemoteSources(profile, namespace), []);
    assert.equal(fs.existsSync(path.join(checkout, 'rules', 'v1.md')), true);
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

    const expectedCachePath = path.join(getPluginsDir(), 'remote-team');
    assert.equal(record['remote-team'], expectedCachePath);
  });
});

test('configured source namespaces are validated before managed checkout paths are used', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'remote'));
    const outside = path.join(asbHome, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\n"../outside" = { url = ${JSON.stringify(bareRepo)}, type = "clone" }\n`
    );

    assert.throws(() => updateRemoteSources(), /Invalid namespace/);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf-8'), 'preserve');
  });
});

test('configured local sources preserve safe non-CLI namespace characters', () => {
  withTempAsbHome((asbHome) => {
    const dotted = path.join(asbHome, 'dotted');
    const scoped = path.join(asbHome, 'scoped');
    fs.mkdirSync(path.join(dotted, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(scoped, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[plugins.sources]',
        `"acme.tools" = ${JSON.stringify(dotted)}`,
        `"team@source" = ${JSON.stringify(scoped)}`,
      ].join('\n')
    );

    assert.deepEqual(getSourcesRecord(), {
      'acme.tools': dotted,
      'team@source': scoped,
    });
    assert.equal(updateRemoteSources().length, 0);
  });
});

test('configured source subdirectories reject lexical checkout escapes', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      '[plugins.sources]\nremote = { url = "https://example.com/repo.git", subdir = "../../outside" }\n'
    );

    assert.throws(() => getSourcesRecord(), /subdirectory.*checkout|escapes/i);
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
    const expectedPath = path.join(path.join(getPluginsDir(), 'with-subdir'), 'lib/asb');
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
    const bareRepo = path.join(asbHome, 'bare-repo.git');
    fs.mkdirSync(bareRepo, { recursive: true });
    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });

    const workDir = path.join(asbHome, 'work');
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'rules', 'test.md'), '# Test rule\nHello');
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

    addRemoteSource('test-remote', { url: bareRepo, type: 'clone' });

    assert.equal(hasSource('test-remote'), true);

    const cacheDir = path.join(getPluginsDir(), 'test-remote');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'test.md')));

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

test('addRemoteSource rejects a symlinked managed plugin root before mutation', () => {
  withTempAsbHome((asbHome) => {
    const remoteParent = path.join(asbHome, 'symlink-root-remote');
    fs.mkdirSync(remoteParent, { recursive: true });
    const { bareRepo } = createBareRemote(remoteParent);
    const outside = path.join(asbHome, 'outside-plugins');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, getPluginsDir());

    assert.throws(
      () => addRemoteSource('symlink-root', { url: bareRepo, type: 'clone' }),
      /plugin source.*symbolic link|managed plugin root/i
    );

    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.existsSync(path.join(asbHome, 'config.toml')), false);
    assert.equal(fs.existsSync(getPluginSourceStateDir()), false);
  });
});

test('removeSource cleans up cache for remote sources', () => {
  withTempAsbHome((asbHome) => {
    const bareRepo = path.join(asbHome, 'bare-repo.git');
    fs.mkdirSync(bareRepo, { recursive: true });

    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });

    const workDir = path.join(asbHome, 'work');
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'rules', 'a.md'), '# A');
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

    addRemoteSource('cleanup-test', { url: bareRepo, type: 'clone' });

    const cacheDir = path.join(getPluginsDir(), 'cleanup-test');
    assert.ok(fs.existsSync(cacheDir));

    removeSource('cleanup-test');

    assert.equal(hasSource('cleanup-test'), false);
    assert.equal(fs.existsSync(cacheDir), false);
  });
});

test('updateRemoteSources pulls latest changes', () => {
  withTempAsbHome((asbHome) => {
    const bareRepo = path.join(asbHome, 'bare-repo.git');
    fs.mkdirSync(bareRepo, { recursive: true });

    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });

    const workDir = path.join(asbHome, 'work');
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'rules', 'v1.md'), '# V1');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v1'],
      {
        cwd: workDir,
        stdio: 'pipe',
      }
    );
    execFileSync('git', ['push'], { cwd: workDir, stdio: 'pipe' });

    addRemoteSource('update-test', { url: bareRepo, type: 'clone' });
    const cacheDir = path.join(getPluginsDir(), 'update-test');
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'v1.md')));

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
  });
});

test('managed branch accepts a clean checkout behind its fetched tracking ref', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'tracking-remote'));
    addRemoteSource('tracking-behind', { url: bareRepo, type: 'clone', ref: 'main' });
    const checkoutPath = path.join(getPluginsDir(), 'tracking-behind');
    const oldHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
      encoding: 'utf-8',
    }).trim();

    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: checkoutPath, stdio: 'pipe' });
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath, encoding: 'utf-8' }).trim(),
      oldHead
    );

    assert.equal(getSourcesRecord()['tracking-behind'], checkoutPath);
    const result = updateRemoteSources(undefined, 'tracking-behind');
    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath, encoding: 'utf-8' }).trim(),
      execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], {
        cwd: checkoutPath,
        encoding: 'utf-8',
      }).trim()
    );
  });
});

test('managed clone lifecycle adopts a verified checkout created before provenance state', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'legacy-clone-remote'));
    addRemoteSource('legacy-clone', { url: bareRepo, type: 'clone', ref: 'main' });
    const checkoutPath = path.join(getPluginsDir(), 'legacy-clone');
    fs.rmSync(getPluginSourceStateDir(), { recursive: true, force: true });
    fs.rmSync(path.join(checkoutPath, '.asb-source-owner'));

    const result = updateRemoteSources(undefined, 'legacy-clone');

    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.match(
      fs.readFileSync(path.join(checkoutPath, '.asb-source-owner'), 'utf-8'),
      /^[0-9a-f-]+\n$/
    );
    removeSource('legacy-clone');
    assert.equal(fs.existsSync(checkoutPath), false);
  });
});

test('managed clone adoption refuses a symlinked Git exclude file', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'exclude-link';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'exclude-link-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.rmSync(getPluginSourceStateDir(), { recursive: true, force: true });
    fs.rmSync(path.join(checkout, '.asb-source-owner'));
    const external = path.join(asbHome, 'external-exclude');
    fs.writeFileSync(external, 'keep\n');
    const exclude = path.join(checkout, '.git', 'info', 'exclude');
    fs.rmSync(exclude);
    fs.symlinkSync(external, exclude);

    const result = updateRemoteSources(undefined, namespace);

    assert.equal(result[0]?.status, 'error');
    assert.match(result[0]?.error ?? '', /exclude path is invalid/i);
    assert.equal(fs.readFileSync(external, 'utf-8'), 'keep\n');
  });
});

test('removeSource quarantines an owned checkout that is no longer clean', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'preserve-dirty';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'preserve-dirty-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.writeFileSync(path.join(checkout, 'foreign.txt'), 'preserve');

    removeSource(namespace);

    assert.equal(fs.existsSync(checkout), false);
    const preserved = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.preserved-${namespace}-`));
    assert.ok(preserved);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), preserved, 'foreign.txt'), 'utf-8'),
      'preserve'
    );
    assert.equal(namespace in getSourcesRecord(), false);
  });
});

test('updateRemoteSources publishes a missing checkout from a verified hidden stage', (t) => {
  withTempAsbHome((asbHome) => {
    const bareRepo = path.join(asbHome, 'bare-repo.git');
    fs.mkdirSync(bareRepo, { recursive: true });

    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });

    const workDir = path.join(asbHome, 'work');
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'rules', 'test.md'), '# Test');
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

    addRemoteSource('reclone-test', { url: bareRepo, type: 'clone' });
    const cacheDir = path.join(getPluginsDir(), 'reclone-test');

    fs.rmSync(cacheDir, { recursive: true, force: true });
    assert.equal(fs.existsSync(cacheDir), false);

    let publishedFromHiddenStage = false;
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === path.resolve(cacheDir)) {
        publishedFromHiddenStage = true;
        assert.match(path.basename(path.dirname(String(from))), /^\.updating-reclone-test-/);
        assert.equal(fs.existsSync(cacheDir), false);
        assert.equal(
          execFileSync('git', ['config', '--get', 'remote.origin.url'], {
            cwd: String(from),
            encoding: 'utf-8',
          }).trim(),
          bareRepo
        );
      }
      return originalRename(from, to);
    });

    const results = updateRemoteSources();
    assert.equal(results.length, 1);
    assert.equal(results[0].status, 'updated', results[0].error);
    assert.equal(publishedFromHiddenStage, true);
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'test.md')));
  });
});

test('missing checkout update recovers an interrupted owned clone stage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-update-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'recoverable-update';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone' });
    const checkoutPath = path.join(getPluginsDir(), namespace);
    fs.rmSync(checkoutPath, { recursive: true, force: true });

    const started = await startRemoteAddBeforeCheckoutOwnership(
      asbHome,
      namespace,
      bareRepo,
      'update'
    );
    child = started.child;
    const stageName = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.updating-${namespace}-`));
    assert.ok(stageName, started.stderr());
    assert.equal(fs.existsSync(path.join(getPluginsDir(), stageName, '.asb-stage-owner')), true);
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    getSourcesRecord();
    assert.deepEqual(
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.updating-')),
      []
    );
    assert.equal(fs.existsSync(checkoutPath), false);
    const result = updateRemoteSources(undefined, namespace);
    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.equal(fs.existsSync(path.join(checkoutPath, 'rules', 'v1.md')), true);
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone recovery rolls back a populated stage that was not validated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-validation-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'unvalidated-update';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.rmSync(checkout, { recursive: true, force: true });
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const childSource =
      'import fs from "node:fs";' +
      `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
      'const originalRename = fs.renameSync.bind(fs);' +
      'let stopped = false;' +
      'fs.renameSync = (from, to) => {' +
      'const result = originalRename(from, to);' +
      'if (!stopped && String(to).endsWith(".json")) {' +
      'const state = JSON.parse(fs.readFileSync(String(to), "utf-8"));' +
      'if (state.addition?.kind === "clone" && state.addition.checkoutIdentity && state.addition.phase === "constructing") {' +
      'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
      '}' +
      '}' +
      'return result;' +
      '};' +
      `updateRemoteSources(undefined, ${JSON.stringify(namespace)});`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (output.includes('CHECKPOINT\n')) resolve();
        else if (child?.exitCode !== null) reject(new Error(stderr || 'update exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(stderr || 'validation checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    getSourcesRecord();

    assert.equal(fs.existsSync(checkout), false);
    assert.deepEqual(
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.updating-')),
      []
    );
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      states.some((state) => state.addition),
      false
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone recovery refuses publication after a higher-layer effective override', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-effective-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'effective-recovery';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.rmSync(checkout, { recursive: true, force: true });
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const childSource =
      'import fs from "node:fs";' +
      `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
      'const originalRename = fs.renameSync.bind(fs);' +
      `const checkout = ${JSON.stringify(checkout)};` +
      'fs.renameSync = (from, to) => {' +
      'if (String(to) === checkout) {' +
      'process.stdout.write("CHECKPOINT\\n");' +
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
      '}' +
      'return originalRename(from, to);' +
      '};' +
      `updateRemoteSources({ profile: "team" }, ${JSON.stringify(namespace)});`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (output.includes('CHECKPOINT\n')) resolve();
        else if (child?.exitCode !== null) reject(new Error(stderr || 'update exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(stderr || 'publication checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;
    const local = path.join(asbHome, 'profile-local');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = ${JSON.stringify(local)}\n`
    );

    assert.equal(getSourcesRecord(profile)[namespace], local);
    assert.equal(fs.existsSync(checkout), false);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      states.some((state) => state.addition),
      false
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed checkout reads fail closed on configured origin and ref replacement', () => {
  withTempAsbHome((asbHome) => {
    const firstParent = path.join(asbHome, 'identity-first');
    const secondParent = path.join(asbHome, 'identity-second');
    fs.mkdirSync(firstParent, { recursive: true });
    fs.mkdirSync(secondParent, { recursive: true });
    const first = createBareRemote(firstParent);
    const second = createBareRemote(secondParent);
    addRemoteSource('identity-check', { url: first.bareRepo, type: 'clone', ref: 'main' });

    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nidentity-check = { url = ${JSON.stringify(second.bareRepo)}, type = "clone", ref = "main" }\n`
    );
    assert.throws(() => getSourcesRecord(), /origin.*configured source|identity/i);
    const originResult = updateRemoteSources();
    assert.equal(originResult[0]?.status, 'error');

    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nidentity-check = { url = ${JSON.stringify(first.bareRepo)}, type = "clone", ref = "other" }\n`
    );
    assert.throws(() => getSourcesRecord(), /configured ref|revision/i);
    const refResult = updateRemoteSources();
    assert.equal(refResult[0]?.status, 'error');

    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nidentity-check = { url = ${JSON.stringify(first.bareRepo)}, type = "clone", ref = "main" }\n`
    );
    const checkoutPath = path.join(getPluginsDir(), 'identity-check');
    fs.rmSync(path.join(checkoutPath, '.git'), { recursive: true, force: true });
    fs.mkdirSync(path.join(checkoutPath, '.git'));
    assert.throws(() => getSourcesRecord(), /incomplete or corrupt/i);
    const corruptResult = updateRemoteSources();
    assert.equal(corruptResult[0]?.status, 'error');
    assert.equal(fs.existsSync(path.join(checkoutPath, 'rules', 'v1.md')), true);
  });
});

test('removeSource refuses a dangling replacement for an owned checkout', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'dangling-remote'));
    addRemoteSource('dangling-checkout', { url: bareRepo, type: 'clone' });
    const checkoutPath = path.join(getPluginsDir(), 'dangling-checkout');
    fs.rmSync(checkoutPath, { recursive: true, force: true });
    fs.symlinkSync(path.join(asbHome, 'missing-checkout'), checkoutPath);

    assert.throws(() => removeSource('dangling-checkout'), /symbolic link|ownership changed/i);
    assert.equal(fs.lstatSync(checkoutPath).isSymbolicLink(), true);
    assert.match(fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'), /dangling-checkout/);
  });
});

test('re-adding a directly deleted namespace retires its prior owned checkout', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'readd-remote'));
    addRemoteSource('readded', { url: bareRepo, type: 'clone' });
    const oldCheckout = path.join(getPluginsDir(), 'readded');
    fs.writeFileSync(path.join(asbHome, 'config.toml'), '');
    const localSource = path.join(asbHome, 'replacement');
    fs.mkdirSync(path.join(localSource, 'rules'), { recursive: true });

    addLocalSource('readded', localSource);

    assert.equal(getSourcesRecord().readded, localSource);
    assert.equal(fs.existsSync(oldCheckout), false);
  });
});

test('direct descriptor replacement cannot discard an owned checkout incarnation', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(asbHome, 'rebind-remote'));
    addRemoteSource('rebound', { url: bareRepo, type: 'clone' });
    const oldCheckout = path.join(getPluginsDir(), 'rebound');
    const replacement = path.join(asbHome, 'replacement-source');
    fs.mkdirSync(path.join(replacement, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nrebound = ${JSON.stringify(replacement)}\n`
    );

    assert.throws(() => removeSource('rebound'), /cannot replace its managed checkout/i);
    assert.equal(fs.existsSync(oldCheckout), true);
    assert.match(fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8'), /rebound/);
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
    addRemoteSource('first', { url: first.bareRepo, type: 'clone', ref: 'main' });
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
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'first', 'rules', 'first-v2.md')), true);
    assert.equal(
      fs.existsSync(path.join(getPluginsDir(), 'second', 'rules', 'second-v2.md')),
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
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'catalog-source', '.git')), true);
  });
});

test('updateRemoteSources refreshes materialized entries from a local marketplace source', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'local-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
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

    assert.equal(results.find((result) => result.namespace === 'local-catalog')?.status, 'updated');
    assert.equal(fs.readFileSync(path.join(materializedPath, 'VERSION'), 'utf-8').trim(), 'v2');
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
      fs.existsSync(path.join(getPluginsDir(), 'catalog-source', 'rules', 'ordinary.md')),
      true
    );
  });
});

test('updateRemoteSources removes derived cache when a local marketplace becomes a plugin', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'local-transition-entry');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const marketplaceDir = path.join(asbHome, 'local-transition-catalog');
    const manifestDir = path.join(marketplaceDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'marketplace.json'),
      JSON.stringify({
        name: 'local-transition',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    addLocalSource('local-transition', marketplaceDir);
    const firstIndex = buildPluginIndex();
    const plugin = firstIndex.get('remote-plugin@local-transition');
    assert.ok(plugin);
    firstIndex.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;

    clearPluginIndexCache();
    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(marketplaceDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(marketplaceDir, 'rules', 'ordinary.md'), '# Ordinary');

    const results = updateRemoteSources(undefined, 'local-transition');
    const nextIndex = buildPluginIndex();

    assert.equal(results[0]?.status, 'updated');
    assert.equal(fs.existsSync(materializedPath), false);
    assert.ok(nextIndex.get('local-transition'));
    assert.equal(nextIndex.get('remote-plugin@local-transition'), undefined);
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

test('removeSource cleans the canonical cache owner after a source symlink disappears', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'symlink-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const marketplaceDir = path.join(asbHome, 'symlink-catalog-target');
    const marketplaceLink = path.join(asbHome, 'symlink-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'symlink-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    fs.symlinkSync(marketplaceDir, marketplaceLink);
    addLocalSource('symlink-catalog', marketplaceLink);
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@symlink-catalog');
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    assert.equal(fs.existsSync(materializedPath), true);
    clearPluginIndexCache();
    fs.rmSync(marketplaceLink);

    removeSource('symlink-catalog');

    assert.equal(hasSource('symlink-catalog'), false);
    assert.equal(fs.existsSync(materializedPath), false);
    assert.equal(fs.existsSync(marketplaceDir), true);
  });
});

test('source path rotation retires cache owned by the previous canonical path', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'rotating-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const firstCatalog = path.join(asbHome, 'rotating-catalog-one');
    const secondCatalog = path.join(asbHome, 'rotating-catalog-two');
    const catalogLink = path.join(asbHome, 'rotating-catalog');
    for (const catalogPath of [firstCatalog, secondCatalog]) {
      fs.mkdirSync(path.join(catalogPath, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(catalogPath, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'rotating-catalog',
          plugins: [
            {
              name: 'remote-plugin',
              source: { source: 'url', url: entryRemote.bareRepo },
            },
          ],
        })
      );
    }
    fs.symlinkSync(firstCatalog, catalogLink);
    addLocalSource('rotating-catalog', catalogLink);
    const firstIndex = buildPluginIndex();
    const firstPlugin = firstIndex.get('remote-plugin@rotating-catalog');
    assert.ok(firstPlugin);
    firstIndex.expand([firstPlugin.id]);
    const firstMaterializedPath = firstPlugin.meta.sourcePath;
    clearPluginIndexCache();
    fs.rmSync(catalogLink);
    fs.symlinkSync(secondCatalog, catalogLink);
    const secondIndex = buildPluginIndex();
    const secondPlugin = secondIndex.get('remote-plugin@rotating-catalog');
    assert.ok(secondPlugin);
    secondIndex.expand([secondPlugin.id]);
    const secondMaterializedPath = secondPlugin.meta.sourcePath;
    assert.notEqual(firstMaterializedPath, secondMaterializedPath);

    clearPluginIndexCache();
    removeSource('rotating-catalog');

    assert.equal(fs.existsSync(firstMaterializedPath), false);
    assert.equal(fs.existsSync(secondMaterializedPath), false);
  });
});

test('direct descriptor replacement keeps one namespace owner and retires prior cache', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const firstEntry = createBareRemote(path.join(asbHome, 'descriptor-entry-one'));
    const secondEntry = createBareRemote(path.join(asbHome, 'descriptor-entry-two'));
    const firstCatalog = path.join(asbHome, 'descriptor-catalog-one');
    const secondCatalog = path.join(asbHome, 'descriptor-catalog-two');
    for (const [catalogPath, remote] of [
      [firstCatalog, firstEntry],
      [secondCatalog, secondEntry],
    ] as const) {
      fs.mkdirSync(path.join(catalogPath, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(catalogPath, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'descriptor-replacement',
          plugins: [
            {
              name: 'remote-plugin',
              source: { source: 'url', url: remote.bareRepo },
            },
          ],
        })
      );
    }
    addLocalSource('descriptor-replacement', firstCatalog);
    const firstIndex = buildPluginIndex();
    const firstPlugin = firstIndex.get('remote-plugin@descriptor-replacement');
    assert.ok(firstPlugin);
    firstIndex.expand([firstPlugin.id]);
    const firstMaterializedPath = firstPlugin.meta.sourcePath;

    clearPluginIndexCache();
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\ndescriptor-replacement = ${JSON.stringify(secondCatalog)}\n`
    );
    const secondIndex = buildPluginIndex();
    const secondPlugin = secondIndex.get('remote-plugin@descriptor-replacement');
    assert.ok(secondPlugin);
    secondIndex.expand([secondPlugin.id]);
    const secondMaterializedPath = secondPlugin.meta.sourcePath;

    assert.notEqual(firstMaterializedPath, secondMaterializedPath);
    assert.equal(fs.existsSync(firstMaterializedPath), false);
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).filter((name) => name.endsWith('.json')).length,
      1
    );

    clearPluginIndexCache();
    removeSource('descriptor-replacement');
    assert.equal(fs.existsSync(firstMaterializedPath), false);
    assert.equal(fs.existsSync(secondMaterializedPath), false);
    assert.deepEqual(
      fs.existsSync(getPluginSourceStateDir())
        ? fs.readdirSync(getPluginSourceStateDir()).filter((name) => name.endsWith('.json'))
        : [],
      []
    );
  });
});

test('auto-discovered source rotation retires the previous canonical cache owner', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryRemote = createBareRemote(path.join(asbHome, 'discovered-entry'));
    const firstCatalog = path.join(asbHome, 'discovered-catalog-one');
    const secondCatalog = path.join(asbHome, 'discovered-catalog-two');
    for (const catalogPath of [firstCatalog, secondCatalog]) {
      fs.mkdirSync(path.join(catalogPath, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(
        path.join(catalogPath, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'discovered-rotation',
          plugins: [
            {
              name: 'remote-plugin',
              source: { source: 'url', url: entryRemote.bareRepo },
            },
          ],
        })
      );
    }
    fs.mkdirSync(getPluginsDir(), { recursive: true });
    const catalogLink = path.join(getPluginsDir(), 'discovered-rotation');
    fs.symlinkSync(firstCatalog, catalogLink);

    const firstIndex = buildPluginIndex();
    const firstPlugin = firstIndex.get('remote-plugin@discovered-rotation');
    assert.ok(firstPlugin);
    firstIndex.expand([firstPlugin.id]);
    const firstMaterializedPath = firstPlugin.meta.sourcePath;

    clearPluginIndexCache();
    fs.rmSync(catalogLink);
    fs.symlinkSync(secondCatalog, catalogLink);
    const secondIndex = buildPluginIndex();
    const secondPlugin = secondIndex.get('remote-plugin@discovered-rotation');
    assert.ok(secondPlugin);
    secondIndex.expand([secondPlugin.id]);

    assert.equal(fs.existsSync(firstMaterializedPath), false);
    clearPluginIndexCache();
  });
});

test('local marketplace-to-plugin transition invalidates the index without derived cache', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const marketplaceDir = path.join(asbHome, 'resolved-transition');
    const manifestDir = path.join(marketplaceDir, '.claude-plugin');
    fs.mkdirSync(path.join(marketplaceDir, 'packages', 'resolved', 'rules'), {
      recursive: true,
    });
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, 'packages', 'resolved', 'rules', 'marketplace.md'),
      '# Marketplace'
    );
    fs.writeFileSync(
      path.join(manifestDir, 'marketplace.json'),
      JSON.stringify({
        name: 'resolved-transition',
        plugins: [{ name: 'resolved-plugin', source: './packages/resolved' }],
      })
    );
    addLocalSource('resolved-transition', marketplaceDir);

    const firstIndex = buildPluginIndex();
    assert.ok(firstIndex.get('resolved-plugin@resolved-transition'));

    fs.rmSync(manifestDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(marketplaceDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(marketplaceDir, 'rules', 'direct.md'), '# Direct');

    const results = updateRemoteSources(undefined, 'resolved-transition');
    const nextIndex = buildPluginIndex();

    assert.equal(results[0]?.status, 'updated');
    assert.notEqual(nextIndex, firstIndex);
    assert.ok(nextIndex.get('resolved-transition'));
    assert.equal(nextIndex.get('resolved-plugin@resolved-transition'), undefined);
    clearPluginIndexCache();
  });
});

function createManagedMarketplaceSource(
  asbHome: string,
  namespace: string
): { checkoutPath: string; materializedPath: string } {
  const entryParent = path.join(asbHome, `${namespace}-entry`);
  const catalogParent = path.join(asbHome, `${namespace}-catalog`);
  fs.mkdirSync(entryParent, { recursive: true });
  fs.mkdirSync(catalogParent, { recursive: true });
  const entryRemote = createBareRemote(entryParent);
  const catalogRemote = createBareRemote(catalogParent);
  fs.mkdirSync(path.join(catalogRemote.workDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(catalogRemote.workDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: namespace,
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
  execFileSync('git', ['push', 'origin', 'main'], {
    cwd: catalogRemote.workDir,
    stdio: 'pipe',
  });
  addRemoteSource(namespace, { url: catalogRemote.bareRepo, type: 'clone' });
  const index = buildPluginIndex();
  const plugin = index.get(`remote-plugin@${namespace}`);
  assert.ok(plugin);
  index.expand([plugin.id]);
  const materializedPath = plugin.meta.sourcePath;
  clearPluginIndexCache();
  return {
    checkoutPath: path.join(getPluginsDir(), namespace),
    materializedPath,
  };
}

function createLayeredSubdirMarketplaceSource(
  asbHome: string,
  namespace: string
): {
  catalogUrl: string;
  checkoutPath: string;
  entryWorkDir: string;
  lowerMaterialized: string;
  higherMaterialized: string;
} {
  clearPluginIndexCache();
  const profile = { profile: 'team' };
  const entryRemote = createBareRemote(path.join(asbHome, `${namespace}-entry`));
  const catalogRemote = createBareRemote(path.join(asbHome, `${namespace}-catalog`));
  for (const [subdir, pluginName] of [
    ['lower', 'lower-plugin'],
    ['higher', 'higher-plugin'],
  ] as const) {
    const manifestDir = path.join(catalogRemote.workDir, subdir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'marketplace.json'),
      JSON.stringify({
        name: `${namespace}-${subdir}`,
        plugins: [
          {
            name: pluginName,
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
  }
  execFileSync('git', ['add', '.'], { cwd: catalogRemote.workDir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'subdirs'],
    { cwd: catalogRemote.workDir, stdio: 'pipe' }
  );
  execFileSync('git', ['push', 'origin', 'main'], {
    cwd: catalogRemote.workDir,
    stdio: 'pipe',
  });
  addRemoteSource(namespace, {
    url: catalogRemote.bareRepo,
    type: 'clone',
    ref: 'main',
    subdir: 'lower',
  });
  const checkoutPath = path.join(getPluginsDir(), namespace);
  const lowerIndex = buildPluginIndex();
  const lowerPlugin = lowerIndex.get(`lower-plugin@${namespace}`);
  assert.ok(lowerPlugin);
  lowerIndex.expand([lowerPlugin.id]);
  const lowerMaterialized = lowerPlugin.meta.sourcePath;
  clearPluginIndexCache();
  fs.writeFileSync(
    getProfileConfigPath('team'),
    `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(catalogRemote.bareRepo)}, type = "clone", ref = "main", subdir = "higher" }\n`
  );
  const higherIndex = buildPluginIndex(profile);
  const higherPlugin = higherIndex.get(`higher-plugin@${namespace}`);
  assert.ok(higherPlugin);
  higherIndex.expand([higherPlugin.id]);
  const higherMaterialized = higherPlugin.meta.sourcePath;
  clearPluginIndexCache();
  return {
    catalogUrl: catalogRemote.bareRepo,
    checkoutPath,
    entryWorkDir: entryRemote.workDir,
    lowerMaterialized,
    higherMaterialized,
  };
}

async function stopRemovalAtCrashPoint(
  asbHome: string,
  namespace: string,
  crashPoint: 'before-config' | 'after-config' | 'after-config-publication',
  scope?: { profile?: string; project?: string }
): Promise<void> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const configuredPath = process.env.ASB_CONFIG?.trim() || path.join(asbHome, 'config.toml');
  const configPath = fs.existsSync(configuredPath)
    ? fs.realpathSync.native(configuredPath)
    : path.join(
        fs.realpathSync.native(path.dirname(configuredPath)),
        path.basename(configuredPath)
      );
  const childSource =
    'import fs from "node:fs";' +
    `import { removeSource } from ${JSON.stringify(sourcesModule)};` +
    'const originalRename = fs.renameSync.bind(fs);' +
    'const originalRemove = fs.rmSync.bind(fs);' +
    `const configPath = ${JSON.stringify(configPath)};` +
    `const crashPoint = ${JSON.stringify(crashPoint)};` +
    'const wait = () => {' +
    'process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '};' +
    'fs.renameSync = (from, to) => {' +
    'if (crashPoint === "before-config" && String(to) === configPath) wait();' +
    'const result = originalRename(from, to);' +
    'if (crashPoint === "after-config-publication" && String(to) === configPath) wait();' +
    'return result;' +
    '};' +
    'fs.rmSync = (target, options) => {' +
    'if (crashPoint === "after-config" && String(target).includes(".removing-")) wait();' +
    'return originalRemove(target, options);' +
    '};' +
    `removeSource(${JSON.stringify(namespace)}, ${JSON.stringify(scope)});`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (output.includes('CHECKPOINT\n')) resolve();
      else if (child.exitCode !== null) reject(new Error(stderr || 'removal exited early'));
      else if (Date.now() >= deadline) reject(new Error(stderr || 'removal checkpoint timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
}

async function stopInactiveRetirementAfterState(
  asbHome: string,
  namespace: string,
  replacement: string
): Promise<void> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const childSource =
    'import fs from "node:fs";' +
    `import { addLocalSource } from ${JSON.stringify(sourcesModule)};` +
    'const originalRename = fs.renameSync.bind(fs);' +
    'let stopped = false;' +
    'fs.renameSync = (from, to) => {' +
    'const result = originalRename(from, to);' +
    'if (!stopped && String(to).endsWith(".json")) {' +
    'const state = JSON.parse(fs.readFileSync(String(to), "utf-8"));' +
    'if (state.removal) {' +
    'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '}' +
    '}' +
    'return result;' +
    '};' +
    `addLocalSource(${JSON.stringify(namespace)}, ${JSON.stringify(replacement)}, { profile: "team" });`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (output.includes('CHECKPOINT\n')) resolve();
      else if (child.exitCode !== null)
        reject(new Error(stderr || 'inactive retirement exited early'));
      else if (Date.now() >= deadline)
        reject(new Error(stderr || 'inactive retirement checkpoint timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.kill('SIGKILL');
  await closed;
}

async function startRemoteAddBeforeCheckoutOwnership(
  asbHome: string,
  namespace: string,
  bareRepo: string,
  operation: 'add' | 'update' = 'add'
): Promise<{ child: ReturnType<typeof spawn>; stderr: () => string }> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const action =
    operation === 'add'
      ? `addRemoteSource(${JSON.stringify(namespace)}, { url: ${JSON.stringify(bareRepo)}, type: "clone" });`
      : `updateRemoteSources(undefined, ${JSON.stringify(namespace)});`;
  const childSource =
    'import fs from "node:fs";' +
    `import { addRemoteSource, updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
    'const originalWrite = fs.writeFileSync.bind(fs);' +
    'let stopped = false;' +
    'const wait = () => {' +
    'if (stopped) return;' +
    'stopped = true;' +
    'process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '};' +
    'fs.writeFileSync = (target, data, options) => {' +
    'if (String(target).endsWith("/.asb-source-owner")) wait();' +
    'return originalWrite(target, data, options);' +
    '};' +
    action;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (output.includes('CHECKPOINT\n')) resolve();
      else if (child.exitCode !== null) reject(new Error(errorOutput || 'source add exited early'));
      else if (Date.now() >= deadline) reject(new Error(errorOutput || 'source add timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
  return { child, stderr: () => errorOutput };
}

async function startSubtreeAddAtConfigPublication(
  asbHome: string,
  namespace: string,
  bareRepo: string
): Promise<{ child: ReturnType<typeof spawn>; stderr: () => string }> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const configPath = fs.realpathSync.native(path.join(asbHome, 'config.toml'));
  const childSource =
    'import fs from "node:fs";' +
    `import { addRemoteSource } from ${JSON.stringify(sourcesModule)};` +
    'const originalRename = fs.renameSync.bind(fs);' +
    `const configPath = ${JSON.stringify(configPath)};` +
    'fs.renameSync = (from, to) => {' +
    'if (String(to) === configPath) {' +
    'process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '}' +
    'return originalRename(from, to);' +
    '};' +
    `addRemoteSource(${JSON.stringify(namespace)}, { url: ${JSON.stringify(bareRepo)}, type: "subtree", ref: "main" });`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (output.includes('CHECKPOINT\n')) resolve();
      else if (child.exitCode !== null)
        reject(new Error(errorOutput || 'subtree add exited early'));
      else if (Date.now() >= deadline) reject(new Error(errorOutput || 'subtree add timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
  return { child, stderr: () => errorOutput };
}

test('source removal recovers crashes around the config commit', async () => {
  for (const crashPoint of ['before-config', 'after-config'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `asb-source-${crashPoint}-`));
    const asbHome = path.join(root, 'asb-home');
    fs.mkdirSync(asbHome, { recursive: true });
    const previousAsbHome = process.env.ASB_HOME;
    const previousAgentsHome = process.env.ASB_AGENTS_HOME;
    process.env.ASB_HOME = asbHome;
    process.env.ASB_AGENTS_HOME = asbHome;
    try {
      clearPluginIndexCache();
      const namespace = `crash-${crashPoint}`;
      const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
      await stopRemovalAtCrashPoint(asbHome, namespace, crashPoint);

      const sources = getSourcesRecord();
      const removingCheckouts = fs
        .readdirSync(getPluginsDir())
        .filter((name) => name.startsWith('.removing-'));
      const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
      const removingCaches = fs.existsSync(cacheRoot)
        ? fs.readdirSync(cacheRoot).filter((name) => name.startsWith('.removing-'))
        : [];
      const configTransactionArtifacts = fs
        .readdirSync(asbHome)
        .filter((name) => name.includes('.asb-write.') || name.includes('.asb-lock'));

      if (crashPoint === 'before-config') {
        assert.ok(namespace in sources);
        assert.equal(fs.existsSync(checkoutPath), true);
        assert.equal(fs.existsSync(materializedPath), true);
      } else {
        assert.equal(namespace in sources, false);
        assert.equal(fs.existsSync(checkoutPath), false);
        assert.equal(fs.existsSync(materializedPath), false);
      }
      assert.deepEqual(removingCheckouts, []);
      assert.deepEqual(removingCaches, []);
      assert.deepEqual(configTransactionArtifacts, []);
    } finally {
      clearPluginIndexCache();
      if (previousAsbHome === undefined) delete process.env.ASB_HOME;
      else process.env.ASB_HOME = previousAsbHome;
      if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
      else process.env.ASB_AGENTS_HOME = previousAgentsHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('temporary cache reads refuse pending durable source recovery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-dry-run-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    clearPluginIndexCache();
    const namespace = 'dry-run-pending';
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    await stopRemovalAtCrashPoint(asbHome, namespace, 'before-config');
    const configPath = path.join(asbHome, 'config.toml');
    const configBefore = fs.readFileSync(configPath, 'utf-8');
    const stagedCheckoutsBefore = fs
      .readdirSync(getPluginsDir())
      .filter((name) => name.startsWith('.removing-'));

    await assert.rejects(
      withTemporaryMarketplaceEntryCache(async () => {
        getSourcesRecord();
      }),
      /pending source transaction.*recovery/i
    );

    assert.equal(fs.readFileSync(configPath, 'utf-8'), configBefore);
    assert.deepEqual(
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.removing-')),
      stagedCheckoutsBefore
    );
    assert.equal(fs.existsSync(checkoutPath), false);
    assert.equal(fs.existsSync(materializedPath), false);

    const recovered = getSourcesRecord();
    assert.ok(namespace in recovered);
    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(materializedPath), true);
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('remote clone addition stays hidden until publication and recovers for retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-add-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'recoverable-add';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    const started = await startRemoteAddBeforeCheckoutOwnership(asbHome, namespace, bareRepo);
    child = started.child;

    const visibleSources = fs.existsSync(getPluginsDir())
      ? fs.readdirSync(getPluginsDir()).filter((name) => !name.startsWith('.'))
      : [];
    assert.equal(visibleSources.includes(namespace), false, started.stderr());

    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    addRemoteSource(namespace, { url: bareRepo, type: 'clone' });

    assert.equal(hasSource(namespace), true);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
    assert.deepEqual(
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.adding-')),
      []
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source addition recovery preserves a replacement at its staged pathname', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-add-ownership-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'owned-add-stage';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    const started = await startRemoteAddBeforeCheckoutOwnership(asbHome, namespace, bareRepo);
    child = started.child;
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    const stagedName = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.adding-${namespace}-`));
    assert.ok(stagedName);
    const stagedPath = path.join(getPluginsDir(), stagedName);
    fs.rmSync(stagedPath, { recursive: true, force: true });
    fs.mkdirSync(stagedPath, { recursive: true });
    const sentinel = path.join(stagedPath, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve');

    assert.throws(() => getSourcesRecord(), /staging ownership|recovery ownership/i);
    assert.equal(fs.readFileSync(sentinel, 'utf-8'), 'preserve');
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source removal recovery preserves a replacement at its staged pathname', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-remove-ownership-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    clearPluginIndexCache();
    const namespace = 'owned-remove-stage';
    createManagedMarketplaceSource(asbHome, namespace);
    await stopRemovalAtCrashPoint(asbHome, namespace, 'before-config');
    const stagedName = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.removing-${namespace}-`));
    assert.ok(stagedName);
    const stagedPath = path.join(getPluginsDir(), stagedName);
    fs.rmSync(stagedPath, { recursive: true, force: true });
    fs.mkdirSync(stagedPath, { recursive: true });
    const sentinel = path.join(stagedPath, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve');

    assert.throws(() => getSourcesRecord(), /ownership.*changed|identity/i);
    assert.equal(fs.readFileSync(sentinel, 'utf-8'), 'preserve');
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source removal recovery stays bound to its original ASB_CONFIG carrier', async () => {
  for (const crashPoint of ['before-config', 'after-config'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `asb-source-carrier-${crashPoint}-`));
    const asbHome = path.join(root, 'asb-home');
    const originalConfig = path.join(root, 'original.toml');
    const ambientConfig = path.join(root, 'ambient.toml');
    fs.mkdirSync(asbHome, { recursive: true });
    fs.writeFileSync(ambientConfig, '[plugins]\nenabled = []\n');
    const previousAsbHome = process.env.ASB_HOME;
    const previousAgentsHome = process.env.ASB_AGENTS_HOME;
    const previousAsbConfig = process.env.ASB_CONFIG;
    process.env.ASB_HOME = asbHome;
    process.env.ASB_AGENTS_HOME = asbHome;
    process.env.ASB_CONFIG = originalConfig;
    try {
      clearPluginIndexCache();
      const namespace = `carrier-${crashPoint}`;
      const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
      await stopRemovalAtCrashPoint(asbHome, namespace, crashPoint);
      process.env.ASB_CONFIG = ambientConfig;

      getSourcesRecord();

      const original = fs.readFileSync(originalConfig, 'utf-8');
      if (crashPoint === 'before-config') {
        assert.match(original, new RegExp(namespace));
        assert.equal(fs.existsSync(checkoutPath), true);
        assert.equal(fs.existsSync(materializedPath), true);
      } else {
        assert.doesNotMatch(original, new RegExp(namespace));
        assert.equal(fs.existsSync(checkoutPath), false);
        assert.equal(fs.existsSync(materializedPath), false);
      }
    } finally {
      clearPluginIndexCache();
      if (previousAsbHome === undefined) delete process.env.ASB_HOME;
      else process.env.ASB_HOME = previousAsbHome;
      if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
      else process.env.ASB_AGENTS_HOME = previousAgentsHome;
      if (previousAsbConfig === undefined) delete process.env.ASB_CONFIG;
      else process.env.ASB_CONFIG = previousAsbConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('source removal recovery stays bound to the resolved config symlink target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-config-target-'));
  const asbHome = path.join(root, 'asb-home');
  const configCarrier = path.join(root, 'config.toml');
  const originalConfig = path.join(root, 'original.toml');
  const retargetedConfig = path.join(root, 'retargeted.toml');
  fs.mkdirSync(asbHome, { recursive: true });
  fs.writeFileSync(originalConfig, '[plugins]\nenabled = []\n');
  fs.writeFileSync(retargetedConfig, '[plugins]\nenabled = []\n');
  fs.symlinkSync(originalConfig, configCarrier);
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  const previousAsbConfig = process.env.ASB_CONFIG;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  process.env.ASB_CONFIG = configCarrier;
  try {
    clearPluginIndexCache();
    const namespace = 'resolved-config-target';
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    await stopRemovalAtCrashPoint(asbHome, namespace, 'before-config');
    fs.rmSync(configCarrier);
    fs.symlinkSync(retargetedConfig, configCarrier);

    getSourcesRecord();

    assert.match(fs.readFileSync(originalConfig, 'utf-8'), new RegExp(namespace));
    assert.doesNotMatch(fs.readFileSync(retargetedConfig, 'utf-8'), new RegExp(namespace));
    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(materializedPath), true);
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    if (previousAsbConfig === undefined) delete process.env.ASB_CONFIG;
    else process.env.ASB_CONFIG = previousAsbConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subtree removal recovery preserves foreign content after a crash', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-recovery-'));
  const canonicalRoot = fs.realpathSync.native(root);
  const asbHome = path.join(canonicalRoot, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'subtree-foreign-recovery';
    const { bareRepo } = createBareRemote(canonicalRoot);
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'add source'],
      { cwd: asbHome, stdio: 'pipe' }
    );

    await stopRemovalAtCrashPoint(asbHome, namespace, 'before-config');
    const recoveredFile = path.join(getPluginsDir(), namespace, 'rules', 'v1.md');
    fs.mkdirSync(path.dirname(recoveredFile), { recursive: true });
    fs.writeFileSync(recoveredFile, '# Foreign');

    assert.throws(() => getSourcesRecord(), /foreign changes/);
    assert.equal(fs.readFileSync(recoveredFile, 'utf-8'), '# Foreign');
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source removal recovery rejects a symlinked checkout root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-checkout-recovery-'));
  const canonicalRoot = fs.realpathSync.native(root);
  const asbHome = path.join(canonicalRoot, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    clearPluginIndexCache();
    const namespace = 'symlinked-checkout-recovery';
    createManagedMarketplaceSource(asbHome, namespace);
    await stopRemovalAtCrashPoint(asbHome, namespace, 'after-config');

    const pluginsRoot = getPluginsDir();
    const outsidePlugins = path.join(canonicalRoot, 'outside-plugins');
    fs.renameSync(pluginsRoot, outsidePlugins);
    fs.symlinkSync(outsidePlugins, pluginsRoot);
    const stagedName = fs
      .readdirSync(outsidePlugins)
      .find((name) => name.startsWith(`.removing-${namespace}-`));
    assert.ok(stagedName);
    const sentinel = path.join(outsidePlugins, stagedName, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve');

    assert.throws(() => getSourcesRecord(), /symbolic link/);
    assert.equal(fs.readFileSync(sentinel, 'utf-8'), 'preserve');
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeSource restores verified cache when config removal fails', (t) => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'rollback-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const marketplaceDir = path.join(asbHome, 'rollback-local-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'rollback-local-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    addLocalSource('rollback-local-catalog', marketplaceDir);
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@rollback-local-catalog');
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    const configPath = path.join(fs.realpathSync.native(asbHome), 'config.toml');
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === configPath) {
        throw new Error('injected config write failure');
      }
      return originalRename(from, to);
    });

    assert.throws(() => removeSource('rollback-local-catalog'), /injected config write failure/);

    assert.equal(hasSource('rollback-local-catalog'), true);
    assert.equal(fs.existsSync(materializedPath), true);
  });
});

test('removeSource restores a managed checkout when config removal fails', (t) => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'rollback-managed-entry');
    const catalogParent = path.join(asbHome, 'rollback-managed-catalog');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);
    fs.mkdirSync(path.join(catalogRemote.workDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalogRemote.workDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'rollback-managed-catalog',
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
    execFileSync('git', ['push', 'origin', 'main'], {
      cwd: catalogRemote.workDir,
      stdio: 'pipe',
    });
    addRemoteSource('rollback-managed', { url: catalogRemote.bareRepo, type: 'clone' });
    const plugin = buildPluginIndex().get('remote-plugin@rollback-managed');
    assert.ok(plugin);
    buildPluginIndex().expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    const checkoutPath = path.join(getPluginsDir(), 'rollback-managed');
    const configPath = path.join(fs.realpathSync.native(asbHome), 'config.toml');
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === configPath) {
        throw new Error('injected config write failure');
      }
      return originalRename(from, to);
    });

    assert.throws(() => removeSource('rollback-managed'), /injected config write failure/);

    assert.equal(hasSource('rollback-managed'), true);
    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(materializedPath), true);
    assert.deepEqual(
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.removing-')),
      []
    );
  });
});

test('a descriptor captured before source replacement cannot publish cache afterward', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'stale-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const marketplaceDir = path.join(asbHome, 'stale-local-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'stale-local-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    addLocalSource('stale-local-catalog', marketplaceDir);
    const index = buildPluginIndex();
    const plugin = index.get('remote-plugin@stale-local-catalog');
    assert.ok(plugin);

    removeSource('stale-local-catalog');
    const replacementParent = path.join(asbHome, 'replacement-entry-remote');
    fs.mkdirSync(replacementParent, { recursive: true });
    const replacementRemote = createBareRemote(replacementParent);
    fs.rmSync(path.join(replacementRemote.workDir, 'rules', 'v1.md'));
    fs.writeFileSync(path.join(replacementRemote.workDir, 'rules', 'replacement.md'), '# New');
    execFileSync('git', ['add', '-A'], { cwd: replacementRemote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'replacement'],
      { cwd: replacementRemote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], {
      cwd: replacementRemote.workDir,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'stale-local-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: replacementRemote.bareRepo },
          },
        ],
      })
    );
    addLocalSource('stale-local-catalog', marketplaceDir);

    assert.throws(() => index.expand([plugin.id]), /source .* no longer active/i);
    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const entries = fs.existsSync(cacheRoot)
      ? fs
          .readdirSync(cacheRoot, { recursive: true })
          .filter((entry) => String(entry).endsWith('entry.json'))
      : [];
    assert.deepEqual(entries, []);

    const replacementIndex = buildPluginIndex();
    const replacement = replacementIndex.get('remote-plugin@stale-local-catalog');
    assert.ok(replacement);
    replacementIndex.expand([replacement.id]);
    assert.deepEqual(replacement.components.rules, [
      'remote-plugin@stale-local-catalog:replacement',
    ]);
  });
});

test('source incarnation invalidates deferred descriptors across processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-incarnation-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'aba-entry-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const marketplaceDir = path.join(asbHome, 'aba-local-catalog');
    fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'aba-local-catalog',
        plugins: [
          {
            name: 'remote-plugin',
            source: { source: 'url', url: entryRemote.bareRepo },
          },
        ],
      })
    );
    addLocalSource('aba-local-catalog', marketplaceDir);

    const indexModule = pathToFileURL(path.resolve('src/plugins/index.ts')).href;
    const childSource =
      `import { buildPluginIndex, clearPluginIndexCache } from ${JSON.stringify(indexModule)};` +
      'const index = buildPluginIndex();' +
      'const plugin = index.get("remote-plugin@aba-local-catalog");' +
      'if (!plugin) throw new Error("plugin missing");' +
      'clearPluginIndexCache();' +
      'process.stdout.write("READY\\n");' +
      'await new Promise((resolve) => process.stdin.once("data", resolve));' +
      'try { index.expand([plugin.id]); process.stdout.write("EXPANDED\\n"); }' +
      'catch (error) { process.stdout.write("ERROR:" + error.message + "\\n"); }';
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (output.includes('READY\n')) resolve();
        else if (child?.exitCode !== null) reject(new Error(stderr || 'child exited before ready'));
        else setTimeout(poll, 10);
      };
      poll();
    });

    removeSource('aba-local-catalog');
    addLocalSource('aba-local-catalog', marketplaceDir);
    child.stdin.end('expand\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      child?.on('error', reject);
      child?.on('close', resolve);
    });

    assert.equal(code, 0, stderr);
    assert.match(output, /ERROR:.*Marketplace source .* no longer active/i);
    const cacheRoot = path.join(asbHome, 'state', 'marketplace-plugins');
    const entries = fs.existsSync(cacheRoot)
      ? fs
          .readdirSync(cacheRoot, { recursive: true })
          .filter((entry) => String(entry).endsWith('entry.json'))
      : [];
    assert.deepEqual(entries, []);
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removeSource retains the canonical cache owner after deleting a remote checkout', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const entryParent = path.join(asbHome, 'entry-remote');
    const catalogParent = path.join(asbHome, 'catalog-remote');
    fs.mkdirSync(entryParent, { recursive: true });
    fs.mkdirSync(catalogParent, { recursive: true });
    const entryRemote = createBareRemote(entryParent);
    const catalogRemote = createBareRemote(catalogParent);
    const skillDir = path.join(entryRemote.workDir, 'plugin', 'skills', 'remote-skill');
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
    const plugin = buildPluginIndex().get('remote-plugin@catalog-source');
    assert.ok(plugin);
    buildPluginIndex().expand([plugin.id]);
    const materializedPath = plugin.meta.sourcePath;
    assert.equal(fs.existsSync(materializedPath), true);

    removeSource('catalog-source');

    assert.equal(fs.existsSync(materializedPath), false);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'catalog-source')), false);
  });
});

test('dry-run relative source readers block checkout removal until consumption ends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-source-reader-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const bareRepo = path.join(root, 'catalog.git');
    const workDir = path.join(root, 'catalog-work');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], {
      stdio: 'pipe',
    });
    execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
    fs.mkdirSync(path.join(workDir, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(workDir, 'packages', 'plugin', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(workDir, 'packages', 'plugin', 'commands', 'leased.md'), '# Lease');
    fs.writeFileSync(
      path.join(workDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'leased-catalog',
        plugins: [
          {
            name: 'leased-plugin',
            source: './packages/plugin',
          },
        ],
      })
    );
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'catalog'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
    addRemoteSource('leased', { url: bareRepo, type: 'clone' });

    const indexModule = pathToFileURL(path.resolve('src/plugins/index.ts')).href;
    const cacheModule = pathToFileURL(path.resolve('src/marketplace/cache.ts')).href;
    const readerSource =
      `import { buildPluginIndex } from ${JSON.stringify(indexModule)};` +
      `import { withTemporaryMarketplaceEntryCache } from ${JSON.stringify(cacheModule)};` +
      'await withTemporaryMarketplaceEntryCache(async () => {' +
      'const index = buildPluginIndex();' +
      'const plugin = index.get("leased-plugin@leased");' +
      'if (!plugin) throw new Error("plugin missing");' +
      'index.expand([plugin.id]);' +
      'process.stdout.write(JSON.stringify({ sourcePath: plugin.meta.sourcePath }) + "\\n");' +
      'process.stdin.resume();' +
      'await new Promise((resolve) => process.stdin.on("end", resolve));' +
      '});';
    const reader = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', readerSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.push(reader);
    reader.stdout.setEncoding('utf-8');
    const sourcePath = await new Promise<string>((resolve, reject) => {
      let output = '';
      reader.stdout.on('data', (chunk) => {
        output += chunk;
        const newline = output.indexOf('\n');
        if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)).sourcePath);
      });
      reader.on('error', reject);
      reader.on('close', (code) => {
        if (!output.includes('\n')) reject(new Error(`reader exited before ready: ${code}`));
      });
    });
    assert.equal(fs.readdirSync(getPluginSourceLocksDir()).length, 1);

    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const removerSource = `import { removeSource } from ${JSON.stringify(sourcesModule)};removeSource("leased");`;
    const remover = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', removerSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    children.push(remover);
    let removalFinished = false;
    let removalResult: { code: number | null; stderr: string } | undefined;
    const removal = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      let stderr = '';
      remover.stderr.setEncoding('utf-8');
      remover.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      remover.on('error', reject);
      remover.on('close', (code) => {
        removalFinished = true;
        removalResult = { code, stderr };
        resolve(removalResult);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    assert.equal(
      removalFinished,
      false,
      removalResult?.stderr || JSON.stringify(fs.readdirSync(getPluginSourceLocksDir()))
    );
    assert.equal(fs.existsSync(sourcePath), true);

    reader.stdin.end();
    const result = await removal;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.existsSync(sourcePath), false);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared checkout updates wait for reader leases on every carrier path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-shared-source-reader-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    const namespace = 'shared-reader-owner';
    createLayeredSubdirMarketplaceSource(asbHome, namespace);
    const indexModule = pathToFileURL(path.resolve('src/plugins/index.ts')).href;
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const env = { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome };
    const reader = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { buildPluginIndex } from ${JSON.stringify(indexModule)};const index=buildPluginIndex();if(!index.get(${JSON.stringify(`lower-plugin@${namespace}`)}))throw new Error("plugin missing");process.stdout.write("ready\\n");process.stdin.resume();await new Promise(resolve=>process.stdin.on("end",resolve));`,
      ],
      { cwd: process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    children.push(reader);
    reader.stdout.setEncoding('utf-8');
    await new Promise<void>((resolve, reject) => {
      let output = '';
      reader.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('ready\n')) resolve();
      });
      reader.on('error', reject);
      reader.on('close', (code) => {
        if (!output.includes('ready\n')) reject(new Error(`reader exited before ready: ${code}`));
      });
    });

    const updater = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};const result=updateRemoteSources({profile:"team"},${JSON.stringify(namespace)});if(result[0]?.status!=="updated")throw new Error(result[0]?.error??"update failed");`,
      ],
      { cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    children.push(updater);
    let updateFinished = false;
    let updateStderr = '';
    updater.stderr.setEncoding('utf-8');
    updater.stderr.on('data', (chunk) => {
      updateStderr += chunk;
    });
    const updateClosed = new Promise<number | null>((resolve, reject) => {
      updater.on('error', reject);
      updater.on('close', (code) => {
        updateFinished = true;
        resolve(code);
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(updateFinished, false, updateStderr);

    const readerClosed = new Promise<number | null>((resolve) => reader.once('close', resolve));
    reader.stdin.end();
    assert.equal(await readerClosed, 0);
    assert.equal(await updateClosed, 0, updateStderr);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
    const expectedPath = path.join(path.join(getPluginsDir(), 'subdir-test'), 'nested/lib');
    assert.equal(record['subdir-test'], expectedPath);

    assert.ok(fs.existsSync(path.join(expectedPath, 'rules', 'deep.md')));
  });
});

test('addRemoteSource rejects a missing subdirectory beneath an escaping symlink', () => {
  withTempAsbHome((asbHome) => {
    const remoteParent = path.join(asbHome, 'escaping-subdir-remote');
    fs.mkdirSync(remoteParent, { recursive: true });
    const { bareRepo, workDir } = createBareRemote(remoteParent);
    const outside = path.join(asbHome, 'outside-source');
    fs.mkdirSync(path.join(outside, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'rules', 'sentinel.md'), '# Preserve');
    fs.symlinkSync(outside, path.join(workDir, 'escape'));
    execFileSync('git', ['add', 'escape'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'escape'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });

    assert.throws(
      () =>
        addRemoteSource('escaping-subdir', {
          url: bareRepo,
          type: 'clone',
          subdir: 'escape/missing',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^Configured source subdirectory escapes its source checkout:/);
        assert.doesNotMatch(error.message, /Rollback failed|addition ownership/i);
        return true;
      }
    );
    assert.equal(fs.existsSync(path.join(getPluginsDir(), 'escaping-subdir')), false);
    assert.deepEqual(
      fs
        .readdirSync(getPluginsDir())
        .filter((name) => name.startsWith('.') && name.includes('escaping-subdir')),
      []
    );
    assert.equal(
      fs.readFileSync(path.join(outside, 'rules', 'sentinel.md'), 'utf-8'),
      '# Preserve'
    );
    assert.equal(fs.existsSync(path.join(asbHome, 'config.toml')), false);
  });
});

// ── Subtree source lifecycle ──────────────────────────────────────

/** Create a bare remote repo with one commit containing rules/v1.md */
function createBareRemote(parentDir: string): { bareRepo: string; workDir: string } {
  const bareRepo = path.join(parentDir, 'bare-repo.git');
  const workDir = path.join(parentDir, 'work');
  fs.mkdirSync(bareRepo, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareRepo], { stdio: 'pipe' });
  execFileSync('git', ['clone', bareRepo, workDir], { stdio: 'pipe' });
  fs.mkdirSync(path.join(workDir, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'rules', 'v1.md'), '# V1');
  execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v1'],
    { cwd: workDir, stdio: 'pipe' }
  );
  execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
  return { bareRepo, workDir };
}

function sourceDescriptorKeyForTest(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(['remote', value.url, value.type, value.ref ?? null, value.subdir ?? null])
    )
    .digest('hex');
}

function writeSourceStateForTest(
  namespace: string,
  configPath: string,
  descriptor: Record<string, unknown>,
  marketplacePath: string
): string {
  const canonicalConfigPath = fs.realpathSync.native(configPath);
  const fileName = `${namespace}-${createHash('sha256')
    .update(`${namespace}\0${canonicalConfigPath}`)
    .digest('hex')
    .slice(0, 20)}.json`;
  const filePath = path.join(getPluginSourceStateDir(), fileName);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        version: 1,
        namespace,
        configPath: canonicalConfigPath,
        descriptor,
        descriptorKey: sourceDescriptorKeyForTest(descriptor),
        marketplacePath: path.resolve(marketplacePath),
        incarnation: randomUUID(),
      },
      null,
      2
    )}\n`
  );
  return filePath;
}

async function stopCloneUpdateAfterValidation(
  asbHome: string,
  namespace: string,
  scope?: { profile?: string; project?: string }
): Promise<void> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const childSource =
    'import fs from "node:fs";' +
    `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
    'const originalRename = fs.renameSync.bind(fs);' +
    'let stopped = false;' +
    'fs.renameSync = (from, to) => {' +
    'const result = originalRename(from, to);' +
    'if (!stopped && String(to).endsWith(".json")) {' +
    'const state = JSON.parse(fs.readFileSync(String(to), "utf-8"));' +
    'if (state.addition?.kind === "clone" && state.addition.phase === "validated") {' +
    'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '}' +
    '}' +
    'return result;' +
    '};' +
    `updateRemoteSources(${JSON.stringify(scope)}, ${JSON.stringify(namespace)});`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', childSource],
    {
      cwd: process.cwd(),
      env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  let output = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (output.includes('CHECKPOINT\n')) resolve();
        else if (child.exitCode !== null) reject(new Error(stderr || 'clone update exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(stderr || 'clone validation checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
  } finally {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
  }
}

/** Initialize asbHome as a git repo with an empty config.toml */
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

test('configured subtree rejects symlinked managed roots and namespace prefixes', () => {
  withTempAsbHome((asbHome) => {
    const outside = path.join(asbHome, 'outside-subtree');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      '[plugins.sources]\nlinked = { url = "https://example.com/repo.git", type = "subtree", ref = "main" }\n'
    );

    fs.symlinkSync(outside, getPluginsDir());
    assert.throws(() => getSourcesRecord(), /symbolic link/i);
    fs.rmSync(getPluginsDir(), { force: true });

    fs.mkdirSync(getPluginsDir(), { recursive: true });
    fs.symlinkSync(outside, path.join(getPluginsDir(), 'linked'));
    assert.throws(() => getSourcesRecord(), /symbolic link/i);
  });
});

test('subtree removal requires durable ASB provenance', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(
      path.join(path.dirname(asbHome), 'manual-subtree-remote')
    );
    initAsbAsGitRepo(asbHome);
    const prefix = path.join(getPluginsDir(), 'manual-subtree');
    fs.mkdirSync(path.join(prefix, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'rules', 'manual.md'), '# Manual');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nmanual-subtree = { url = ${JSON.stringify(bareRepo)}, type = "subtree", ref = "main" }\n`
    );
    execFileSync('git', ['add', 'config.toml', 'plugins/manual-subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    execFileSync(
      'git',
      ['commit', '-m', 'manual subtree', '-m', 'git-subtree-dir: plugins/manual-subtree'],
      { cwd: asbHome, stdio: 'pipe' }
    );

    assert.throws(() => removeSource('manual-subtree'), /subtree provenance is missing/i);
    assert.equal(fs.readFileSync(path.join(prefix, 'rules', 'manual.md'), 'utf-8'), '# Manual');
    assert.equal(hasSource('manual-subtree'), true);
  });
});

test('subtree removal rejects ignored residue beneath its prefix', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.join(path.dirname(asbHome), 'residue-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource('subtree-residue', { url: bareRepo, type: 'subtree', ref: 'main' });
    fs.writeFileSync(path.join(asbHome, '.gitignore'), '/plugins/subtree-residue/private.txt\n');
    execFileSync('git', ['add', 'config.toml', '.gitignore'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], { cwd: asbHome, stdio: 'pipe' });
    const residue = path.join(getPluginsDir(), 'subtree-residue', 'private.txt');
    fs.writeFileSync(residue, 'preserve');

    assert.throws(() => removeSource('subtree-residue'), /untracked, or ignored content/i);
    assert.equal(fs.readFileSync(residue, 'utf-8'), 'preserve');
    assert.equal(hasSource('subtree-residue'), true);
  });
});

test('subtree removal retains recovery state when residue appears during config publication', (t) => {
  withTempAsbHome((asbHome) => {
    const namespace = 'late-subtree-residue';
    const { bareRepo } = createBareRemote(path.join(path.dirname(asbHome), 'late-residue-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const configPath = fs.realpathSync.native(path.join(asbHome, 'config.toml'));
    const residue = path.join(getPluginsDir(), namespace, 'foreign.txt');
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = originalRename(from, to);
      if (path.resolve(String(to)) === configPath) {
        fs.mkdirSync(path.dirname(residue), { recursive: true });
        fs.writeFileSync(residue, 'preserve');
      }
      return result;
    });

    assert.throws(() => removeSource(namespace), /remaining subtree content/i);

    assert.equal(fs.readFileSync(residue, 'utf-8'), 'preserve');
    assert.doesNotMatch(fs.readFileSync(configPath, 'utf-8'), new RegExp(namespace));
    assert.throws(() => getSourcesRecord(), /remaining subtree content/i);
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).some((name) => name.endsWith('.json')),
      true
    );
  });
});

test('subtree addition recovers a crash before config publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-add-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'recoverable-subtree-add';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    initAsbAsGitRepo(asbHome);
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: asbHome,
      encoding: 'utf-8',
    }).trim();
    const started = await startSubtreeAddAtConfigPublication(asbHome, namespace, bareRepo);
    child = started.child;
    const stateFile = fs
      .readdirSync(getPluginSourceStateDir())
      .find((name) => name.endsWith('.json'));
    assert.ok(stateFile);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(getPluginSourceStateDir(), stateFile), 'utf-8')
    );
    const subtreeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: asbHome,
      encoding: 'utf-8',
    }).trim();
    assert.deepEqual(
      {
        kind: persisted.addition?.kind,
        configPath: persisted.addition?.configPath,
        repoRoot: persisted.addition?.repoRoot,
        prefix: persisted.addition?.prefix,
        headBefore: persisted.addition?.headBefore,
        headRef: persisted.addition?.headRef,
        headAfter: persisted.addition?.headAfter,
      },
      {
        kind: 'subtree',
        configPath: fs.realpathSync.native(path.join(asbHome, 'config.toml')),
        repoRoot: fs.realpathSync.native(asbHome),
        prefix: `plugins/${namespace}`,
        headBefore,
        headRef: 'refs/heads/main',
        headAfter: subtreeHead,
      }
    );
    assert.equal(
      execFileSync('git', ['show', '-s', '--format=%s', subtreeHead], {
        cwd: asbHome,
        encoding: 'utf-8',
      }).trim(),
      `asb source add ${persisted.addition.transactionId}`
    );
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    const sources = getSourcesRecord();

    assert.equal(namespace in sources, false, started.stderr());
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace)), false);
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: asbHome, encoding: 'utf-8' }).trim(),
      headBefore
    );
    assert.deepEqual(
      fs.existsSync(getPluginSourceStateDir())
        ? fs.readdirSync(getPluginSourceStateDir()).filter((name) => name.endsWith('.json'))
        : [],
      []
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subtree recovery refuses a third tracked prefix state after publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-third-state-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'third-state';
    const { bareRepo, workDir } = createBareRemote(path.join(root, 'remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const childSource =
      'import fs from "node:fs";' +
      `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
      'const originalRemove = fs.rmSync.bind(fs);' +
      'let stopped = false;' +
      'fs.rmSync = (target, options) => {' +
      'if (!stopped && String(target).includes("/.subtree-")) {' +
      'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
      '}' +
      'return originalRemove(target, options);' +
      '};' +
      `updateRemoteSources(undefined, ${JSON.stringify(namespace)});`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (output.includes('CHECKPOINT\n')) resolve();
        else if (child?.exitCode !== null)
          reject(new Error(stderr || 'subtree update exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(stderr || 'subtree checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;
    const tracked = path.join(getPluginsDir(), namespace, 'rules', 'v1.md');
    fs.writeFileSync(tracked, '# Foreign');

    assert.throws(() => getSourcesRecord(), /foreign changes beneath its prefix/i);
    assert.equal(fs.readFileSync(tracked, 'utf-8'), '# Foreign');
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      states.some((state) => state.addition),
      true
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subtree recovery rolls back a populated stage that was not validated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-validation-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const namespace = 'unvalidated-subtree';
    const { bareRepo, workDir } = createBareRemote(path.join(root, 'remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: asbHome,
      encoding: 'utf-8',
    }).trim();
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const childSource =
      'import fs from "node:fs";' +
      `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
      'const originalRename = fs.renameSync.bind(fs);' +
      'let stopped = false;' +
      'fs.renameSync = (from, to) => {' +
      'const result = originalRename(from, to);' +
      'if (!stopped && String(to).endsWith(".json")) {' +
      'const state = JSON.parse(fs.readFileSync(String(to), "utf-8"));' +
      'if (state.addition?.kind === "subtree" && state.addition.headAfter && state.addition.phase === "constructing") {' +
      'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
      '}' +
      '}' +
      'return result;' +
      '};' +
      `updateRemoteSources(undefined, ${JSON.stringify(namespace)});`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', childSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (output.includes('CHECKPOINT\n')) resolve();
        else if (child?.exitCode !== null)
          reject(new Error(stderr || 'subtree update exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(stderr || 'validation checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const closed = new Promise<void>((resolve) => child?.once('close', () => resolve()));
    child.kill('SIGKILL');
    await closed;
    child = undefined;

    getSourcesRecord();

    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: asbHome, encoding: 'utf-8' }).trim(),
      headBefore
    );
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v2.md')), false);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      states.some((state) => state.addition),
      false
    );
  } finally {
    child?.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subtree add rollback preserves a concurrent commit', (t) => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);
    const foreignPath = path.join(asbHome, 'foreign.txt');
    fs.writeFileSync(foreignPath, '# Initial');
    execFileSync('git', ['add', 'foreign.txt'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'foreign'],
      { cwd: asbHome, stdio: 'pipe' }
    );
    const configPath = fs.realpathSync.native(path.join(asbHome, 'config.toml'));
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === configPath) {
        fs.writeFileSync(foreignPath, '# Concurrent commit');
        execFileSync('git', ['add', 'foreign.txt'], { cwd: asbHome, stdio: 'pipe' });
        execFileSync(
          'git',
          ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'concurrent'],
          { cwd: asbHome, stdio: 'pipe' }
        );
        throw new Error('injected config write failure');
      }
      return originalRename(from, to);
    });

    assert.throws(
      () =>
        addRemoteSource('subtree-concurrent-commit', {
          url: bareRepo,
          type: 'subtree',
          ref: 'main',
        }),
      /injected config write failure/
    );

    assert.equal(fs.readFileSync(foreignPath, 'utf-8'), '# Concurrent commit');
  });
});

test('subtree add rollback preserves concurrent uncommitted content', (t) => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);
    const foreignPath = path.join(asbHome, 'foreign.txt');
    fs.writeFileSync(foreignPath, '# Initial');
    execFileSync('git', ['add', 'foreign.txt'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'foreign'],
      { cwd: asbHome, stdio: 'pipe' }
    );
    const configPath = fs.realpathSync.native(path.join(asbHome, 'config.toml'));
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === configPath) {
        fs.writeFileSync(foreignPath, '# Concurrent edit');
        throw new Error('injected config write failure');
      }
      return originalRename(from, to);
    });

    assert.throws(
      () =>
        addRemoteSource('subtree-concurrent-edit', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /injected config write failure/
    );

    assert.equal(fs.readFileSync(foreignPath, 'utf-8'), '# Concurrent edit');
  });
});

test('subtree add rollback refuses a different branch attached at the same commit', (t) => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);
    const configPath = fs.realpathSync.native(path.join(asbHome, 'config.toml'));
    const originalRename = fs.renameSync.bind(fs);
    let subtreeHead = '';
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (path.resolve(String(to)) === configPath) {
        subtreeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: asbHome,
          encoding: 'utf-8',
        }).trim();
        execFileSync('git', ['switch', '-c', 'foreign'], { cwd: asbHome, stdio: 'pipe' });
        throw new Error('injected config write failure');
      }
      return originalRename(from, to);
    });

    assert.throws(
      () =>
        addRemoteSource('subtree-branch-switch', {
          url: bareRepo,
          type: 'subtree',
          ref: 'main',
        }),
      /Rollback refused:.*symbolic HEAD changed|injected config write failure/s
    );

    assert.equal(
      execFileSync('git', ['symbolic-ref', 'HEAD'], {
        cwd: asbHome,
        encoding: 'utf-8',
      }).trim(),
      'refs/heads/foreign'
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: asbHome, encoding: 'utf-8' }).trim(),
      subtreeHead
    );
  });
});

test('subtree lifecycle: add → update → remove', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(path.dirname(asbHome));
    initAsbAsGitRepo(asbHome);

    // Add as subtree
    addRemoteSource('st', { url: bareRepo, type: 'subtree', ref: 'main' });
    assert.equal(hasSource('st'), true);
    const pluginDir = path.join(getPluginsDir(), 'st');
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'v1.md')));
    // No .git inside (it's a subtree, not a clone)
    assert.equal(fs.existsSync(path.join(pluginDir, '.git')), false);

    // Commit the config change so the tree is clean for subtree pull
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

    // Push v2 to remote
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });

    // Update (subtree pull)
    const results = updateRemoteSources();
    assert.equal(results.length, 1);
    if (results[0].status === 'error') assert.fail(results[0].error);
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'v2.md')));

    // Remove
    removeSource('st');
    assert.equal(hasSource('st'), false);
    assert.equal(fs.existsSync(pluginDir), false);
  });
});

test('subtree update completes when the remote tree is already current', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'subtree-noop';
    const { bareRepo } = createBareRemote(path.join(path.dirname(asbHome), 'subtree-noop-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: asbHome,
      encoding: 'utf-8',
    }).trim();

    const result = updateRemoteSources(undefined, namespace);

    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: asbHome, encoding: 'utf-8' }).trim(),
      headBefore
    );
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      states.some((state) => state.addition),
      false
    );
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).some((name) => name.startsWith('.subtree-')),
      false
    );
  });
});

test('subtree lifecycles for different namespaces share one repository lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-repo-lock-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  const children: Array<ReturnType<typeof spawn>> = [];
  try {
    initAsbAsGitRepo(asbHome);
    const first = createBareRemote(path.join(root, 'first-remote'));
    const second = createBareRemote(path.join(root, 'second-remote'));
    addRemoteSource('repo-lock-first', { url: first.bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure first subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    addRemoteSource('repo-lock-second', { url: second.bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure second subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
    const release = path.join(root, 'release');
    const holderSource =
      'import fs from "node:fs";' +
      `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};` +
      `const release = ${JSON.stringify(release)};` +
      'const originalWrite = fs.writeFileSync.bind(fs);' +
      'let stopped = false;' +
      'fs.writeFileSync = (target, data, options) => {' +
      'if (!stopped && String(data).includes("\\"addition\\"") && String(data).includes("repo-lock-first")) {' +
      'stopped = true;process.stdout.write("CHECKPOINT\\n");' +
      'while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);' +
      '}' +
      'return originalWrite(target, data, options);' +
      '};' +
      'updateRemoteSources(undefined, "repo-lock-first");';
    const holder = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', holderSource],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    children.push(holder);
    holder.stdout.setEncoding('utf-8');
    holder.stderr.setEncoding('utf-8');
    let holderOutput = '';
    let holderError = '';
    holder.stdout.on('data', (chunk) => {
      holderOutput += chunk;
    });
    holder.stderr.on('data', (chunk) => {
      holderError += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const poll = () => {
        if (holderOutput.includes('CHECKPOINT\n')) resolve();
        else if (holder.exitCode !== null) reject(new Error(holderError || 'holder exited early'));
        else if (Date.now() >= deadline)
          reject(new Error(holderError || 'holder checkpoint timed out'));
        else setTimeout(poll, 10);
      };
      poll();
    });
    const contender = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { updateRemoteSources } from ${JSON.stringify(sourcesModule)};const result=updateRemoteSources(undefined,"repo-lock-second");if(result[0]?.status!=="updated")throw new Error(result[0]?.error);`,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ASB_HOME: asbHome, ASB_AGENTS_HOME: asbHome },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    children.push(contender);
    let contenderError = '';
    contender.stderr.setEncoding('utf-8');
    contender.stderr.on('data', (chunk) => {
      contenderError += chunk;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(contender.exitCode, null, contenderError);
    assert.equal(
      fs
        .readdirSync(getPluginSourceStateDir())
        .some((name) => name.startsWith('.subtree-repo-lock-second-')),
      false
    );

    fs.writeFileSync(release, 'release');
    const [holderCode, contenderCode] = await Promise.all([
      new Promise<number | null>((resolve) => holder.once('close', resolve)),
      new Promise<number | null>((resolve) => contender.once('close', resolve)),
    ]);
    assert.equal(holderCode, 0, holderError);
    assert.equal(contenderCode, 0, contenderError);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subtree update adopts verified pre-provenance history and publishes from a stage', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo, workDir } = createBareRemote(
      path.join(path.dirname(asbHome), 'legacy-subtree-remote')
    );
    initAsbAsGitRepo(asbHome);
    addRemoteSource('legacy-subtree', { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure legacy subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.rmSync(getPluginSourceStateDir(), { recursive: true, force: true });
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir, stdio: 'pipe' });

    const result = updateRemoteSources(undefined, 'legacy-subtree');

    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), 'legacy-subtree', 'rules', 'v2.md'), 'utf-8'),
      '# V2'
    );
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).some((name) => name.endsWith('.json')),
      true
    );
  });
});

test('legacy subtree adoption rejects a trailer-valid commit with the wrong prefix tree', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'forged-subtree-tree';
    const { bareRepo } = createBareRemote(path.join(path.dirname(asbHome), 'forged-tree-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    const tracked = path.join(getPluginsDir(), namespace, 'rules', 'v1.md');
    fs.writeFileSync(tracked, '# Forged');
    execFileSync('git', ['add', `plugins/${namespace}`], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '--amend', '--no-edit'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure forged subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.rmSync(getPluginSourceStateDir(), { recursive: true, force: true });

    assert.throws(() => removeSource(namespace), /subtree provenance is missing/i);
    assert.equal(fs.readFileSync(tracked, 'utf-8'), '# Forged');
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
    // asbHome is NOT a git repo

    assert.throws(
      () => addRemoteSource('no-git', { url: bareRepo, type: 'subtree', ref: 'main' }),
      /git repo root/
    );
  });
});

test('subtree errors when ASB_HOME is a subdirectory of a git repo', () => {
  withTempAsbHome((asbHome) => {
    const { bareRepo } = createBareRemote(path.dirname(asbHome));
    // Init git in the PARENT dir, making asbHome a subdirectory
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

    // Dirty the tree
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

test('scoped managed source directories remain direct in unrelated discovery views', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'profile-managed';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'profile-managed-remote'));
    const direct = path.join(getPluginsDir(), 'direct-unowned');
    fs.mkdirSync(path.join(direct, 'rules'), { recursive: true });

    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, profile);

    assert.equal(getSourcesRecord()[namespace], path.join(getPluginsDir(), namespace));
    assert.equal(getSourcesRecord()['direct-unowned'], direct);
    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
    const checkout = path.join(getPluginsDir(), namespace);
    fs.rmSync(checkout, { recursive: true, force: true });
    fs.mkdirSync(path.join(checkout, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'rules', 'foreign.md'), '# Foreign');
    assert.equal(getSourcesRecord()[namespace], checkout);
  });
});

test('malformed lifecycle state still suppresses scoped checkout discovery', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'malformed-scoped-owner';
    const scope = { profile: 'scoped' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'malformed-state-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, scope);
    const stateFile = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(stateFile);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    fs.writeFileSync(stateFile, `${JSON.stringify({ ...state, version: 999 }, null, 2)}\n`);

    assert.equal(getSourcesRecord()[namespace], undefined);
    assert.equal(getSourcesRecord(scope)[namespace], path.join(getPluginsDir(), namespace));
    assert.throws(() => removeSource(namespace, scope), /malformed ownership state/);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace)), true);
  });
});

test('clone publication revalidates the active checkout and preserves late tampering', (t) => {
  withTempAsbHome((asbHome) => {
    const namespace = 'late-clone-tamper';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'late-clone-remote'));
    const checkout = path.join(getPluginsDir(), namespace);
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = originalRename(from, to);
      if (path.resolve(String(to)) === checkout) {
        fs.writeFileSync(path.join(checkout, 'rules', 'v1.md'), '# Tampered');
      }
      return result;
    });

    assert.throws(
      () => addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }),
      /local changes|checkout.*changed/i
    );
    assert.equal(fs.existsSync(checkout), false);
    const preserved = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.preserved-${namespace}-`));
    assert.ok(preserved);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), preserved, 'rules', 'v1.md'), 'utf-8'),
      '# Tampered'
    );
    assert.doesNotMatch(
      fs.existsSync(path.join(asbHome, 'config.toml'))
        ? fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8')
        : '',
      new RegExp(namespace)
    );
  });
});

test('clone removal revalidates its staged checkout before disposal', (t) => {
  withTempAsbHome((asbHome) => {
    const namespace = 'late-remove-tamper';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'late-remove-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = originalRename(from, to);
      if (
        path.resolve(String(from)) === checkout &&
        path.basename(String(to)).startsWith(`.removing-${namespace}-`)
      ) {
        fs.writeFileSync(path.join(String(to), 'rules', 'v1.md'), '# Late mutation');
      }
      return result;
    });

    removeSource(namespace);

    assert.equal(fs.existsSync(checkout), false);
    const preserved = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.preserved-${namespace}-`));
    assert.ok(preserved);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), preserved, 'rules', 'v1.md'), 'utf-8'),
      '# Late mutation'
    );
  });
});

test('inactive clone retirement stages and preserves late tampering', (t) => {
  withTempAsbHome((asbHome) => {
    const namespace = 'inactive-retirement';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'inactive-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.writeFileSync(path.join(asbHome, 'config.toml'), '[plugins]\nenabled = []\n');
    const replacement = path.join(asbHome, 'replacement');
    fs.mkdirSync(path.join(replacement, 'rules'), { recursive: true });
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      const result = originalRename(from, to);
      if (
        path.resolve(String(from)) === checkout &&
        path.basename(String(to)).startsWith(`.removing-${namespace}-`)
      ) {
        fs.writeFileSync(path.join(String(to), 'rules', 'v1.md'), '# Late retirement mutation');
      }
      return result;
    });

    addLocalSource(namespace, replacement);

    const preserved = fs
      .readdirSync(getPluginsDir())
      .find((name) => name.startsWith(`.preserved-${namespace}-`));
    assert.ok(preserved);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), preserved, 'rules', 'v1.md'), 'utf-8'),
      '# Late retirement mutation'
    );
    assert.equal(getSourcesRecord()[namespace], replacement);
  });
});

test('inactive retirement recovery transfers state across every locked config carrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-inactive-owner-transfer-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    clearPluginIndexCache();
    const namespace = 'inactive-carrier-transfer';
    const profile = { profile: 'team' };
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    const userConfig = fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8');
    fs.writeFileSync(getProfileConfigPath('team'), userConfig);
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).filter((name) => name.endsWith('.json')).length,
      2
    );
    fs.writeFileSync(path.join(asbHome, 'config.toml'), '[plugins]\nenabled = []\n');
    fs.writeFileSync(getProfileConfigPath('team'), '[plugins]\nenabled = []\n');
    const replacement = path.join(root, 'replacement');
    fs.mkdirSync(path.join(replacement, 'rules'), { recursive: true });

    await stopInactiveRetirementAfterState(asbHome, namespace, replacement);
    fs.writeFileSync(path.join(asbHome, 'config.toml'), userConfig);

    assert.equal(getSourcesRecord(profile)[namespace], checkoutPath);
    assert.equal(fs.existsSync(path.join(checkoutPath, 'rules', 'v1.md')), true);
    assert.equal(fs.existsSync(materializedPath), true);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(states.length, 1);
    assert.equal(states[0].configPath, fs.realpathSync.native(path.join(asbHome, 'config.toml')));
    assert.equal(states[0].removal, undefined);
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('clone removal preserves ignored content and hidden index changes', () => {
  withTempAsbHome((asbHome) => {
    for (const variant of ['ignored', 'assume-unchanged', 'skip-worktree'] as const) {
      const namespace = `clone-${variant}`;
      const { bareRepo } = createBareRemote(path.join(asbHome, `${variant}-remote`));
      addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
      const checkout = path.join(getPluginsDir(), namespace);
      if (variant === 'ignored') {
        fs.appendFileSync(path.join(checkout, '.git', 'info', 'exclude'), 'private.txt\n');
        fs.writeFileSync(path.join(checkout, 'private.txt'), 'preserve ignored');
      } else {
        const flag = variant === 'assume-unchanged' ? '--assume-unchanged' : '--skip-worktree';
        execFileSync('git', ['update-index', flag, 'rules/v1.md'], {
          cwd: checkout,
          stdio: 'pipe',
        });
        fs.writeFileSync(path.join(checkout, 'rules', 'v1.md'), `preserve ${variant}`);
      }

      removeSource(namespace);

      const preserved = fs
        .readdirSync(getPluginsDir())
        .find((name) => name.startsWith(`.preserved-${namespace}-`));
      assert.ok(preserved, variant);
      const preservedPath = path.join(getPluginsDir(), preserved);
      assert.equal(
        fs.readFileSync(
          variant === 'ignored'
            ? path.join(preservedPath, 'private.txt')
            : path.join(preservedPath, 'rules', 'v1.md'),
          'utf-8'
        ),
        variant === 'ignored' ? 'preserve ignored' : `preserve ${variant}`
      );
    }
  });
});

test('subtree removal rejects hidden index state beneath its prefix', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'subtree-hidden-index';
    const { bareRepo } = createBareRemote(path.join(path.dirname(asbHome), 'hidden-index-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const relative = `plugins/${namespace}/rules/v1.md`;
    execFileSync('git', ['update-index', '--skip-worktree', relative], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const tracked = path.join(asbHome, relative);
    fs.writeFileSync(tracked, '# Hidden mutation');

    assert.throws(() => removeSource(namespace), /hidden index|index state/i);
    assert.equal(fs.readFileSync(tracked, 'utf-8'), '# Hidden mutation');
    assert.equal(hasSource(namespace), true);
  });
});

test('profile-scoped subtree lifecycle ignores all held config locks', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'profile-subtree';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(
      path.join(path.dirname(asbHome), 'profile-subtree-remote')
    );
    initAsbAsGitRepo(asbHome);

    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' }, profile);

    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
  });
});

test('legacy clone adoption safely creates a missing Git exclude path', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'missing-exclude';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'missing-exclude-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    fs.rmSync(getPluginSourceStateDir(), { recursive: true, force: true });
    fs.rmSync(path.join(checkout, '.asb-source-owner'));
    fs.rmSync(path.join(checkout, '.git', 'info'), { recursive: true, force: true });

    const result = updateRemoteSources(undefined, namespace);

    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.match(
      fs.readFileSync(path.join(checkout, '.git', 'info', 'exclude'), 'utf-8'),
      /^\.asb-source-owner$/m
    );
  });
});

test('removal recovery decides from its original owning config carrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-removal-owner-carrier-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'carrier-recovery';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(root, 'carrier-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    await stopRemovalAtCrashPoint(asbHome, namespace, 'before-config', profile);
    const local = path.join(root, 'profile-local');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = ${JSON.stringify(local)}\n`
    );

    assert.equal(getSourcesRecord(profile)[namespace], local);
    assert.equal(getSourcesRecord()[namespace], checkout);
    assert.equal(fs.existsSync(path.join(checkout, 'rules', 'v1.md')), true);
  } finally {
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removal recovery transfers staged checkout and cache to a recorded matching carrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-removal-owner-transfer-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    clearPluginIndexCache();
    const namespace = 'carrier-transfer';
    const profile = { profile: 'team' };
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    const userStateFile = fs
      .readdirSync(getPluginSourceStateDir())
      .find((name) => name.endsWith('.json'));
    assert.ok(userStateFile);
    const userState = JSON.parse(
      fs.readFileSync(path.join(getPluginSourceStateDir(), userStateFile), 'utf-8')
    );
    const profileConfig = `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(userState.descriptor.url)}, type = "clone" }\n`;
    fs.writeFileSync(getProfileConfigPath('team'), profileConfig);
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    assert.equal(
      fs.readdirSync(getPluginSourceStateDir()).filter((name) => name.endsWith('.json')).length,
      2
    );
    fs.writeFileSync(getProfileConfigPath('team'), '[plugins]\nenabled = []\n');

    await stopRemovalAtCrashPoint(asbHome, namespace, 'after-config', profile);
    assert.equal(fs.existsSync(checkoutPath), false);
    assert.equal(fs.existsSync(materializedPath), false);
    fs.writeFileSync(getProfileConfigPath('team'), profileConfig);

    assert.equal(getSourcesRecord(profile)[namespace], checkoutPath);
    assert.equal(fs.existsSync(path.join(checkoutPath, 'rules', 'v1.md')), true);
    assert.equal(fs.existsSync(materializedPath), true);
    assert.equal(getSourcesRecord()[namespace], checkoutPath);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(states.length, 1);
    assert.equal(states[0].configPath, fs.realpathSync.native(getProfileConfigPath('team')));
    assert.equal(states[0].removal, undefined);
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removal recovery transfers a staged subtree to a recorded matching carrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subtree-owner-transfer-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'subtree-carrier-transfer';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(root, 'subtree-transfer-remote'));
    const profileConfig = `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(bareRepo)}, type = "subtree", ref = "main" }\n`;
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure user subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.writeFileSync(getProfileConfigPath('team'), profileConfig);
    execFileSync('git', ['add', 'team.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'configure profile subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    fs.writeFileSync(getProfileConfigPath('team'), '[plugins]\nenabled = []\n');
    execFileSync('git', ['add', 'team.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'clear profile subtree'], {
      cwd: asbHome,
      stdio: 'pipe',
    });

    await stopRemovalAtCrashPoint(asbHome, namespace, 'after-config-publication', profile);
    const tracked = path.join(getPluginsDir(), namespace, 'rules', 'v1.md');
    assert.equal(fs.existsSync(tracked), false);
    fs.writeFileSync(getProfileConfigPath('team'), profileConfig);
    const pendingStates = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(
      pendingStates.some((state) => state.removal?.subtree),
      true,
      JSON.stringify(pendingStates)
    );

    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
    assert.equal(fs.existsSync(tracked), true);
    assert.equal(fs.readFileSync(tracked, 'utf-8'), '# V1');
    assert.equal(getSourcesRecord()[namespace], path.join(getPluginsDir(), namespace));
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(states.length, 1);
    assert.equal(states[0].configPath, fs.realpathSync.native(getProfileConfigPath('team')));
    assert.equal(states[0].removal, undefined);
  } finally {
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared subtree updates propagate provenance to every recorded carrier', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'shared-subtree-provenance';
    const remote = createBareRemote(path.join(path.dirname(asbHome), 'shared-subtree-remote'));
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: remote.bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record user carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(remote.bareRepo)}, type = "subtree", ref = "main" }\n`
    );
    execFileSync('git', ['add', 'team.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record profile carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const adopted = updateRemoteSources({ profile: 'team' }, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    fs.writeFileSync(path.join(remote.workDir, 'rules', 'v1.md'), '# V2\n');
    execFileSync('git', ['add', '.'], { cwd: remote.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: remote.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: remote.workDir, stdio: 'pipe' });

    const profileUpdate = updateRemoteSources({ profile: 'team' }, namespace);
    const userUpdate = updateRemoteSources(undefined, namespace);

    assert.equal(profileUpdate[0]?.status, 'updated', profileUpdate[0]?.error);
    assert.equal(userUpdate[0]?.status, 'updated', userUpdate[0]?.error);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md'), 'utf-8'),
      '# V2\n'
    );
    const trees = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace)
      .map((state) => state.subtree?.tree);
    assert.equal(trees.length, 2);
    assert.equal(new Set(trees).size, 1);
  });
});

test('subtree adoption rejects a conflicting recorded physical owner', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'conflicting-subtree-owner';
    const remoteA = createBareRemote(path.join(path.dirname(asbHome), 'subtree-remote-a'));
    const remoteB = createBareRemote(path.join(path.dirname(asbHome), 'subtree-remote-b'));
    fs.writeFileSync(path.join(remoteB.workDir, 'rules', 'v1.md'), '# Remote B\n');
    execFileSync('git', ['add', '.'], { cwd: remoteB.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'remote b'],
      { cwd: remoteB.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: remoteB.workDir, stdio: 'pipe' });
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: remoteA.bareRepo, type: 'subtree', ref: 'main' });
    execFileSync('git', ['add', 'config.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record user carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(remoteB.bareRepo)}, type = "subtree", ref = "main" }\n`
    );
    execFileSync('git', ['add', 'team.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record conflicting carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    const before = fs.readFileSync(
      path.join(getPluginsDir(), namespace, 'rules', 'v1.md'),
      'utf-8'
    );

    const conflicting = updateRemoteSources({ profile: 'team' }, namespace);
    const original = updateRemoteSources(undefined, namespace);

    assert.equal(conflicting[0]?.status, 'error');
    assert.match(conflicting[0]?.error ?? '', /owner conflicts/);
    assert.equal(
      fs.readFileSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md'), 'utf-8'),
      before
    );
    assert.equal(original[0]?.status, 'error');
    assert.match(original[0]?.error ?? '', /owner conflicts/);
  });
});

test('subtree adoption rejects a recorded clone physical owner', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'clone-subtree-owner-conflict';
    const remote = createBareRemote(path.join(path.dirname(asbHome), 'clone-subtree-remote'));
    addRemoteSource(namespace, { url: remote.bareRepo, type: 'clone', ref: 'main' });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    execFileSync('git', ['add', '.'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record clone carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(remote.bareRepo)}, type = "subtree", ref = "main" }\n`
    );
    execFileSync('git', ['add', 'team.toml'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record subtree carrier'], {
      cwd: asbHome,
      stdio: 'pipe',
    });

    const result = updateRemoteSources({ profile: 'team' }, namespace);

    assert.equal(result[0]?.status, 'error');
    assert.match(result[0]?.error ?? '', /owner conflicts/);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
  });
});

test('removing a lower carrier retains an out-of-chain profile checkout and cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'out-of-chain-owner';
    const profile = { profile: 'team' };
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    fs.writeFileSync(
      getProfileConfigPath('team'),
      fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8')
    );
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);

    removeSource(namespace);

    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(materializedPath), true);
    assert.equal(getSourcesRecord(profile)[namespace], checkoutPath);
    assert.equal(fs.existsSync(getSourcesRecord(profile)[namespace]), true);
  });
});

test('removing one profile retains a sibling profile physical owner', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'sibling-profile-owner';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'sibling-profile-remote'));
    const first = { profile: 'one' };
    const second = { profile: 'two' };
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, first);
    fs.writeFileSync(
      getProfileConfigPath('two'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(bareRepo)}, type = "clone", ref = "main" }\n`
    );
    const adopted = updateRemoteSources(second, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    const checkout = path.join(getPluginsDir(), namespace);

    removeSource(namespace, first);

    assert.equal(fs.existsSync(checkout), true);
    assert.equal(getSourcesRecord(second)[namespace], checkout);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace);
    assert.equal(states.length, 1);
    assert.equal(states[0].configPath, fs.realpathSync.native(getProfileConfigPath('two')));
  });
});

test('removing an A-B-A project carrier retains every deeper cache owner', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'three-layer-cache-owner';
    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot);
    const { catalogUrl, checkoutPath, lowerMaterialized, higherMaterialized } =
      createLayeredSubdirMarketplaceSource(asbHome, namespace);
    fs.writeFileSync(
      getProjectConfigPath(projectRoot),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(catalogUrl)}, type = "clone", ref = "main", subdir = "lower" }\n`
    );
    const scope = { profile: 'team', project: projectRoot };
    const projectIndex = buildPluginIndex(scope);
    const projectPlugin = projectIndex.get(`lower-plugin@${namespace}`);
    assert.ok(projectPlugin);
    projectIndex.expand([projectPlugin.id]);
    clearPluginIndexCache();

    removeSource(namespace, scope);

    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), true);
    assert.equal(getSourcesRecord()[namespace], path.join(checkoutPath, 'lower'));
    assert.equal(
      getSourcesRecord({ profile: 'team' })[namespace],
      path.join(checkoutPath, 'higher')
    );
  });
});

test('removing a configured carrier retains a matching direct source cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'direct-cache-owner';
    const sourceRoot = path.join(getPluginsDir(), namespace);
    const entry = createBareRemote(path.join(asbHome, 'direct-cache-entry'));
    fs.mkdirSync(path.join(sourceRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: namespace,
        plugins: [{ name: 'external', source: { source: 'url', url: entry.bareRepo } }],
      })
    );
    let index = buildPluginIndex();
    let plugin = index.get(`external@${namespace}`);
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materialized = plugin.meta.sourcePath;
    clearPluginIndexCache();
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = ${JSON.stringify(sourceRoot)}\n`
    );
    index = buildPluginIndex({ profile: 'team' });
    plugin = index.get(`external@${namespace}`);
    assert.ok(plugin);
    index.expand([plugin.id]);
    clearPluginIndexCache();

    removeSource(namespace, { profile: 'team' });

    assert.equal(getSourcesRecord()[namespace], sourceRoot);
    assert.equal(fs.existsSync(materialized), true);
    index = buildPluginIndex();
    assert.doesNotThrow(() => index.expand([`external@${namespace}`]));
  });
});

test('removing an identical higher-layer descriptor retains shared physical state', () => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const namespace = 'shared-layer-owner';
    const { checkoutPath, materializedPath } = createManagedMarketplaceSource(asbHome, namespace);
    const profile = { profile: 'team' };
    const stateFile = fs
      .readdirSync(getPluginSourceStateDir())
      .find((name) => name.endsWith('.json'));
    assert.ok(stateFile);
    const state = JSON.parse(
      fs.readFileSync(path.join(getPluginSourceStateDir(), stateFile), 'utf-8')
    );
    const profileUrl = `file://audit-user:audit-password@localhost${state.descriptor.url}`;
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(profileUrl)}, type = "clone" }\n`
    );

    removeSource(namespace, profile);

    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(materializedPath), true);
    assert.equal(getSourcesRecord()[namespace], checkoutPath);
    assert.doesNotMatch(
      fs.readFileSync(getProfileConfigPath('team'), 'utf-8'),
      new RegExp(namespace)
    );
  });
});

test('removing a higher subdir owner retains the shared checkout and lower cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'layered-subdir-owner';
    const profile = { profile: 'team' };
    const { checkoutPath, lowerMaterialized, higherMaterialized } =
      createLayeredSubdirMarketplaceSource(asbHome, namespace);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), true);

    removeSource(namespace, profile);

    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), false);
    assert.equal(getSourcesRecord()[namespace], path.join(checkoutPath, 'lower'));
    assert.doesNotMatch(
      fs.readFileSync(getProfileConfigPath('team'), 'utf-8'),
      new RegExp(namespace)
    );
  });
});

test('inactive higher subdir retirement retains the shared checkout and lower cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'inactive-layered-subdir';
    const profile = { profile: 'team' };
    const { checkoutPath, lowerMaterialized, higherMaterialized } =
      createLayeredSubdirMarketplaceSource(asbHome, namespace);
    fs.writeFileSync(getProfileConfigPath('team'), '[plugins]\nenabled = []\n');
    const replacement = path.join(asbHome, 'replacement');
    fs.mkdirSync(path.join(replacement, 'rules'), { recursive: true });

    addLocalSource(namespace, replacement, profile);

    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), false);
    assert.equal(getSourcesRecord()[namespace], path.join(checkoutPath, 'lower'));
    assert.equal(getSourcesRecord(profile)[namespace], replacement);
  });
});

test('same-checkout subdir rotation preserves checkout provenance', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'subdir-rotation';
    const catalog = createBareRemote(path.join(asbHome, 'subdir-rotation-catalog'));
    for (const [subdir, pluginName] of [
      ['lower', 'lower-plugin'],
      ['higher', 'higher-plugin'],
    ] as const) {
      const manifestDir = path.join(catalog.workDir, subdir, '.claude-plugin');
      const rulesDir = path.join(catalog.workDir, subdir, 'plugins', pluginName, 'rules');
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'rule.md'), '# Rule\n');
      fs.writeFileSync(
        path.join(manifestDir, 'marketplace.json'),
        JSON.stringify({
          name: `${subdir}-catalog`,
          plugins: [{ name: pluginName, source: `./plugins/${pluginName}` }],
        })
      );
    }
    execFileSync('git', ['add', '.'], { cwd: catalog.workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'subdirs'],
      { cwd: catalog.workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: catalog.workDir, stdio: 'pipe' });
    addRemoteSource(namespace, {
      url: catalog.bareRepo,
      type: 'clone',
      ref: 'main',
      subdir: 'lower',
    });
    assert.ok(buildPluginIndex().get(`lower-plugin@${namespace}`));
    clearPluginIndexCache();
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(catalog.bareRepo)}, type = "clone", ref = "main", subdir = "higher" }\n`
    );

    const rotated = buildPluginIndex();

    assert.ok(rotated.get(`higher-plugin@${namespace}`));
    assert.equal(rotated.get(`lower-plugin@${namespace}`), undefined);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace)), true);
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace);
    assert.equal(states.length, 1);
    assert.ok(states[0].checkout);
    assert.equal(
      states[0].marketplacePath,
      fs.realpathSync.native(path.join(getPluginsDir(), namespace, 'higher'))
    );
  });
});

test('carrier path rotation retains another carrier cache with the same physical key', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'shared-cache-rotation';
    const entry = createBareRemote(path.join(asbHome, 'shared-cache-entry'));
    const catalog = path.join(asbHome, 'catalog-a');
    fs.mkdirSync(path.join(catalog, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(catalog, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: namespace,
        plugins: [{ name: 'remote-plugin', source: { source: 'url', url: entry.bareRepo } }],
      })
    );
    addLocalSource(namespace, catalog);
    let index = buildPluginIndex();
    let plugin = index.get(`remote-plugin@${namespace}`);
    assert.ok(plugin);
    index.expand([plugin.id]);
    const materialized = plugin.meta.sourcePath;
    clearPluginIndexCache();
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = ${JSON.stringify(catalog)}\n`
    );
    index = buildPluginIndex({ profile: 'team' });
    plugin = index.get(`remote-plugin@${namespace}`);
    assert.ok(plugin);
    index.expand([plugin.id]);
    clearPluginIndexCache();
    const replacement = path.join(asbHome, 'catalog-b');
    fs.mkdirSync(path.join(replacement, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(replacement, 'rules', 'local.md'), '# Local\n');
    fs.renameSync(entry.bareRepo, `${entry.bareRepo}.offline`);
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = ${JSON.stringify(replacement)}\n`
    );

    buildPluginIndex({ profile: 'team' });

    assert.equal(fs.existsSync(materialized), true);
    index = buildPluginIndex();
    plugin = index.get(`remote-plugin@${namespace}`);
    assert.ok(plugin);
    assert.doesNotThrow(() => index.expand([plugin.id]));
  });
});

test('removal recovery retains a shared checkout but retires a different subdir cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-subdir-owner-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'layered-subdir-recovery';
    const profile = { profile: 'team' };
    const { checkoutPath, lowerMaterialized, higherMaterialized } =
      createLayeredSubdirMarketplaceSource(asbHome, namespace);

    await stopRemovalAtCrashPoint(asbHome, namespace, 'after-config', profile);
    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), false);

    assert.equal(getSourcesRecord(profile)[namespace], path.join(checkoutPath, 'lower'));
    assert.equal(fs.existsSync(checkoutPath), true);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), false);
    assert.equal(
      fs.readdirSync(getMarketplacePluginCacheDir()).some((name) => name.startsWith('.removing-')),
      false
    );
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      );
    assert.equal(states.length, 1);
    assert.equal(states[0].configPath, fs.realpathSync.native(path.join(asbHome, 'config.toml')));
    assert.equal(states[0].removal, undefined);
  } finally {
    clearPluginIndexCache();
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential-free Git transport keeps HTTP and SCP credentials out of Git and state', (t) => {
  withTempAsbHome((asbHome) => {
    const namespace = 'authenticated-transport';
    const scpNamespace = 'scp-authenticated-transport';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'authenticated-remote'));
    const authenticatedUrl =
      'https://audit-user:audit-password@example.invalid/repo.git?access_token=query-secret#fragment-secret';
    const persistedUrl = 'https://example.invalid/repo.git';
    const scpAuthenticatedUrl = 'oauth2-secret@example.invalid:team/private.git';
    const scpPersistedUrl = 'example.invalid:team/private.git';
    assert.equal(credentialFreeGitUrl(authenticatedUrl), persistedUrl);
    assert.equal(
      credentialFreeGitUrl('file://audit-user:audit-password@localhost/tmp/repo.git'),
      'file://localhost/tmp/repo.git'
    );
    assert.equal(
      credentialFreeGitUrl('git@example.com:team/repo.git?token=secret#fragment'),
      'example.com:team/repo.git'
    );
    assert.equal(credentialFreeGitUrl(scpAuthenticatedUrl), scpPersistedUrl);

    const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    const binDir = path.join(asbHome, 'git-bin');
    const gitLog = path.join(asbHome, 'git-args.jsonl');
    const gitShim = path.join(binDir, 'git');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      gitShim,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const { spawnSync } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "fs.appendFileSync(process.env.ASB_TEST_GIT_LOG, JSON.stringify(args) + '\\n');",
        'const env = { ...process.env };',
        'for (const key of Object.keys(env)) if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete env[key];',
        "if (args[0] === 'clone') {",
        '  const requested = args.at(-2);',
        '  const target = args.at(-1);',
        '  const cloneArgs = [...args];',
        '  cloneArgs[cloneArgs.length - 2] = process.env.ASB_TEST_GIT_REMOTE;',
        '  const cloned = spawnSync(process.env.ASB_TEST_REAL_GIT, cloneArgs, { stdio: "inherit", env });',
        '  if (cloned.status !== 0) process.exit(cloned.status ?? 1);',
        '  const configured = spawnSync(process.env.ASB_TEST_REAL_GIT, ["-C", target, "remote", "set-url", "origin", requested], { stdio: "inherit", env });',
        '  process.exit(configured.status ?? 1);',
        '}',
        'const result = spawnSync(process.env.ASB_TEST_REAL_GIT, args, { stdio: "inherit", env });',
        'process.exit(result.status ?? 1);',
        '',
      ].join('\n'),
      { mode: 0o700 }
    );
    const previousPath = process.env.PATH;
    const previousLog = process.env.ASB_TEST_GIT_LOG;
    const previousRemote = process.env.ASB_TEST_GIT_REMOTE;
    const previousRealGit = process.env.ASB_TEST_REAL_GIT;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
    process.env.ASB_TEST_GIT_LOG = gitLog;
    process.env.ASB_TEST_GIT_REMOTE = bareRepo;
    process.env.ASB_TEST_REAL_GIT = realGit;
    const stateTempModes: number[] = [];
    const originalRename = fs.renameSync.bind(fs);
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (
        path.dirname(String(from)) === getPluginSourceStateDir() &&
        path.basename(String(from)).endsWith('.tmp')
      ) {
        stateTempModes.push(fs.statSync(String(from)).mode & 0o777);
      }
      return originalRename(from, to);
    });
    try {
      addRemoteSource(namespace, {
        url: authenticatedUrl,
        type: 'clone',
        ref: 'main',
      });
      addRemoteSource(scpNamespace, {
        url: scpAuthenticatedUrl,
        type: 'clone',
        ref: 'main',
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.ASB_TEST_GIT_LOG;
      else process.env.ASB_TEST_GIT_LOG = previousLog;
      if (previousRemote === undefined) delete process.env.ASB_TEST_GIT_REMOTE;
      else process.env.ASB_TEST_GIT_REMOTE = previousRemote;
      if (previousRealGit === undefined) delete process.env.ASB_TEST_REAL_GIT;
      else process.env.ASB_TEST_REAL_GIT = previousRealGit;
    }

    const checkouts = [namespace, scpNamespace].map((name) => path.join(getPluginsDir(), name));
    const secretPattern = /audit-user|audit-password|query-secret|fragment-secret|oauth2-secret/;
    const config = fs.readFileSync(path.join(asbHome, 'config.toml'), 'utf-8');
    assert.match(config, /audit-user:audit-password/);
    assert.match(config, /oauth2-secret@example\.invalid/);
    const gitConfig = checkouts
      .map((checkout) => fs.readFileSync(path.join(checkout, '.git', 'config'), 'utf-8'))
      .join('\n');
    assert.match(gitConfig, new RegExp(persistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(gitConfig, new RegExp(scpPersistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(gitConfig, secretPattern);
    const argumentsLog = fs.readFileSync(gitLog, 'utf-8');
    assert.match(argumentsLog, new RegExp(persistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(argumentsLog, new RegExp(scpPersistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(argumentsLog, secretPattern);
    const stateFiles = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(getPluginSourceStateDir(), name));
    assert.ok(stateFiles.length > 0);
    assert.ok(stateTempModes.length > 0);
    assert.deepEqual(new Set(stateTempModes), new Set([0o600]));
    const persistedStates: string[] = [];
    for (const stateFile of stateFiles) {
      assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
      const persisted = fs.readFileSync(stateFile, 'utf-8');
      persistedStates.push(persisted);
      assert.doesNotMatch(persisted, secretPattern);
    }
    assert.match(
      persistedStates.join('\n'),
      new RegExp(persistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    assert.match(
      persistedStates.join('\n'),
      new RegExp(scpPersistedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });
});

test('recorded cache owners fail closed when their configured path disagrees with state', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'recorded-path-drift';
    const { lowerMaterialized, higherMaterialized } = createLayeredSubdirMarketplaceSource(
      asbHome,
      namespace
    );
    const profileStatePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => {
        const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return state.namespace === namespace && state.configPath.endsWith('team.toml');
      });
    assert.ok(profileStatePath);
    const profileState = JSON.parse(fs.readFileSync(profileStatePath, 'utf-8'));
    fs.writeFileSync(
      profileStatePath,
      `${JSON.stringify(
        {
          ...profileState,
          marketplacePath: path.join(getPluginsDir(), namespace, 'lower'),
        },
        null,
        2
      )}\n`
    );

    assert.throws(() => removeSource(namespace), /recorded source path disagrees/i);
    assert.equal(fs.existsSync(lowerMaterialized), true);
    assert.equal(fs.existsSync(higherMaterialized), true);
    assert.match(fs.readFileSync(getProfileConfigPath('team'), 'utf-8'), /subdir = "higher"/);
  });
});

test('managed checkout ownership distinguishes configured SSH principals', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'principal-owner';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'principal-owner-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const userConfig = path.join(asbHome, 'config.toml');
    const aliceUrl = 'ssh://alice:token@example.test/org/repo.git';
    const bobUrl = 'ssh://bob:token@example.test/org/repo.git';
    const alice = { url: aliceUrl, type: 'clone', ref: 'main' };
    fs.writeFileSync(
      userConfig,
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(aliceUrl)}, type = "clone", ref = "main" }\n`
    );
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          descriptor: { ...alice, url: credentialFreeGitUrl(aliceUrl) },
          descriptorKey: sourceDescriptorKeyForTest(alice),
        },
        null,
        2
      )}\n`
    );

    assert.throws(
      () => addRemoteSource(namespace, { url: bobUrl, type: 'clone', ref: 'main' }, profile),
      /owner key|physical owner conflicts/i
    );
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
  });
});

test('legacy checkout adoption compares credential-free transport identities on both sides', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'legacy-principal-origin';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'legacy-principal-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    const configuredUrl = 'ssh://alice:secret@example.test/org/repo.git';
    const descriptor = { url: configuredUrl, type: 'clone', ref: 'main' };
    execFileSync('git', ['remote', 'set-url', 'origin', 'ssh://alice@example.test/org/repo.git'], {
      cwd: checkout,
      stdio: 'pipe',
    });
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(configuredUrl)}, type = "clone", ref = "main" }\n`
    );
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          descriptor: { ...descriptor, url: credentialFreeGitUrl(configuredUrl) },
          descriptorKey: sourceDescriptorKeyForTest(descriptor),
        },
        null,
        2
      )}\n`
    );

    assert.equal(getSourcesRecord()[namespace], checkout);
  });
});

test('shared checkout updates refresh every materialized carrier cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'shared-cache-refresh';
    const { entryWorkDir, lowerMaterialized, higherMaterialized } =
      createLayeredSubdirMarketplaceSource(asbHome, namespace);
    fs.writeFileSync(path.join(entryWorkDir, 'rules', 'v1.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: entryWorkDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: entryWorkDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: entryWorkDir, stdio: 'pipe' });

    const updated = updateRemoteSources(undefined, namespace);

    assert.equal(updated[0]?.status, 'updated', updated[0]?.error);
    assert.equal(fs.readFileSync(path.join(lowerMaterialized, 'rules', 'v1.md'), 'utf-8'), '# V2');
    assert.equal(fs.readFileSync(path.join(higherMaterialized, 'rules', 'v1.md'), 'utf-8'), '# V2');
  });
});

test('managed owner identity canonicalizes short and full branch refs', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'canonical-owner-ref';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'canonical-ref-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(bareRepo)}, type = "clone", ref = "refs/heads/main" }\n`
    );
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);

    removeSource(namespace, profile);

    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
    assert.equal(getSourcesRecord()[namespace], path.join(getPluginsDir(), namespace));
  });
});

test('managed owner identity shares short tag-only and full tag refs', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'canonical-tag-owner';
    const profile = { profile: 'team' };
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'canonical-tag-remote'));
    execFileSync('git', ['tag', 'release-only'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/tags/release-only'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'release-only' });

    addRemoteSource(
      namespace,
      { url: bareRepo, type: 'clone', ref: 'refs/tags/release-only' },
      profile
    );

    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace);
    assert.equal(states.length, 2);
    assert.deepEqual(
      new Set(states.map((state) => state.checkout?.managedRef)),
      new Set(['refs/tags/release-only'])
    );
  });
});

test('short tag provenance conflicts with a later same-named explicit branch', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'tag-branch-collision-owner';
    const profile = { profile: 'team' };
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'tag-branch-collision'));
    execFileSync('git', ['tag', 'collision'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/tags/collision'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    const tagCommit = execFileSync('git', ['rev-parse', 'refs/tags/collision^{commit}'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'collision' });
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['branch', 'collision'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/heads/collision'], {
      cwd: workDir,
      stdio: 'pipe',
    });

    assert.throws(
      () =>
        addRemoteSource(
          namespace,
          { url: bareRepo, type: 'clone', ref: 'refs/heads/collision' },
          profile
        ),
      /physical owner conflicts/i
    );
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(getPluginsDir(), namespace),
        encoding: 'utf-8',
      }).trim(),
      tagCommit
    );
    const state = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .find((candidate) => candidate.namespace === namespace);
    assert.equal(state?.checkout?.managedRef, 'refs/tags/collision');
  });
});

test('managed path locks reject cross-namespace canonical collisions', (t) => {
  withTempAsbHome((asbHome) => {
    const upper = 'CaseOwner';
    const lower = 'caseowner';
    const first = createBareRemote(path.join(asbHome, 'case-owner-first'));
    const second = createBareRemote(path.join(asbHome, 'case-owner-second'));
    addRemoteSource(upper, { url: first.bareRepo, type: 'clone', ref: 'main' });
    const upperPath = path.join(getPluginsDir(), upper);
    const lowerPath = path.join(getPluginsDir(), lower);
    fs.mkdirSync(lowerPath, { recursive: true });
    const originalNative = fs.realpathSync.native.bind(fs.realpathSync);
    Object.defineProperty(fs.realpathSync, 'native', {
      configurable: true,
      value: (candidate: fs.PathLike) =>
        path.resolve(String(candidate)) === path.resolve(lowerPath)
          ? originalNative(upperPath)
          : originalNative(candidate),
    });
    t.after(() => {
      Object.defineProperty(fs.realpathSync, 'native', {
        configurable: true,
        value: originalNative,
      });
    });

    assert.throws(
      () => addRemoteSource(lower, { url: second.bareRepo, type: 'clone', ref: 'main' }),
      /cross-namespace physical collision/i
    );
    assert.equal(fs.readFileSync(path.join(upperPath, 'rules', 'v1.md'), 'utf-8'), '# V1');
  });
});

test('addRemoteSource adopts a compatible recorded managed checkout', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'public-shared-add';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'public-shared-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });

    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'refs/heads/main' }, profile);

    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
    assert.equal(
      fs
        .readdirSync(getPluginSourceStateDir())
        .filter((name) => name.endsWith('.json'))
        .map((name) =>
          JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
        )
        .filter((state) => state.namespace === namespace).length,
      2
    );
  });
});

test('validated clone recovery rechecks incompatible physical owners before publication', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-clone-owner-recovery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'recovery-owner-snapshot';
    const first = createBareRemote(path.join(root, 'first'));
    const second = createBareRemote(path.join(root, 'second'));
    addRemoteSource(namespace, { url: first.bareRepo, type: 'clone', ref: 'main' });
    fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });
    await stopCloneUpdateAfterValidation(asbHome, namespace);
    const profileConfig = getProfileConfigPath('team');
    fs.writeFileSync(
      profileConfig,
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(second.bareRepo)}, type = "clone", ref = "main" }\n`
    );
    writeSourceStateForTest(
      namespace,
      profileConfig,
      { url: second.bareRepo, type: 'clone', ref: 'main' },
      path.join(getPluginsDir(), namespace)
    );

    assert.throws(() => getSourcesRecord(), /physical owner conflicts/i);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace)), false);
    assert.equal(
      fs
        .readdirSync(getPluginSourceStateDir())
        .filter((name) => name.endsWith('.json'))
        .map((name) =>
          JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
        )
        .some((state) => state.addition?.phase === 'validated'),
      true
    );
  } finally {
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every identifiable malformed state namespace stays out of direct discovery', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'malformed-namespace-only';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'malformed-namespace-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, profile);
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    fs.writeFileSync(statePath, `${JSON.stringify({ version: 999, namespace }, null, 2)}\n`);

    assert.equal(getSourcesRecord()[namespace], undefined);
    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
  });
});

test('state enumeration rejects symlinked JSON carriers before discovery', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'symlinked-state-carrier';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'symlinked-state-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, profile);
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const outside = path.join(asbHome, 'outside-state.json');
    fs.renameSync(statePath, outside);
    fs.symlinkSync(outside, statePath);

    assert.throws(() => getSourcesRecord(), /state.*symbolic link/i);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
  });
});

test('recreated clone provenance propagates to every compatible carrier', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'shared-clone-recreation';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'shared-clone-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(bareRepo)}, type = "clone", ref = "refs/heads/main" }\n`
    );
    const adopted = updateRemoteSources(profile, namespace);
    assert.equal(adopted[0]?.status, 'updated', adopted[0]?.error);
    fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });

    const recreated = updateRemoteSources(undefined, namespace);
    const sibling = updateRemoteSources(profile, namespace);

    assert.equal(recreated[0]?.status, 'updated', recreated[0]?.error);
    assert.equal(sibling[0]?.status, 'updated', sibling[0]?.error);
    const checkoutOwners = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace)
      .map((state) => state.checkout);
    assert.equal(checkoutOwners.length, 2);
    assert.deepEqual(
      new Set(checkoutOwners.map((owner) => JSON.stringify(owner))),
      new Set([JSON.stringify(checkoutOwners[0])])
    );
  });
});

test('updates derive one locked snapshot across every current carrier', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'carrier-snapshot-drift';
    const { catalogUrl } = createLayeredSubdirMarketplaceSource(asbHome, namespace);
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(catalogUrl)}, type = "clone", ref = "main", subdir = "retargeted" }\n`
    );

    const updated = updateRemoteSources(undefined, namespace);

    assert.equal(updated[0]?.status, 'error');
    assert.match(updated[0]?.error ?? '', /recorded source.*disagrees/i);
    assert.match(fs.readFileSync(getProfileConfigPath('team'), 'utf-8'), /subdir = "retargeted"/);
  });
});

test('managed non-dot checkout directories remain directly discoverable', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'managed-direct-discovery';
    const { bareRepo } = createBareRemote(path.join(asbHome, 'managed-direct-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    fs.writeFileSync(path.join(asbHome, 'config.toml'), '[plugins]\nenabled = []\n');

    assert.equal(getSourcesRecord()[namespace], path.join(getPluginsDir(), namespace));
  });
});

test('managed clone creation accepts exact full refs', () => {
  for (const kind of ['branch', 'tag', 'other'] as const) {
    withTempAsbHome((asbHome) => {
      const namespace = `full-${kind}-clone`;
      const { bareRepo, workDir } = createBareRemote(path.join(asbHome, `${kind}-remote`));
      if (kind === 'tag') {
        execFileSync('git', ['tag', 'release'], { cwd: workDir, stdio: 'pipe' });
        execFileSync('git', ['push', 'origin', 'refs/tags/release'], {
          cwd: workDir,
          stdio: 'pipe',
        });
      } else if (kind === 'other') {
        execFileSync('git', ['push', 'origin', 'HEAD:refs/pull/1/head'], {
          cwd: workDir,
          stdio: 'pipe',
        });
      }
      const ref =
        kind === 'branch'
          ? 'refs/heads/main'
          : kind === 'tag'
            ? 'refs/tags/release'
            : 'refs/pull/1/head';

      addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref });

      const checkout = path.join(getPluginsDir(), namespace);
      assert.equal(fs.existsSync(path.join(checkout, 'rules', 'v1.md')), true);
      assert.equal(
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: checkout,
          encoding: 'utf-8',
        }).trim(),
        kind === 'branch' ? 'main' : 'HEAD'
      );
    });
  }
});

test('compatible scoped add adopts a valid state-less checkout carrier', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'stateless-compatible-add';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'stateless-add-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    for (const name of fs.readdirSync(getPluginSourceStateDir())) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(getPluginSourceStateDir(), name);
      if (JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace) {
        fs.rmSync(filePath);
      }
    }

    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'refs/heads/main' }, profile);

    assert.equal(getSourcesRecord(profile)[namespace], path.join(getPluginsDir(), namespace));
    assert.equal(
      fs
        .readdirSync(getPluginSourceStateDir())
        .filter((name) => name.endsWith('.json'))
        .map((name) =>
          JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
        )
        .filter((state) => state.namespace === namespace).length,
      2
    );
  });
});

test('legacy adoption rejects a checkout persisted under a different principal', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'legacy-principal-mismatch';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'legacy-principal-mismatch-remote'));
    const bobUrl = `file://bob@localhost${bareRepo}`;
    const aliceUrl = `file://alice@localhost${bareRepo}`;
    addRemoteSource(namespace, { url: bobUrl, type: 'clone', ref: 'main' });
    const checkout = path.join(getPluginsDir(), namespace);
    execFileSync('git', ['remote', 'set-url', 'origin', aliceUrl], {
      cwd: checkout,
      stdio: 'pipe',
    });
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    delete state.checkout;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    assert.throws(
      () => addRemoteSource(namespace, { url: bobUrl, type: 'clone', ref: 'main' }, profile),
      /principal|origin|provenance/i
    );
    assert.equal(fs.existsSync(path.join(checkout, 'rules', 'v1.md')), true);
  });
});

test('locked live config rejects a forged persisted Git owner key', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'forged-owner-key';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'forged-owner-key-remote'));
    const aliceUrl = `file://alice@localhost${bareRepo}`;
    const bobUrl = `file://bob@localhost${bareRepo}`;
    addRemoteSource(namespace, { url: aliceUrl, type: 'clone', ref: 'main' });
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.gitOwnerKey = createHash('sha256')
      .update(normalizeGitIdentity(bobUrl, process.cwd()))
      .digest('hex');
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    assert.throws(
      () => addRemoteSource(namespace, { url: bobUrl, type: 'clone', ref: 'main' }, profile),
      /owner key|physical owner conflicts|provenance/i
    );
  });
});

test('compatible checkout adoption revalidates live Git provenance', () => {
  for (const variant of ['dirty', 'origin', 'managed-ref'] as const) {
    withTempAsbHome((asbHome) => {
      const namespace = `strict-adoption-${variant}`;
      const profile = { profile: 'team' };
      const primary = createBareRemote(path.join(asbHome, `${variant}-primary`));
      addRemoteSource(namespace, { url: primary.bareRepo, type: 'clone', ref: 'main' });
      const checkout = path.join(getPluginsDir(), namespace);
      let requestedRef = 'main';
      if (variant === 'dirty') {
        fs.writeFileSync(path.join(checkout, 'rules', 'v1.md'), '# Dirty');
      } else if (variant === 'origin') {
        const other = createBareRemote(path.join(asbHome, 'other-origin'));
        execFileSync('git', ['remote', 'set-url', 'origin', other.bareRepo], {
          cwd: checkout,
          stdio: 'pipe',
        });
      } else {
        requestedRef = 'refs/tags/main';
        const statePath = fs
          .readdirSync(getPluginSourceStateDir())
          .map((name) => path.join(getPluginSourceStateDir(), name))
          .find(
            (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace
          );
        assert.ok(statePath);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.checkout.managedRef = requestedRef;
        fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      }

      assert.throws(
        () =>
          addRemoteSource(
            namespace,
            { url: primary.bareRepo, type: 'clone', ref: requestedRef },
            profile
          ),
        /local changes|origin|configured ref|resolved ref|provenance/i,
        variant
      );
      assert.equal(fs.existsSync(getProfileConfigPath('team')), false, variant);
    });
  }
});

test('missing checkout recreation keeps its persisted short-tag identity', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'recreate-short-tag';
    const { bareRepo, workDir } = createBareRemote(path.join(asbHome, 'recreate-tag-remote'));
    execFileSync('git', ['tag', 'release'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/tags/release'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    const tagCommit = execFileSync('git', ['rev-parse', 'refs/tags/release^{commit}'], {
      cwd: workDir,
      encoding: 'utf-8',
    }).trim();
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'release' });
    fs.writeFileSync(path.join(workDir, 'rules', 'v2.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: workDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: workDir, stdio: 'pipe' }
    );
    execFileSync('git', ['branch', 'release'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/heads/release'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });

    const result = updateRemoteSources(undefined, namespace);

    assert.equal(result[0]?.status, 'updated', result[0]?.error);
    assert.equal(
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.join(getPluginsDir(), namespace),
        encoding: 'utf-8',
      }).trim(),
      tagCommit
    );
    const states = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .filter((state) => state.namespace === namespace);
    assert.deepEqual(
      new Set(states.map((state) => state.checkout?.managedRef)),
      new Set(['refs/tags/release'])
    );
  });
});

test('subtree provenance persists the resolved ref and separates later branch aliases', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'resolved-subtree-ref';
    const profile = { profile: 'team' };
    const { bareRepo, workDir } = createBareRemote(
      path.join(path.dirname(asbHome), 'subtree-ref-remote')
    );
    execFileSync('git', ['tag', 'release'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/tags/release'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    initAsbAsGitRepo(asbHome);
    addRemoteSource(namespace, { url: bareRepo, type: 'subtree', ref: 'release' });
    execFileSync('git', ['add', '.'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'record subtree'], { cwd: asbHome, stdio: 'pipe' });
    execFileSync('git', ['branch', 'release'], { cwd: workDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'refs/heads/release'], {
      cwd: workDir,
      stdio: 'pipe',
    });
    const state = fs
      .readdirSync(getPluginSourceStateDir())
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(getPluginSourceStateDir(), name), 'utf-8'))
      )
      .find((candidate) => candidate.namespace === namespace);
    assert.equal(state?.subtree?.managedRef, 'refs/tags/release');

    assert.throws(
      () =>
        addRemoteSource(
          namespace,
          { url: bareRepo, type: 'subtree', ref: 'refs/heads/release' },
          profile
        ),
      /physical owner conflicts|owner conflicts/i
    );
  });
});

test('shared checkout refresh updates a materialized state-less carrier cache', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'stateless-cache-refresh';
    const profile = { profile: 'team' };
    const { entryWorkDir, lowerMaterialized } = createLayeredSubdirMarketplaceSource(
      asbHome,
      namespace
    );
    for (const name of fs.readdirSync(getPluginSourceStateDir())) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(getPluginSourceStateDir(), name);
      const state = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (state.namespace === namespace && state.configPath.endsWith('config.toml')) {
        fs.rmSync(filePath);
      }
    }
    fs.writeFileSync(path.join(entryWorkDir, 'rules', 'v1.md'), '# V2');
    execFileSync('git', ['add', '.'], { cwd: entryWorkDir, stdio: 'pipe' });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test.com', 'commit', '-m', 'v2'],
      { cwd: entryWorkDir, stdio: 'pipe' }
    );
    execFileSync('git', ['push', 'origin', 'main'], { cwd: entryWorkDir, stdio: 'pipe' });

    const updated = updateRemoteSources(profile, namespace);

    assert.equal(updated[0]?.status, 'updated', updated[0]?.error);
    assert.equal(fs.readFileSync(path.join(lowerMaterialized, 'rules', 'v1.md'), 'utf-8'), '# V2');
  });
});

test('recovery rejects forged config paths without cleaning their temp files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-recovery-config-forgery-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'forged-recovery-carrier';
    const { bareRepo } = createBareRemote(path.join(root, 'remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
    fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });
    await stopCloneUpdateAfterValidation(asbHome, namespace);
    const statePath = fs
      .readdirSync(getPluginSourceStateDir())
      .map((name) => path.join(getPluginSourceStateDir(), name))
      .find((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8')).namespace === namespace);
    assert.ok(statePath);
    const forgedConfig = path.join(root, 'foreign.txt');
    const forgedTemp = path.join(root, '.foreign.txt.asb-write.tmp');
    fs.writeFileSync(forgedConfig, '[plugins]\nenabled = []\n');
    fs.writeFileSync(forgedTemp, 'preserve');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.addition.configPaths.push(forgedConfig);
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    assert.throws(() => getSourcesRecord(), /invalid.*config|config.*carrier|recovery.*path/i);
    assert.equal(fs.readFileSync(forgedTemp, 'utf-8'), 'preserve');
  } finally {
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery includes a new state-less profile carrier in physical owner checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-recovery-new-carrier-'));
  const asbHome = path.join(root, 'asb-home');
  fs.mkdirSync(asbHome, { recursive: true });
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  process.env.ASB_HOME = asbHome;
  process.env.ASB_AGENTS_HOME = asbHome;
  try {
    const namespace = 'recovery-new-carrier';
    const first = createBareRemote(path.join(root, 'first'));
    const second = createBareRemote(path.join(root, 'second'));
    addRemoteSource(namespace, { url: first.bareRepo, type: 'clone', ref: 'main' });
    fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });
    await stopCloneUpdateAfterValidation(asbHome, namespace);
    fs.writeFileSync(
      getProfileConfigPath('team'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(second.bareRepo)}, type = "clone", ref = "main" }\n`
    );

    assert.throws(() => getSourcesRecord(), /physical owner conflicts/i);
    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace)), false);
  } finally {
    if (previousAsbHome === undefined) delete process.env.ASB_HOME;
    else process.env.ASB_HOME = previousAsbHome;
    if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
    else process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery derives empty profile and project carriers from the invoking scope', async () => {
  for (const kind of ['profile', 'project'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `asb-recovery-${kind}-scope-`));
    const asbHome = path.join(root, 'asb-home');
    fs.mkdirSync(asbHome, { recursive: true });
    const previousAsbHome = process.env.ASB_HOME;
    const previousAgentsHome = process.env.ASB_AGENTS_HOME;
    process.env.ASB_HOME = asbHome;
    process.env.ASB_AGENTS_HOME = asbHome;
    try {
      const namespace = `${kind}-scope-recovery`;
      const { bareRepo } = createBareRemote(path.join(root, 'remote'));
      addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' });
      const projectRoot = path.join(root, 'project');
      const scope = kind === 'profile' ? { profile: 'team' } : { project: projectRoot };
      if (kind === 'profile') {
        fs.writeFileSync(getProfileConfigPath('team'), '[plugins]\nenabled = []\n');
      } else {
        fs.mkdirSync(projectRoot, { recursive: true });
        fs.writeFileSync(getProjectConfigPath(projectRoot), '[plugins]\nenabled = []\n');
      }
      fs.rmSync(path.join(getPluginsDir(), namespace), { recursive: true, force: true });
      await stopCloneUpdateAfterValidation(asbHome, namespace, scope);

      assert.throws(() => getSourcesRecord(), /invalid source recovery config carrier/i);
      assert.equal(getSourcesRecord(scope)[namespace], path.join(getPluginsDir(), namespace), kind);
    } finally {
      if (previousAsbHome === undefined) delete process.env.ASB_HOME;
      else process.env.ASB_HOME = previousAsbHome;
      if (previousAgentsHome === undefined) delete process.env.ASB_AGENTS_HOME;
      else process.env.ASB_AGENTS_HOME = previousAgentsHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('removal retains a compatible state-less lower carrier checkout', () => {
  withTempAsbHome((asbHome) => {
    const namespace = 'stateless-removal-owner';
    const profile = { profile: 'team' };
    const { bareRepo } = createBareRemote(path.join(asbHome, 'stateless-removal-remote'));
    addRemoteSource(namespace, { url: bareRepo, type: 'clone', ref: 'main' }, profile);
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\n${namespace} = { url = ${JSON.stringify(bareRepo)}, type = "clone", ref = "refs/heads/main" }\n`
    );

    removeSource(namespace, profile);

    assert.equal(fs.existsSync(path.join(getPluginsDir(), namespace, 'rules', 'v1.md')), true);
    assert.equal(getSourcesRecord()[namespace], path.join(getPluginsDir(), namespace));
  });
});

test('cross-namespace collision checks include state-less config carriers', (t) => {
  withTempAsbHome((asbHome) => {
    const upper = 'StateLessCase';
    const lower = 'statelesscase';
    const first = createBareRemote(path.join(asbHome, 'stateless-case-first'));
    const second = createBareRemote(path.join(asbHome, 'stateless-case-second'));
    addRemoteSource(upper, { url: first.bareRepo, type: 'clone', ref: 'main' });
    for (const name of fs.readdirSync(getPluginSourceStateDir())) {
      if (name.endsWith('.json')) fs.rmSync(path.join(getPluginSourceStateDir(), name));
    }
    const upperPath = path.join(getPluginsDir(), upper);
    const lowerPath = path.join(getPluginsDir(), lower);
    fs.mkdirSync(lowerPath, { recursive: true });
    const originalNative = fs.realpathSync.native.bind(fs.realpathSync);
    Object.defineProperty(fs.realpathSync, 'native', {
      configurable: true,
      value: (candidate: fs.PathLike) =>
        path.resolve(String(candidate)) === path.resolve(lowerPath)
          ? originalNative(upperPath)
          : originalNative(candidate),
    });
    t.after(() => {
      Object.defineProperty(fs.realpathSync, 'native', {
        configurable: true,
        value: originalNative,
      });
    });

    assert.throws(
      () =>
        addRemoteSource(
          lower,
          { url: second.bareRepo, type: 'clone', ref: 'main' },
          { profile: 'team' }
        ),
      /cross-namespace physical collision/i
    );
  });
});

test('lifecycle releases retained source readers before physical locks', (t) => {
  withTempAsbHome((asbHome) => {
    clearPluginIndexCache();
    const namespace = 'lease-ordering';
    const sourceDir = path.join(asbHome, 'external', namespace);
    fs.mkdirSync(path.join(sourceDir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'rules', 'rule.md'), '# Rule');
    addLocalSource(namespace, sourceDir);
    assert.ok(buildPluginIndex().get(namespace));
    assert.ok(fs.readdirSync(getPluginSourceLocksDir()).some((name) => name.endsWith('.lock')));
    const originalLink = fs.linkSync.bind(fs);
    let checked = false;
    t.mock.method(fs, 'linkSync', (from, to) => {
      if (
        !checked &&
        path.dirname(String(to)) === getPluginSourceLocksDir() &&
        path.basename(String(to)).endsWith('.lock')
      ) {
        checked = true;
        assert.deepEqual(
          fs.readdirSync(getPluginSourceLocksDir()).filter((name) => name.endsWith('.lock')),
          []
        );
      }
      return originalLink(from, to);
    });

    removeSource(namespace);

    assert.equal(hasSource(namespace), false);
    assert.equal(checked, true);
    clearPluginIndexCache();
  });
});
