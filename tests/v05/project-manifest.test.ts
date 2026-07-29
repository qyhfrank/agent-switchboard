import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeProjectLibraryCleanupSet,
  computeProjectMcpCleanupSet,
  emptyProjectManifest,
  getProjectLibraryEntry,
  loadPeerState,
  loadProjectManifest,
  manifestDeviceId,
  ownedManagedMcpServers,
  type ProjectManifest,
  peerStatePath,
  projectManifestPath,
  projectManifestSlug,
  recordManagedMcpEntry,
  recordProjectLibraryEntry,
  removeManagedMcpEntry,
  removeProjectLibraryEntry,
  savePeerState,
  saveProjectManifest,
  uniqueProjectManifestPaths,
} from '../../src/engine/peer.js';
import { withScratchHomes } from './helpers/scratch.js';

test('hook ownership is shared while manifests remain device-scoped', async () => {
  await withScratchHomes(async (homes) => {
    const previous = process.env.ASB_DEVICE_ID;
    try {
      process.env.ASB_DEVICE_ID = 'server-a';
      const hookPathA = peerStatePath(homes.asbHome, 'claude-code');
      const projectRoot = '/shared/project';
      const projectHash = createHash('sha256')
        .update(path.relative(os.homedir(), path.resolve(projectRoot)).split(path.sep).join('/'))
        .digest('hex')
        .slice(0, 10);
      assert.equal(
        peerStatePath(homes.asbHome, 'claude-code', projectRoot),
        path.join(
          homes.asbHome,
          'state',
          'hooks',
          `claude-code--${projectManifestSlug(projectRoot)}-${projectHash}.json`
        )
      );
      const manifestPathA = projectManifestPath(homes.asbHome, projectRoot);
      savePeerState(homes.asbHome, 'claude-code', {
        version: 1,
        events: { PreToolUse: [{ matcher: 'from-a', hooks: [] }] },
        bundles: [],
        legacyBundles: [],
      });
      saveProjectManifest(manifestPathA, emptyProjectManifest(projectRoot));

      process.env.ASB_DEVICE_ID = 'server-b';
      assert.equal(peerStatePath(homes.asbHome, 'claude-code'), hookPathA);
      assert.notEqual(projectManifestPath(homes.asbHome, projectRoot), manifestPathA);
      assert.equal(loadPeerState(homes.asbHome, 'claude-code').events.PreToolUse?.length, 1);
      assert.equal(loadProjectManifest(homes.asbHome, projectRoot).existed, false);

      process.env.ASB_DEVICE_ID = 'server-a';
      assert.equal(loadPeerState(homes.asbHome, 'claude-code').events.PreToolUse?.length, 1);
      assert.equal(loadProjectManifest(homes.asbHome, projectRoot).existed, true);
    } finally {
      if (previous === undefined) delete process.env.ASB_DEVICE_ID;
      else process.env.ASB_DEVICE_ID = previous;
    }
  });
});

test('project manifest path uses the 0.4 device id and state/manifests directory', async () => {
  await withScratchHomes(async (homes) => {
    const previous = process.env.ASB_DEVICE_ID;
    try {
      process.env.ASB_DEVICE_ID = 'host';
      const expected = createHash('sha256')
        .update(`host\0${path.resolve(homes.agentsHome)}`)
        .digest('hex')
        .slice(0, 16);
      assert.equal(manifestDeviceId(), expected);
      assert.equal(
        projectManifestPath(homes.asbHome, '/opt/project'),
        path.join(homes.asbHome, 'state', 'manifests', expected, '_abs--opt--project.json')
      );
    } finally {
      if (previous === undefined) delete process.env.ASB_DEVICE_ID;
      else process.env.ASB_DEVICE_ID = previous;
    }
  });
});

