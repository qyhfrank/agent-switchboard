import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  getPluginSourceLocksDir,
  getPluginSourceStateDir,
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
import { withTemporaryMarketplaceEntryCache } from '../src/marketplace/cache.js';
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
        assert.match(path.basename(String(from)), /^\.updating-reclone-test-/);
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
    assert.equal(results[0].status, 'updated');
    assert.equal(publishedFromHiddenStage, true);
    assert.ok(fs.existsSync(path.join(cacheDir, 'rules', 'test.md')));
  });
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

async function stopRemovalAtCrashPoint(
  asbHome: string,
  namespace: string,
  crashPoint: 'before-config' | 'after-config'
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
    'return originalRename(from, to);' +
    '};' +
    'fs.rmSync = (target, options) => {' +
    'if (crashPoint === "after-config" && String(target).includes(".removing-")) wait();' +
    'return originalRemove(target, options);' +
    '};' +
    `removeSource(${JSON.stringify(namespace)});`;
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

async function startRemoteAddAtPublication(
  asbHome: string,
  namespace: string,
  bareRepo: string
): Promise<{ child: ReturnType<typeof spawn>; stderr: () => string }> {
  const sourcesModule = pathToFileURL(path.resolve('src/library/sources.ts')).href;
  const configuredPath = process.env.ASB_CONFIG?.trim() || path.join(asbHome, 'config.toml');
  const configPath = fs.existsSync(configuredPath)
    ? fs.realpathSync.native(configuredPath)
    : path.join(
        fs.realpathSync.native(path.dirname(configuredPath)),
        path.basename(configuredPath)
      );
  const checkoutPath = path.join(asbHome, 'plugins', namespace);
  const childSource =
    'import fs from "node:fs";' +
    `import { addRemoteSource } from ${JSON.stringify(sourcesModule)};` +
    'const originalRename = fs.renameSync.bind(fs);' +
    `const configPath = ${JSON.stringify(configPath)};` +
    `const checkoutPath = ${JSON.stringify(checkoutPath)};` +
    `const namespace = ${JSON.stringify(namespace)};` +
    'let stopped = false;' +
    'const wait = () => {' +
    'if (stopped) return;' +
    'stopped = true;' +
    'process.stdout.write("CHECKPOINT\\n");' +
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);' +
    '};' +
    'fs.renameSync = (from, to) => {' +
    'const fromName = String(from).split(/[\\\\/]/).pop();' +
    'if ((fromName?.startsWith(".adding-" + namespace + "-") && String(to) === checkoutPath) || String(to) === configPath) wait();' +
    'return originalRename(from, to);' +
    '};' +
    `addRemoteSource(namespace, { url: ${JSON.stringify(bareRepo)}, type: "clone" });`;
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
    const started = await startRemoteAddAtPublication(asbHome, namespace, bareRepo);
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
    const started = await startRemoteAddAtPublication(asbHome, namespace, bareRepo);
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

    assert.throws(() => getSourcesRecord(), /addition ownership/i);
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

test('addRemoteSource rejects a checkout subdirectory symlink that escapes its source', () => {
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
          subdir: 'escape',
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
      fs.readdirSync(getPluginsDir()).filter((name) => name.startsWith('.adding-')),
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
