import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  getClaudeDir,
  getCodexDir,
  getCursorDir,
  getGeminiDir,
  getOpencodeRoot,
} from '../src/config/paths.js';
import { clearExtensionTargets, filterInstalled, getTargetById } from '../src/targets/registry.js';
import type { ApplicationTarget } from '../src/targets/types.js';
import { withTempAgentsHome } from './helpers/tmp.js';

function cleanup() {
  clearExtensionTargets();
}

// ---------------------------------------------------------------------------
// isInstalled detection for each built-in target
// ---------------------------------------------------------------------------

test('claude-code: isInstalled returns false when ~/.claude missing', () => {
  cleanup();
  withTempAgentsHome(() => {
    const target = getTargetById('claude-code');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), false);
  });
});

test('claude-code: isInstalled returns true when ~/.claude exists', () => {
  cleanup();
  withTempAgentsHome(() => {
    fs.mkdirSync(getClaudeDir(), { recursive: true });
    const target = getTargetById('claude-code');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), true);
  });
});

test('cursor: isInstalled returns false when ~/.cursor missing', () => {
  cleanup();
  withTempAgentsHome(() => {
    const target = getTargetById('cursor');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), false);
  });
});

test('cursor: isInstalled returns true when ~/.cursor exists', () => {
  cleanup();
  withTempAgentsHome(() => {
    fs.mkdirSync(getCursorDir(), { recursive: true });
    const target = getTargetById('cursor');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), true);
  });
});

test('codex: isInstalled returns false when ~/.codex missing', () => {
  cleanup();
  withTempAgentsHome(() => {
    const target = getTargetById('codex');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), false);
  });
});

test('codex: isInstalled returns true when ~/.codex exists', () => {
  cleanup();
  withTempAgentsHome(() => {
    fs.mkdirSync(getCodexDir(), { recursive: true });
    const target = getTargetById('codex');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), true);
  });
});

test('gemini: isInstalled returns false when ~/.gemini missing', () => {
  cleanup();
  withTempAgentsHome(() => {
    const target = getTargetById('gemini');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), false);
  });
});

test('gemini: isInstalled returns true when ~/.gemini exists', () => {
  cleanup();
  withTempAgentsHome(() => {
    fs.mkdirSync(getGeminiDir(), { recursive: true });
    const target = getTargetById('gemini');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), true);
  });
});

test('opencode: isInstalled returns false when config dir missing', () => {
  cleanup();
  withTempAgentsHome(() => {
    const target = getTargetById('opencode');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), false);
  });
});

test('opencode: isInstalled returns true when config dir exists', () => {
  cleanup();
  withTempAgentsHome(() => {
    fs.mkdirSync(getOpencodeRoot(), { recursive: true });
    const target = getTargetById('opencode');
    assert.ok(target);
    assert.equal(target.isInstalled?.(), true);
  });
});

// ---------------------------------------------------------------------------
// filterInstalled with assumeInstalled
// ---------------------------------------------------------------------------

test('filterInstalled excludes targets with isInstalled() === false', () => {
  cleanup();
  const installed: ApplicationTarget = { id: 'app-a', isInstalled: () => true };
  const notInstalled: ApplicationTarget = { id: 'app-b', isInstalled: () => false };
  const noDetection: ApplicationTarget = { id: 'app-c' };

  const result = filterInstalled([installed, notInstalled, noDetection]);
  const ids = result.map((t) => t.id);
  assert.deepEqual(ids, ['app-a', 'app-c']);
});

test('filterInstalled respects assumeInstalled override', () => {
  cleanup();
  const notInstalled: ApplicationTarget = { id: 'app-b', isInstalled: () => false };
  const alsoNotInstalled: ApplicationTarget = { id: 'app-d', isInstalled: () => false };

  const assumeSet = new Set(['app-b']);
  const result = filterInstalled([notInstalled, alsoNotInstalled], assumeSet);
  const ids = result.map((t) => t.id);
  assert.deepEqual(ids, ['app-b']);
});

test('filterInstalled without assumeInstalled behaves as before', () => {
  cleanup();
  const installed: ApplicationTarget = { id: 'app-a', isInstalled: () => true };
  const notInstalled: ApplicationTarget = { id: 'app-b', isInstalled: () => false };

  const result = filterInstalled([installed, notInstalled]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'app-a');
});

// ---------------------------------------------------------------------------
// Schema: assume_installed
// ---------------------------------------------------------------------------

test('applicationsSectionSchema defaults assume_installed to empty array', async () => {
  const { switchboardConfigSchema } = await import('../src/config/schemas.js');
  const parsed = switchboardConfigSchema.parse({});
  assert.deepEqual(parsed.applications.assume_installed, []);
});

test('applicationsSectionSchema parses assume_installed array', async () => {
  const { switchboardConfigSchema } = await import('../src/config/schemas.js');
  const parsed = switchboardConfigSchema.parse({
    applications: { assume_installed: ['codex', 'gemini'] },
  });
  assert.deepEqual(parsed.applications.assume_installed, ['codex', 'gemini']);
});
