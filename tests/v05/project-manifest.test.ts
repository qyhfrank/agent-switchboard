import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  emptyProjectManifest,
  loadProjectManifest,
  managedMcpCleanupKeys,
  manifestBundleKey,
  manifestDeviceId,
  manifestFileKey,
  manifestMcpKey,
  ownedManagedMcpServers,
  projectManifestPath,
  projectManifestSlug,
  recordManagedMcpEntry,
  removeManagedMcpEntry,
  saveProjectManifest,
  uniqueProjectManifestPaths,
} from '../../src/engine/peer.js';
import { withScratchHomes } from './helpers/scratch.js';

test('project manifest identity and opaque keys use the frozen bytes', async () => {
  await withScratchHomes(async (homes) => {
    const expected = createHash('sha256').update('hostlinuxarm64').digest('hex').slice(0, 12);
    assert.equal(manifestDeviceId('host', 'linux', 'arm64'), expected);
    assert.equal(projectManifestSlug('/work\\repo'), '--work--repo');
    assert.equal(
      projectManifestPath(homes.asbHome, '/work\\repo'),
      path.join(homes.asbHome, 'manifests', '--work--repo.json')
    );
    assert.equal(manifestFileKey('codex', 'rules::root'), 'codex::rules::root');
    assert.equal(manifestBundleKey('codex', 'skills', 'pack::lint'), 'codex::skills::pack::lint');
    assert.equal(manifestMcpKey('claude-code', 'server::one'), 'claude-code::server::one');

    const nested = path.join(homes.root, 'a', 'b');
    const dashed = path.join(homes.root, 'a--b');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(dashed, { recursive: true });
    assert.throws(
      () => uniqueProjectManifestPaths(homes.asbHome, [nested, dashed]),
      /manifest path alias.*a[/\\]b.*a--b/i
    );
  });
});

test('project manifest load refuses corrupt state and missing state starts empty', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.join(homes.root, 'project');
    const missing = loadProjectManifest(homes.asbHome, root);
    assert.equal(missing.existed, false);
    assert.equal(missing.corrupt, false);
    assert.deepEqual(missing.manifest, emptyProjectManifest(path.resolve(root)));

    fs.mkdirSync(path.dirname(missing.path), { recursive: true });
    fs.writeFileSync(
      missing.path,
      '{"version":1,"projectRoot":5,"files":{},"bundles":{},"mcp":{}}\n'
    );
    const corrupt = loadProjectManifest(homes.asbHome, root);
    assert.equal(corrupt.existed, true);
    assert.equal(corrupt.corrupt, true);
    assert.equal(corrupt.manifest, null);
    assert.match(corrupt.error ?? '', /projectRoot/);
  });
});

test('project manifest save preserves unknown fields and untouched section order byte-for-byte', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.resolve(homes.root, 'project');
    const filePath = projectManifestPath(homes.asbHome, root);
    const original = `${JSON.stringify(
      {
        version: 1,
        projectRoot: root,
        futureTop: { keep: true },
        files: {
          'codex::rules': {
            appId: 'codex',
            targetId: 'rules',
            type: 'rules',
            id: null,
            relativePath: 'AGENTS.md',
            hash: 'a',
          },
        },
        bundles: {
          'codex::skills::lint': {
            appId: 'codex',
            type: 'skills',
            name: 'lint',
            relativePath: '.agents/skills/lint',
            hash: 'tree:a',
            futureEntry: 9,
          },
        },
        mcp: {
          'claude-code::server::one': {
            appId: 'claude-code',
            relativePath: '.mcp.json',
            targetId: 'claude-code',
            serverKey: 'server::one',
            futureMcp: 'keep',
          },
        },
      },
      null,
      2
    )}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, original);

    const loaded = loadProjectManifest(homes.asbHome, root);
    assert.equal(loaded.corrupt, false, loaded.error);
    assert.ok(loaded.manifest);
    loaded.manifest.files['codex::rules'].hash = 'b';
    saveProjectManifest(filePath, loaded.manifest);

    const saved = fs.readFileSync(filePath, 'utf-8');
    assert.equal(saved, original.replace('"hash": "a"', '"hash": "b"'));
    assert.equal(saved.endsWith('\n'), true);
    assert.equal(saved.endsWith('\n\n'), false);
  });
});

test('managed MCP manifest entries record and remove by opaque composite key', () => {
  const manifest = emptyProjectManifest('/project');
  recordManagedMcpEntry(manifest, {
    appId: 'claude-code',
    relativePath: '.mcp.json',
    targetId: 'claude-code',
    serverKey: 'server::one',
  });
  assert.equal(manifest.mcp['claude-code::server::one']?.serverKey, 'server::one');
  removeManagedMcpEntry(manifest, 'claude-code::server::one');
  assert.equal(manifest.mcp['claude-code::server::one'], undefined);
});

test('managed MCP cleanup returns opaque keys for stale entries', () => {
  const manifest = emptyProjectManifest('/project');
  for (const serverKey of ['keep', 'drop::one']) {
    recordManagedMcpEntry(manifest, {
      appId: 'codex',
      relativePath: '.codex/config.toml',
      targetId: 'codex',
      serverKey,
    });
  }
  assert.deepEqual(managedMcpCleanupKeys(manifest, 'codex', new Set(['keep'])), [
    'codex::drop::one',
  ]);
});

test('managed MCP ownership returns server fields rather than parsing keys', () => {
  const manifest = emptyProjectManifest('/project');
  recordManagedMcpEntry(manifest, {
    appId: 'claude-code',
    relativePath: '.mcp.json',
    targetId: 'claude-code',
    serverKey: 'server::one',
  });
  recordManagedMcpEntry(manifest, {
    appId: 'cursor',
    relativePath: '.cursor/mcp.json',
    targetId: 'cursor',
    serverKey: 'server::one',
  });
  assert.deepEqual([...ownedManagedMcpServers(manifest, 'claude-code')], ['server::one']);
});

test('same managed MCP server for two apps does not collide', () => {
  const manifest = emptyProjectManifest('/project');
  for (const appId of ['claude-code', 'cursor']) {
    recordManagedMcpEntry(manifest, {
      appId,
      relativePath: appId === 'cursor' ? '.cursor/mcp.json' : '.mcp.json',
      targetId: appId,
      serverKey: 'same',
    });
  }
  assert.deepEqual(Object.keys(manifest.mcp), ['claude-code::same', 'cursor::same']);
  removeManagedMcpEntry(manifest, 'cursor::same');
  assert.ok(manifest.mcp['claude-code::same']);
});
