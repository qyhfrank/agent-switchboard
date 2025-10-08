import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { composeActiveRules } from '../src/rules/composer.js';
import {
  distributeRules,
  listUnsupportedAgents,
  resolveRuleFilePath,
} from '../src/rules/distribution.js';
import { ensureRulesDirectory } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, loadRuleState, saveRuleState } from '../src/rules/state.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('distributeRules writes rule document and updates state', () => {
  withTempAsbHome(() => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(
      path.join(rulesDir, 'alpha.md'),
      '---\n' + 'title: Alpha\n' + '---\n' + 'First version\n'
    );
    fs.writeFileSync(path.join(rulesDir, 'beta.md'), 'Beta body\n');

    saveRuleState({
      ...DEFAULT_RULE_STATE,
      active: ['alpha', 'beta'],
      agentSync: {},
    });

    const composed1 = composeActiveRules();
    const outcome1 = distributeRules(composed1);

    assert.equal(outcome1.results.length > 0, true);
    outcome1.results.forEach((result) => {
      assert.equal(result.status, 'written');
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assert.equal(content, composed1.content);
    });

    const stateAfterFirst = loadRuleState();
    for (const result of outcome1.results) {
      const sync = stateAfterFirst.agentSync[result.agent];
      assert.equal(sync?.hash, composed1.hash);
      assert.notEqual(sync?.updatedAt, undefined);
    }

    // Prepare for second run with modified content to trigger rewrite
    // previous content no longer backed up; rewrite should replace content in-place

    fs.writeFileSync(
      path.join(rulesDir, 'alpha.md'),
      '---\n' + 'title: Alpha\n' + '---\n' + 'Second version\n'
    );

    const composed2 = composeActiveRules();
    const outcome2 = distributeRules(composed2);
    outcome2.results.forEach((result) => {
      assert.equal(result.status, 'written');
      const current = fs.readFileSync(result.filePath, 'utf-8');
      assert.equal(current, composed2.content);
    });

    const stateAfterSecond = loadRuleState();
    outcome2.results.forEach((result) => {
      const sync = stateAfterSecond.agentSync[result.agent];
      assert.equal(sync?.hash, composed2.hash);
    });

    // Third run with no changes should skip updates
    const composed3 = composeActiveRules();
    const outcome3 = distributeRules(composed3);
    outcome3.results.forEach((result) => {
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'up-to-date');
    });

    const stateAfterThird = loadRuleState();
    outcome3.results.forEach((result) => {
      const sync = stateAfterThird.agentSync[result.agent];
      assert.equal(sync?.hash, composed3.hash);
    });
  });
});

test('distributeRules updates state when files already match content', () => {
  withTempAsbHome(() => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'only.md'), 'Only body\n');

    saveRuleState({
      ...DEFAULT_RULE_STATE,
      active: ['only'],
      agentSync: {},
    });

    const composed = composeActiveRules();

    for (const agent of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      const filePath = resolveRuleFilePath(agent);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, composed.content, 'utf-8');
    }

    const outcome = distributeRules(composed);
    outcome.results.forEach((result) => {
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'up-to-date');
    });

    const state = loadRuleState();
    for (const agent of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      const sync = state.agentSync[agent];
      assert.equal(sync?.hash, composed.hash);
    }
  });
});

test('distributeRules with force rewrites matching content', () => {
  withTempAsbHome(() => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'only.md'), 'Only body\n');

    saveRuleState({
      ...DEFAULT_RULE_STATE,
      active: ['only'],
      agentSync: {},
    });

    const composed = composeActiveRules();

    const firstOutcome = distributeRules(composed);
    firstOutcome.results.forEach((result) => {
      assert.equal(result.status, 'written');
    });

    const forcedOutcome = distributeRules(composed, { force: true });
    forcedOutcome.results.forEach((result) => {
      assert.equal(result.status, 'written');
      assert.equal(result.reason, 'refreshed');
      const current = fs.readFileSync(result.filePath, 'utf-8');
      assert.equal(current, composed.content);
    });
  });
});

test('listUnsupportedAgents returns skipped agent identifiers', () => {
  const unsupported = listUnsupportedAgents();
  assert.equal(Array.isArray(unsupported), true);
  assert.ok(unsupported.includes('claude-desktop'));
  assert.ok(unsupported.includes('cursor'));
});
