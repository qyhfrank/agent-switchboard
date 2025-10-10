import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parse } from '@iarna/toml';
import { getSwitchboardConfigPath } from '../src/config/paths.js';
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

    const configPath = getSwitchboardConfigPath();
    assert.equal(fs.existsSync(configPath), false);
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

    const configPath = getSwitchboardConfigPath();
    assert.equal(fs.existsSync(configPath), true);
    const tomlContent = fs.readFileSync(configPath, 'utf-8');
    const parsedToml = parse(tomlContent) as Record<string, unknown>;
    const rules = (parsedToml.rules ?? {}) as Record<string, unknown>;
    assert.deepEqual(rules.active, ['alpha', 'beta']);

    const loaded = loadRuleState();
    assert.deepEqual(loaded.active, ['alpha', 'beta']);
    assert.equal(loaded.agentSync.claude.hash, '123');

    // Ensure directory was created under ASB_HOME
    assert.equal(fs.existsSync(configDir), true);
  });
});

test('updateRuleState applies mutator and persists result', () => {
  withTempAsbHome(() => {
    const result = updateRuleState(() => ({
      ...DEFAULT_RULE_STATE,
      active: ['r1', 'r2'],
    }));

    assert.deepEqual(result.active, ['r1', 'r2']);

    const configPath = getSwitchboardConfigPath();
    const tomlContent = fs.readFileSync(configPath, 'utf-8');
    const parsedToml = parse(tomlContent) as Record<string, unknown>;
    const rules = (parsedToml.rules ?? {}) as Record<string, unknown>;
    assert.deepEqual(rules.active, ['r1', 'r2']);

    const reloaded = loadRuleState();
    assert.deepEqual(reloaded.active, ['r1', 'r2']);
  });
});
