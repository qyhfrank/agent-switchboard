import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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

function withTempAsbHome<T>(fn: (configDir: string) => T): T {
  const previousAsbHome = process.env.ASB_HOME;
  const previousAgentsHome = process.env.ASB_AGENTS_HOME;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-distribution-test-'));
  const configDir = path.join(tempRoot, 'config');
  process.env.ASB_HOME = configDir;
  process.env.ASB_AGENTS_HOME = configDir;
  try {
    return fn(configDir);
  } finally {
    process.env.ASB_HOME = previousAsbHome;
    process.env.ASB_AGENTS_HOME = previousAgentsHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('distributeRules writes rule document, creates backups, and updates state', () => {
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

    // Prepare for second run with modified content to trigger backup
    const previousContentByAgent = new Map(
      outcome1.results.map((result) => [result.agent, fs.readFileSync(result.filePath, 'utf-8')])
    );

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
      const backupPath = `${result.filePath}.bak`;
      assert.equal(fs.existsSync(backupPath), true);
      const backupContent = fs.readFileSync(backupPath, 'utf-8');
      assert.equal(backupContent, previousContentByAgent.get(result.agent));
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
      const backupPath = `${result.filePath}.bak`;
      assert.equal(fs.existsSync(backupPath), true);
    });
  });
});

test('listUnsupportedAgents returns skipped agent identifiers', () => {
  const unsupported = listUnsupportedAgents();
  assert.equal(Array.isArray(unsupported), true);
  assert.ok(unsupported.includes('claude-desktop'));
  assert.ok(unsupported.includes('cursor'));
});