test('project manifest slug matches the 0.4 home-relative and absolute grammar', () => {
  const home = os.homedir();
  assert.equal(
    projectManifestSlug(path.join(home, 'Documents', 'Projects', 'foo')),
    'Documents--Projects--foo'
  );
  assert.equal(projectManifestSlug('/opt/project'), '_abs--opt--project');
  assert.equal(projectManifestSlug(home), '');
});

test('project manifest load refuses corrupt state and missing state starts empty', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.join(homes.root, 'project');
    const missing = loadProjectManifest(homes.asbHome, root);
    assert.equal(missing.existed, false);
    assert.equal(missing.corrupt, false);
    assert.equal(missing.collision, false);
    assert.equal(missing.manifest?.version, 1);
    assert.deepEqual(missing.manifest?.sections, {});

    fs.mkdirSync(path.dirname(missing.path), { recursive: true });
    fs.writeFileSync(missing.path, '{"version":99,"sections":{}}\n');
    const corrupt = loadProjectManifest(homes.asbHome, root);
    assert.equal(corrupt.existed, true);
    assert.equal(corrupt.corrupt, true);
    assert.equal(corrupt.collision, false);
    assert.equal(corrupt.manifest, null);
    assert.match(corrupt.error ?? '', /version/i);

    fs.writeFileSync(missing.path, 'not valid json');
    const unparseable = loadProjectManifest(homes.asbHome, root);
    assert.equal(unparseable.existed, true);
    assert.equal(unparseable.corrupt, true);
    assert.equal(unparseable.collision, false);
    assert.equal(unparseable.manifest, null);
  });
});

test('0.4 manifest fixture preserves unknown fields and untouched sections on 0.5 save', async () => {
  await withScratchHomes(async (homes) => {
    const root = path.resolve(homes.root, 'project');
    const filePath = projectManifestPath(homes.asbHome, root);
    const original = `{
  "version": 1,
  "updatedAt": "2000-01-01T00:00:00.000Z",
  "sections": {
    "commands": {
      "build::cursor": {
        "relativePath": ".cursor/commands/build.md",
        "targetId": "cursor",
        "hash": "old",
        "updatedAt": "2000-01-01T00:00:00.000Z",
        "futureEntry": 9
      }
    },
    "skills": {
      "lint::codex": {
        "relativePath": ".agents/skills/lint",
        "targetId": "codex",
        "hash": "tree:keep",
        "updatedAt": "2000-01-01T00:00:00.000Z"
      }
    }
  },
  "futureTop": {
    "keep": true
  }
}
`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, original);

    const loaded = loadProjectManifest(homes.asbHome, root);
    assert.equal(loaded.corrupt, false, loaded.error);
    assert.ok(loaded.manifest);
    const untouchedBefore = JSON.stringify(loaded.manifest.sections.skills);
    recordProjectLibraryEntry(loaded.manifest, 'commands', 'build', {
      relativePath: '.cursor/commands/build.md',
      targetId: 'cursor',
      hash: 'new',
      updatedAt: '2001-01-01T00:00:00.000Z',
    });
    saveProjectManifest(filePath, loaded.manifest);

    const saved = fs.readFileSync(filePath, 'utf-8');
    const reparsed = JSON.parse(saved) as ProjectManifest;
    assert.equal(reparsed.sections.commands?.['build::cursor']?.hash, 'new');
    assert.equal(
      (reparsed.sections.commands?.['build::cursor'] as Record<string, unknown>).futureEntry,
      9
    );
    assert.deepEqual((reparsed as Record<string, unknown>).futureTop, { keep: true });
    assert.equal(JSON.stringify(reparsed.sections.skills), untouchedBefore);
    assert.equal(reparsed.projectRoot, root);
    assert.notEqual(reparsed.updatedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(saved.endsWith('\n'), true);
    assert.equal(saved.endsWith('\n\n'), false);
  });
});

