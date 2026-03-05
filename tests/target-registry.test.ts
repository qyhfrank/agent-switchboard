import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allTargetIds,
  clearExtensionTargets,
  getActiveTargetsForSection,
  getTargetById,
  getTargetsForSection,
  isKnownTarget,
  registerExtensionTarget,
} from '../src/targets/registry.js';
import type { ApplicationTarget } from '../src/targets/types.js';

// Cleanup after each test to avoid cross-test pollution
function cleanup() {
  clearExtensionTargets();
}

// ---------------------------------------------------------------------------
// Built-in target lookup
// ---------------------------------------------------------------------------

test('getTargetById returns claude-code built-in target', () => {
  cleanup();
  const target = getTargetById('claude-code');
  assert.ok(target);
  assert.equal(target.id, 'claude-code');
  assert.ok(target.mcp, 'claude-code should support MCP');
  assert.ok(target.rules, 'claude-code should support rules');
  assert.ok(target.commands, 'claude-code should support commands');
});

test('getTargetById returns undefined for unknown id', () => {
  cleanup();
  assert.equal(getTargetById('nonexistent'), undefined);
});

test('isKnownTarget returns true for built-in targets', () => {
  cleanup();
  assert.ok(isKnownTarget('claude-code'));
  assert.ok(isKnownTarget('cursor'));
  assert.ok(isKnownTarget('codex'));
  assert.ok(!isKnownTarget('nonexistent'));
});

test('allTargetIds includes all built-in targets', () => {
  cleanup();
  const ids = allTargetIds();
  assert.ok(ids.includes('claude-code'));
  assert.ok(ids.includes('cursor'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('gemini'));
  assert.ok(ids.includes('opencode'));
  assert.ok(ids.includes('trae'));
  assert.ok(ids.includes('trae-cn'));
  assert.ok(ids.includes('claude-desktop'));
});

// ---------------------------------------------------------------------------
// Section-based queries
// ---------------------------------------------------------------------------

test('getTargetsForSection returns targets supporting MCP', () => {
  cleanup();
  const targets = getTargetsForSection('mcp');
  const ids = targets.map((t) => t.id);
  assert.ok(ids.includes('claude-code'));
  assert.ok(ids.includes('cursor'));
  assert.ok(ids.includes('claude-desktop'));
});

test('getTargetsForSection returns targets supporting commands', () => {
  cleanup();
  const targets = getTargetsForSection('commands');
  const ids = targets.map((t) => t.id);
  assert.ok(ids.includes('claude-code'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('cursor'));
  assert.ok(!ids.includes('claude-desktop'), 'claude-desktop should not support commands');
});

test('getActiveTargetsForSection filters by active IDs', () => {
  cleanup();
  const targets = getActiveTargetsForSection('mcp', ['claude-code', 'cursor']);
  const ids = targets.map((t) => t.id);
  assert.deepEqual(ids.sort(), ['claude-code', 'cursor']);
});

test('getActiveTargetsForSection skips unknown IDs', () => {
  cleanup();
  const targets = getActiveTargetsForSection('mcp', ['claude-code', 'nonexistent']);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'claude-code');
});

// ---------------------------------------------------------------------------
// Extension target registration
// ---------------------------------------------------------------------------

test('registerExtensionTarget adds a new target', () => {
  cleanup();
  const custom: ApplicationTarget = {
    id: 'my-custom',
    rules: {
      resolveFilePath: () => '/tmp/test',
      render: (c) => c,
    },
  };
  registerExtensionTarget(custom);
  const found = getTargetById('my-custom');
  assert.ok(found);
  assert.equal(found.id, 'my-custom');
  assert.ok(found.rules);
  cleanup();
});

test('extension targets override built-in targets with same ID', () => {
  cleanup();
  const override: ApplicationTarget = {
    id: 'cursor',
    rules: {
      resolveFilePath: () => '/custom/path',
      render: (c) => `CUSTOM:${c}`,
    },
  };
  registerExtensionTarget(override);
  const found = getTargetById('cursor');
  assert.ok(found);
  assert.equal(found.rules?.render('hello'), 'CUSTOM:hello');
  cleanup();
});

test('extension targets appear in allTargetIds', () => {
  cleanup();
  registerExtensionTarget({ id: 'test-ext' });
  const ids = allTargetIds();
  assert.ok(ids.includes('test-ext'));
  cleanup();
});

test('extension targets appear in getTargetsForSection', () => {
  cleanup();
  registerExtensionTarget({
    id: 'test-ext',
    commands: {
      resolveTargetDir: () => '/tmp',
      getFilename: (id) => `${id}.md`,
      render: (e) => e.content,
      extractIdFromFilename: (f) => f.replace('.md', ''),
    },
  });
  const targets = getTargetsForSection('commands');
  assert.ok(targets.some((t) => t.id === 'test-ext'));
  cleanup();
});

test('clearExtensionTargets removes all extension targets', () => {
  registerExtensionTarget({ id: 'temp-1' });
  registerExtensionTarget({ id: 'temp-2' });
  assert.ok(isKnownTarget('temp-1'));
  clearExtensionTargets();
  assert.ok(!isKnownTarget('temp-1'));
  assert.ok(!isKnownTarget('temp-2'));
});
