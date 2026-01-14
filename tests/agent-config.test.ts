import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  mergeIncrementalSelection,
  resolveAgentSectionConfig,
  hasAgentOverrides,
  getAgentsWithOverrides,
} from '../src/config/agent-config.js';
import { loadMergedSwitchboardConfig } from '../src/config/layered-config.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('mergeIncrementalSelection returns base when no override', () => {
  const base = ['a', 'b', 'c'];
  const result = mergeIncrementalSelection(base, undefined);
  assert.deepEqual(result, ['a', 'b', 'c']);
});

test('mergeIncrementalSelection uses active as complete override', () => {
  const base = ['a', 'b', 'c'];
  const result = mergeIncrementalSelection(base, { active: ['x', 'y'] });
  assert.deepEqual(result, ['x', 'y']);
});

test('mergeIncrementalSelection applies remove then add', () => {
  const base = ['a', 'b', 'c'];
  const result = mergeIncrementalSelection(base, { remove: ['b'], add: ['d'] });
  assert.deepEqual(result, ['a', 'c', 'd']);
});

test('mergeIncrementalSelection handles remove only', () => {
  const base = ['a', 'b', 'c'];
  const result = mergeIncrementalSelection(base, { remove: ['a', 'c'] });
  assert.deepEqual(result, ['b']);
});

test('mergeIncrementalSelection handles add only', () => {
  const base = ['a', 'b'];
  const result = mergeIncrementalSelection(base, { add: ['c', 'd'] });
  assert.deepEqual(result, ['a', 'b', 'c', 'd']);
});

test('mergeIncrementalSelection does not add duplicates', () => {
  const base = ['a', 'b'];
  const result = mergeIncrementalSelection(base, { add: ['b', 'c'] });
  assert.deepEqual(result, ['a', 'b', 'c']);
});

test('resolveAgentSectionConfig applies per-agent override', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["claude-code", "codex"]',
        '',
        '[skills]',
        'active = ["skill-a", "skill-b", "skill-c"]',
        '',
        '[agents.codex.skills]',
        'remove = ["skill-b"]',
        'add = ["skill-d"]',
      ].join('\n')
    );

    const result = resolveAgentSectionConfig('skills', 'codex');
    assert.deepEqual(result.active, ['skill-a', 'skill-c', 'skill-d']);
  });
});

test('resolveAgentSectionConfig returns global config when no override', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["claude-code", "codex"]',
        '',
        '[skills]',
        'active = ["skill-a", "skill-b"]',
      ].join('\n')
    );

    const result = resolveAgentSectionConfig('skills', 'claude-code');
    assert.deepEqual(result.active, ['skill-a', 'skill-b']);
  });
});

test('hasAgentOverrides detects agent with overrides', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["claude-code", "codex"]',
        '',
        '[agents.codex.skills]',
        'remove = ["skill-a"]',
      ].join('\n')
    );

    const { config } = loadMergedSwitchboardConfig();
    assert.equal(hasAgentOverrides(config, 'codex'), true);
    assert.equal(hasAgentOverrides(config, 'claude-code'), false);
  });
});

test('getAgentsWithOverrides lists all agents with overrides', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["claude-code", "codex", "gemini"]',
        '',
        '[agents.codex.skills]',
        'remove = ["skill-a"]',
        '',
        '[agents.gemini.commands]',
        'add = ["cmd-gemini"]',
      ].join('\n')
    );

    const { config } = loadMergedSwitchboardConfig();
    const result = getAgentsWithOverrides(config);
    assert.deepEqual(result.sort(), ['codex', 'gemini']);
  });
});

test('per-agent override with complete active replacement', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["claude-code", "codex"]',
        '',
        '[skills]',
        'active = ["skill-a", "skill-b", "skill-c"]',
        '',
        '[agents.codex.skills]',
        'active = ["skill-x", "skill-y"]',
      ].join('\n')
    );

    const result = resolveAgentSectionConfig('skills', 'codex');
    assert.deepEqual(result.active, ['skill-x', 'skill-y']);
  });
});