test('project library entries use component::target keys and parse only the first separator', () => {
  const manifest = emptyProjectManifest('/project');
  recordProjectLibraryEntry(manifest, 'skills', 'pack::lint', {
    relativePath: '.agents/skills/pack-lint',
    targetId: 'codex',
    hash: 'hash1',
    updatedAt: '',
  });
  assert.equal(getProjectLibraryEntry(manifest, 'skills', 'pack::lint', 'codex')?.hash, 'hash1');
  assert.deepEqual(
    computeProjectLibraryCleanupSet(manifest, 'skills', new Set(), 'codex').map((item) => item.id),
    ['pack']
  );
  removeProjectLibraryEntry(manifest, 'skills', 'pack::lint', 'codex');
  assert.equal(getProjectLibraryEntry(manifest, 'skills', 'pack::lint', 'codex'), undefined);
});

test('project library cleanup filters by target and returns stale entries', () => {
  const manifest = emptyProjectManifest('/project');
  for (const [id, targetId] of [
    ['keep', 'claude-code'],
    ['drop', 'claude-code'],
    ['other', 'cursor'],
  ] as const) {
    recordProjectLibraryEntry(manifest, 'commands', id, {
      relativePath: `${id}.md`,
      targetId,
      hash: 'h',
      updatedAt: '',
    });
  }
  const stale = computeProjectLibraryCleanupSet(
    manifest,
    'commands',
    new Set(['keep']),
    'claude-code'
  );
  assert.deepEqual(
    stale.map((item) => item.id),
    ['drop']
  );
});

test('managed MCP entries record, query, clean, and remove by 0.4 composite key', () => {
  const manifest = emptyProjectManifest('/project');
  recordManagedMcpEntry(manifest, 'server::one', {
    relativePath: '.mcp.json',
    targetId: 'claude-code',
    serverKey: 'server-one',
    updatedAt: '',
  });
  recordManagedMcpEntry(manifest, 'server::one', {
    relativePath: '.cursor/mcp.json',
    targetId: 'cursor',
    serverKey: 'server-one',
    updatedAt: '',
  });
  assert.deepEqual([...ownedManagedMcpServers(manifest, 'claude-code')], ['server']);
  assert.deepEqual(computeProjectMcpCleanupSet(manifest, new Set(), 'cursor'), [
    'server::one::cursor',
  ]);
  removeManagedMcpEntry(manifest, 'server::one::cursor');
  assert.ok(manifest.sections.mcp?.['server::one::claude-code']);
  assert.equal(manifest.sections.mcp?.['server::one::cursor'], undefined);
});

test('same MCP server name for two targets does not collide', () => {
  const manifest = emptyProjectManifest('/project');
  for (const targetId of ['claude-code', 'cursor']) {
    recordManagedMcpEntry(manifest, 'same', {
      relativePath: targetId === 'cursor' ? '.cursor/mcp.json' : '.mcp.json',
      targetId,
      serverKey: 'same',
      updatedAt: '',
    });
  }
  assert.deepEqual(Object.keys(manifest.sections.mcp ?? {}), ['same::claude-code', 'same::cursor']);
});

test('well-formed manifest for a colliding slug names both project roots', async () => {
  await withScratchHomes(async (homes) => {
    const first = path.join(homes.root, 'a--b', 'c');
    const second = path.join(homes.root, 'a', 'b--c');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    assert.equal(
      projectManifestPath(homes.asbHome, first),
      projectManifestPath(homes.asbHome, second)
    );
    assert.throws(
      () => uniqueProjectManifestPaths(homes.asbHome, [first, second]),
      new RegExp(
        `${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        'i'
      )
    );

    const filePath = projectManifestPath(homes.asbHome, first);
    saveProjectManifest(filePath, emptyProjectManifest(first));
    const loaded = loadProjectManifest(homes.asbHome, second);
    assert.equal(loaded.corrupt, false);
    assert.equal(loaded.collision, true);
    assert.equal(loaded.manifest, null);
    assert.match(loaded.error ?? '', new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(loaded.error ?? '', new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
