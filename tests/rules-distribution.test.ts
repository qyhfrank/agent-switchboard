import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RULE_SUPPORTED_AGENTS } from '../src/rules/agents.js';
import { composeActiveRules } from '../src/rules/composer.js';
import {
  distributeRules,
  listIndirectAgents,
  listPerFileAgents,
  listUnsupportedAgents,
  resolveRuleFilePath,
} from '../src/rules/distribution.js';
import { ensureRulesDirectory } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, loadRuleState, saveRuleState } from '../src/rules/state.js';
import { withTempAsbHome } from './helpers/tmp.js';

const composedAgentIds = new Set<string>(RULE_SUPPORTED_AGENTS);

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
    const composedResults1 = outcome1.results.filter((r) => composedAgentIds.has(r.agent));

    assert.equal(composedResults1.length > 0, true);
    composedResults1.forEach((result) => {
      assert.equal(result.status, 'written');
      const content = fs.readFileSync(result.filePath, 'utf-8');
      if (result.agent === 'cursor') {
        assert.ok(content.startsWith('---\n'));
        assert.ok(content.includes(composed1.content));
      } else {
        assert.equal(content, composed1.content);
      }
    });

    const stateAfterFirst = loadRuleState();
    for (const result of composedResults1) {
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
    const composedResults2 = outcome2.results.filter((r) => composedAgentIds.has(r.agent));
    composedResults2.forEach((result) => {
      assert.equal(result.status, 'written');
      const current = fs.readFileSync(result.filePath, 'utf-8');
      if (result.agent === 'cursor') {
        assert.ok(current.includes(composed2.content));
      } else {
        assert.equal(current, composed2.content);
      }
    });

    const stateAfterSecond = loadRuleState();
    composedResults2.forEach((result) => {
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
    outcome3.results
      .filter((r) => composedAgentIds.has(r.agent))
      .forEach((result) => {
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

    for (const agent of RULE_SUPPORTED_AGENTS) {
      const filePath = resolveRuleFilePath(agent);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const content =
        agent === 'cursor'
          ? `---\ndescription: Agent Switchboard Rules\nalwaysApply: true\n---\n\n${composed.content}`
          : composed.content;
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    const outcome = distributeRules(composed);
    const composedResults = outcome.results.filter((r) => composedAgentIds.has(r.agent));
    composedResults.forEach((result) => {
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'up-to-date');
    });

    const state = loadRuleState();
    for (const agent of RULE_SUPPORTED_AGENTS) {
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
    firstOutcome.results
      .filter((r) => composedAgentIds.has(r.agent))
      .forEach((result) => {
        assert.equal(result.status, 'written');
      });

    const forcedOutcome = distributeRules(composed, { force: true });
    forcedOutcome.results
      .filter((r) => composedAgentIds.has(r.agent))
      .forEach((result) => {
        assert.equal(result.status, 'written');
        assert.equal(result.reason, 'refreshed');
        const current = fs.readFileSync(result.filePath, 'utf-8');
        if (result.agent === 'cursor') {
          assert.ok(current.includes(composed.content));
        } else {
          assert.equal(current, composed.content);
        }
      });
  });
});

test('listUnsupportedAgents returns skipped agent identifiers', () => {
  const unsupported = listUnsupportedAgents();
  assert.equal(Array.isArray(unsupported), true);
  assert.ok(unsupported.includes('claude-desktop'));
  assert.ok(!unsupported.includes('cursor'));
});

test('listIndirectAgents does not include cursor', () => {
  const indirect = listIndirectAgents();
  assert.equal(Array.isArray(indirect), true);
  assert.ok(!indirect.includes('cursor'));
});

test('listPerFileAgents returns empty (cursor moved to single-file)', () => {
  const perFile = listPerFileAgents();
  assert.equal(Array.isArray(perFile), true);
  assert.equal(perFile.length, 0);
});
