import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeLibraryCleanupSet,
  computeMcpCleanupSet,
  getLibraryEntry,
  getOwnedMcpServers,
  loadManifest,
  projectPathToSlug,
  recordLibraryEntry,
  recordMcpEntry,
  removeLibraryEntry,
  removeMcpEntry,
  resolveManifestPath,
  saveManifest,
} from '../src/manifest/store.js';
import type { ProjectDistributionManifest } from '../src/manifest/types.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('projectPathToSlug: path under home uses -- separator', () => {
  const home = os.homedir();
  assert.equal(projectPathToSlug(`${home}/Documents/Projects/foo`), 'Documents--Projects--foo');
});

test('projectPathToSlug: path outside home uses _abs prefix', () => {
  assert.equal(projectPathToSlug('/opt/project'), '_abs--opt--project');
});

test('projectPathToSlug: home root itself returns empty string', () => {
  const home = os.homedir();
  assert.equal(projectPathToSlug(home), '');
});

test('loadManifest returns empty manifest when file does not exist', () => {
  withTempAsbHome(() => {
    const result = loadManifest('/fake/project');
    assert.equal(result.existedOnDisk, false);
    assert.equal(result.corrupt, false);
    assert.equal(result.manifest.version, 1);
    assert.deepStrictEqual(result.manifest.sections, {});
  });
});

test('saveManifest creates directory and writes manifest', () => {
  withTempAsbHome(() => {
    const projectRoot = '/fake/project';
    const { manifest } = loadManifest(projectRoot);
    recordLibraryEntry(manifest, 'commands', 'test-cmd', {
      relativePath: '.claude/commands/test-cmd.md',
      targetId: 'claude-code',
      hash: 'abc123',
      updatedAt: new Date().toISOString(),
    });
    saveManifest(projectRoot, manifest);

    const filePath = resolveManifestPath(projectRoot);
    assert.ok(fs.existsSync(filePath));

    const reloaded = loadManifest(projectRoot);
    assert.equal(reloaded.manifest.version, 1);
    const entry = getLibraryEntry(reloaded.manifest, 'commands', 'test-cmd', 'claude-code');
    assert.ok(entry);
    assert.equal(entry.targetId, 'claude-code');
  });
});

test('recordLibraryEntry and removeLibraryEntry work correctly', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  recordLibraryEntry(manifest, 'skills', 'my-skill', {
    relativePath: '.claude/skills/my-skill',
    targetId: 'claude-code',
    hash: 'hash1',
    updatedAt: '',
  });

  const entry = getLibraryEntry(manifest, 'skills', 'my-skill', 'claude-code');
  assert.ok(entry);
  assert.equal(entry.hash, 'hash1');

  removeLibraryEntry(manifest, 'skills', 'my-skill');
  assert.equal(getLibraryEntry(manifest, 'skills', 'my-skill'), undefined);
});

test('recordMcpEntry and removeMcpEntry work correctly', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  recordMcpEntry(manifest, 'my-server', {
    relativePath: '.cursor/mcp.json',
    targetId: 'cursor',
    serverKey: 'my-server',
    updatedAt: '',
  });

  // Stored with composite key: serverName::targetId
  assert.ok(manifest.sections.mcp?.['my-server::cursor']);
  assert.equal(manifest.sections.mcp['my-server::cursor'].targetId, 'cursor');

  removeMcpEntry(manifest, 'my-server::cursor');
  assert.equal(manifest.sections.mcp?.['my-server::cursor'], undefined);
});

test('computeLibraryCleanupSet returns previously owned items not in current set', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      commands: {
        'cmd-a::claude-code': {
          relativePath: 'a',
          targetId: 'claude-code',
          hash: 'h',
          updatedAt: '',
        },
        'cmd-b::claude-code': {
          relativePath: 'b',
          targetId: 'claude-code',
          hash: 'h',
          updatedAt: '',
        },
        'cmd-c::cursor': { relativePath: 'c', targetId: 'cursor', hash: 'h', updatedAt: '' },
      },
    },
  };

  const toClean = computeLibraryCleanupSet(manifest, 'commands', new Set(['cmd-a']), 'claude-code');
  assert.equal(toClean.length, 1);
  assert.equal(toClean[0].id, 'cmd-b');
  assert.equal(toClean[0].entry.relativePath, 'b');
});

test('computeLibraryCleanupSet without targetId filter returns all stale', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      agents: {
        'agent-x::claude-code': {
          relativePath: 'x',
          targetId: 'claude-code',
          hash: 'h',
          updatedAt: '',
        },
        'agent-y::cursor': { relativePath: 'y', targetId: 'cursor', hash: 'h', updatedAt: '' },
      },
    },
  };

  const toClean = computeLibraryCleanupSet(manifest, 'agents', new Set([]));
  assert.deepStrictEqual(toClean.map((i) => i.id).sort(), ['agent-x', 'agent-y']);
});

