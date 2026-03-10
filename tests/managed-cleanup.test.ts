import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  computeLibraryCleanupSet,
  loadManifest,
  recordLibraryEntry,
} from '../src/manifest/store.js';
import type { ProjectDistributionManifest } from '../src/manifest/types.js';
import { withTempDir } from './helpers/tmp.js';

test('managed mode cleanup only removes previously owned entries', () => {
  withTempDir((dir) => {
    const projectRoot = path.join(dir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    // Set up manifest with two previously owned commands (composite keys)
    const manifest: ProjectDistributionManifest = {
      version: 1,
      updatedAt: '',
      sections: {
        commands: {
          'owned-cmd::test-platform': {
            relativePath: '.test/commands/owned-cmd.md',
            targetId: 'test-platform',
            hash: 'h1',
            updatedAt: '',
          },
          'still-active-cmd::test-platform': {
            relativePath: '.test/commands/still-active-cmd.md',
            targetId: 'test-platform',
            hash: 'h2',
            updatedAt: '',
          },
        },
      },
    };

    // Compute cleanup: only 'still-active-cmd' is still desired
    const toClean = computeLibraryCleanupSet(
      manifest,
      'commands',
      new Set(['still-active-cmd']),
      'test-platform'
    );

    const ids = toClean.map((i) => i.id);
    assert.deepStrictEqual(ids, ['owned-cmd']);
    assert.ok(!ids.includes('still-active-cmd'));
  });
});

test('managed mode cleanup does not touch entries from other targets', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      commands: {
        'cmd-for-claude::claude-code': {
          relativePath: 'a',
          targetId: 'claude-code',
          hash: 'h',
          updatedAt: '',
        },
        'cmd-for-cursor::cursor': {
          relativePath: 'b',
          targetId: 'cursor',
          hash: 'h',
          updatedAt: '',
        },
      },
    },
  };

  // Cleanup for claude-code with empty desired set should only return claude-code entries
  const toClean = computeLibraryCleanupSet(manifest, 'commands', new Set(), 'claude-code');
  const ids = toClean.map((i) => i.id);
  assert.deepStrictEqual(ids, ['cmd-for-claude']);
  assert.ok(!ids.includes('cmd-for-cursor'));
});

test('managed mode cleanup returns empty when no manifest section exists', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  const toClean = computeLibraryCleanupSet(manifest, 'skills', new Set());
  assert.deepStrictEqual(toClean, []);
});

test('recordLibraryEntry updates manifest on successful write', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  recordLibraryEntry(manifest, 'commands', 'my-cmd', {
    relativePath: '.claude/commands/my-cmd.md',
    targetId: 'claude-code',
    hash: 'sha256-hash',
    updatedAt: '2025-01-01T00:00:00Z',
  });

  assert.ok(manifest.sections.commands);
  assert.equal(Object.keys(manifest.sections.commands).length, 1);
  // Composite key: id::targetId
  assert.equal(manifest.sections.commands['my-cmd::claude-code'].hash, 'sha256-hash');
});

test('manifest-driven cleanup handles transition from no manifest to managed', () => {
  // When there's no prior manifest, cleanup set should be empty (no previously owned items)
  const freshManifest = loadManifest('/nonexistent/path');
  const toClean = computeLibraryCleanupSet(freshManifest, 'commands', new Set(['new-cmd']));
  assert.deepStrictEqual(toClean, []);
});
