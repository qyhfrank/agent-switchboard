import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getRuleStatePath } from '../src/config/paths.js';
import {
  DEFAULT_RULE_STATE,
  loadRuleState,
  saveRuleState,
  updateRuleState,
} from '../src/rules/state.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('loadRuleState returns defaults when file is missing', () => {
  withTempAsbHome(() => {
    const state = loadRuleState();
    assert.deepEqual(state, DEFAULT_RULE_STATE);

    const statePath = getRuleStatePath();
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('saveRuleState creates directory and normalizes active ids', () => {
  withTempAsbHome((configDir) => {
    const savedState = {
      active: [' alpha ', 'alpha', 'beta'],
      agentSync: {
        claude: { hash: '123', updatedAt: new Date('2024-01-02T03:04:05.000Z').toISOString() },
      },
    };

    saveRuleState(savedState);

    const statePath = getRuleStatePath();
    assert.equal(fs.existsSync(statePath), true);

    const fileContent = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(fileContent.active, ['alpha', 'beta']);

    const loaded = loadRuleState();
    assert.deepEqual(loaded.active, ['alpha', 'beta']);
    assert.equal(loaded.agentSync.claude.hash, '123');

    // Ensure directory was created under ASB_HOME
    assert.equal(fs.existsSync(configDir), true);
  });
});

test('loadRuleState surfaces JSON errors with context', () => {
  withTempAsbHome(() => {
    const statePath = getRuleStatePath();
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(statePath, '{broken');

    assert.throws(
      () => loadRuleState(),
      /Failed to load rule state/,
      'should wrap JSON parse errors'
    );
  });
});

test('updateRuleState applies mutator and persists result', () => {
  withTempAsbHome(() => {
    const result = updateRuleState(() => ({
      ...DEFAULT_RULE_STATE,
      active: ['r1', 'r2'],
    }));

    assert.deepEqual(result.active, ['r1', 'r2']);

    const statePath = getRuleStatePath();
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.deepEqual(persisted.active, ['r1', 'r2']);
  });
});