test('computeMcpCleanupSet returns stale MCP entries as composite keys', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      mcp: {
        'server-a::claude-code': {
          relativePath: 'a',
          targetId: 'claude-code',
          serverKey: 'server-a',
          updatedAt: '',
        },
        'server-b::claude-code': {
          relativePath: 'b',
          targetId: 'claude-code',
          serverKey: 'server-b',
          updatedAt: '',
        },
      },
    },
  };

  const toClean = computeMcpCleanupSet(manifest, new Set(['server-a']));
  assert.deepStrictEqual(toClean, ['server-b::claude-code']);
});

test('getOwnedMcpServers returns bare server names for specific target', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      mcp: {
        'server-a::claude-code': {
          relativePath: 'a',
          targetId: 'claude-code',
          serverKey: 'server-a',
          updatedAt: '',
        },
        'server-b::cursor': {
          relativePath: 'b',
          targetId: 'cursor',
          serverKey: 'server-b',
          updatedAt: '',
        },
        'server-c::claude-code': {
          relativePath: 'c',
          targetId: 'claude-code',
          serverKey: 'server-c',
          updatedAt: '',
        },
      },
    },
  };

  const owned = getOwnedMcpServers(manifest, 'claude-code');
  assert.deepStrictEqual([...owned].sort(), ['server-a', 'server-c']);
});

test('getLibraryEntry returns entry when exists', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      commands: {
        'my-cmd::claude-code': {
          relativePath: 'x',
          targetId: 'claude-code',
          hash: 'h1',
          updatedAt: '',
        },
      },
    },
  };

  // Without targetId: scans all keys
  const entry = getLibraryEntry(manifest, 'commands', 'my-cmd');
  assert.ok(entry);
  assert.equal(entry.hash, 'h1');

  // With targetId: direct composite key lookup
  const entry2 = getLibraryEntry(manifest, 'commands', 'my-cmd', 'claude-code');
  assert.ok(entry2);
  assert.equal(entry2.hash, 'h1');
});

test('getLibraryEntry returns undefined for non-existent entry', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  const entry = getLibraryEntry(manifest, 'commands', 'missing');
  assert.equal(entry, undefined);
});

test('getLibraryEntry filters by targetId', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      commands: {
        'my-cmd::cursor': { relativePath: 'x', targetId: 'cursor', hash: 'h1', updatedAt: '' },
      },
    },
  };

  assert.ok(getLibraryEntry(manifest, 'commands', 'my-cmd', 'cursor'));
  assert.equal(getLibraryEntry(manifest, 'commands', 'my-cmd', 'claude-code'), undefined);
});

test('loadManifest flags corrupt JSON', () => {
  withTempAsbHome(() => {
    const projectRoot = '/fake/corrupt-project';
    const filePath = resolveManifestPath(projectRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'not valid json', 'utf-8');

    const result = loadManifest(projectRoot);
    assert.equal(result.existedOnDisk, true);
    assert.equal(result.corrupt, true);
    assert.equal(result.manifest.version, 1);
    assert.deepStrictEqual(result.manifest.sections, {});
  });
});

test('loadManifest flags unsupported version as corrupt', () => {
  withTempAsbHome(() => {
    const projectRoot = '/fake/version-project';
    const filePath = resolveManifestPath(projectRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, sections: {} }), 'utf-8');

    const result = loadManifest(projectRoot);
    assert.equal(result.existedOnDisk, true);
    assert.equal(result.corrupt, true);
    assert.equal(result.manifest.version, 1);
    assert.deepStrictEqual(result.manifest.sections, {});
  });
});

test('MCP entries with same server name but different targets do not collide', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  recordMcpEntry(manifest, 'my-server', {
    relativePath: '.mcp.json',
    targetId: 'claude-code',
    serverKey: 'my-server',
    updatedAt: '',
  });
  recordMcpEntry(manifest, 'my-server', {
    relativePath: '.cursor/mcp.json',
    targetId: 'cursor',
    serverKey: 'my-server',
    updatedAt: '',
  });

  // Both entries coexist
  assert.ok(manifest.sections.mcp?.['my-server::claude-code']);
  assert.ok(manifest.sections.mcp?.['my-server::cursor']);

  // getOwnedMcpServers returns correct per-target sets
  const claudeOwned = getOwnedMcpServers(manifest, 'claude-code');
  assert.ok(claudeOwned.has('my-server'));
  const cursorOwned = getOwnedMcpServers(manifest, 'cursor');
  assert.ok(cursorOwned.has('my-server'));

  // computeMcpCleanupSet filters by target
  const toClean = computeMcpCleanupSet(manifest, new Set([]), 'cursor');
  assert.equal(toClean.length, 1);
  assert.equal(toClean[0], 'my-server::cursor');

  // Removing cursor entry does not affect claude-code entry
  removeMcpEntry(manifest, 'my-server::cursor');
  assert.ok(manifest.sections.mcp?.['my-server::claude-code']);
  assert.equal(manifest.sections.mcp?.['my-server::cursor'], undefined);
});
