import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { distributeCommands } from '../src/commands/distribution.js';
import { ensureCommandsDirectory } from '../src/commands/library.js';
import { renderDefaultCommandTemplate } from '../src/commands/template.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { distributeRules } from '../src/rules/distribution.js';
import { ensureRulesDirectory } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, saveRuleState } from '../src/rules/state.js';
import { distributeSkills } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { distributeSubagents } from '../src/subagents/distribution.js';
import { ensureAgentsDirectory } from '../src/subagents/library.js';
import { renderDefaultSubagentTemplate } from '../src/subagents/template.js';
import { clearExtensionTargets, registerExtensionTarget } from '../src/targets/registry.js';
import {
  simulateAppsInstalled,
  simulateTraeInstalled,
  withTempAsbHome,
  withTempHomes,
} from './helpers/tmp.js';

const managedProjectOptions = {
  projectMode: 'managed' as const,
  manifest: { version: 1 as const, updatedAt: '', sections: {} },
};

test('distributeRules: only distributes to activeAppIds targets', () => {
  withTempAsbHome(() => {
    simulateAppsInstalled();
    simulateTraeInstalled();
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'test-rule.md'), 'Rule body\n');
    saveRuleState({ ...DEFAULT_RULE_STATE, enabled: ['test-rule'], agentSync: {} });

    const outcome = distributeRules({ activeAppIds: ['claude-code'] });

    const agents = outcome.results.map((r) => r.agent);
    assert.ok(agents.includes('claude-code'), 'should include claude-code');
    assert.ok(!agents.includes('cursor'), 'should NOT include cursor');
    assert.ok(!agents.includes('trae'), 'should NOT include trae');
    assert.ok(!agents.includes('trae-cn'), 'should NOT include trae-cn');
  });
});

test('distributeRules: empty activeAppIds produces no results', () => {
  withTempAsbHome(() => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'test-rule.md'), 'Rule body\n');
    saveRuleState({ ...DEFAULT_RULE_STATE, enabled: ['test-rule'], agentSync: {} });

    const outcome = distributeRules({ activeAppIds: [] });

    assert.equal(outcome.results.length, 0);
  });
});

test('distributeCommands: only distributes to activeAppIds targets', () => {
  withTempHomes(() => {
    simulateAppsInstalled();
    const cmdDir = ensureCommandsDirectory();
    fs.writeFileSync(path.join(cmdDir, 'test-cmd.md'), renderDefaultCommandTemplate());
    updateLibraryStateSection('commands', () => ({ enabled: ['test-cmd'], agentSync: {} }));

    const outcome = distributeCommands(undefined, ['claude-code']);

    const platforms = new Set(outcome.results.map((r) => r.platform));
    assert.ok(platforms.has('claude-code'), 'should include claude-code');
    assert.ok(!platforms.has('cursor'), 'should NOT include cursor');
    assert.ok(!platforms.has('codex'), 'should NOT include codex');
  });
});

test('distributeCommands: empty activeAppIds produces no results', () => {
  withTempHomes(() => {
    const cmdDir = ensureCommandsDirectory();
    fs.writeFileSync(path.join(cmdDir, 'test-cmd.md'), renderDefaultCommandTemplate());
    updateLibraryStateSection('commands', () => ({ enabled: ['test-cmd'], agentSync: {} }));

    const outcome = distributeCommands(undefined, []);

    assert.equal(outcome.results.length, 0);
  });
});

test('distributeSubagents: only distributes to activeAppIds targets', () => {
  withTempHomes(() => {
    simulateAppsInstalled();
    const subDir = ensureAgentsDirectory();
    fs.writeFileSync(path.join(subDir, 'test-agent.md'), renderDefaultSubagentTemplate());
    updateLibraryStateSection('agents', () => ({ enabled: ['test-agent'], agentSync: {} }));

    const outcome = distributeSubagents(undefined, ['claude-code']);

    const platforms = new Set(outcome.results.map((r) => r.platform));
    assert.ok(platforms.has('claude-code'), 'should include claude-code');
    assert.ok(!platforms.has('cursor'), 'should NOT include cursor');
    assert.ok(!platforms.has('opencode'), 'should NOT include opencode');
  });
});

test('distributeSubagents: empty activeAppIds produces no results', () => {
  withTempHomes(() => {
    const subDir = ensureAgentsDirectory();
    fs.writeFileSync(path.join(subDir, 'test-agent.md'), renderDefaultSubagentTemplate());
    updateLibraryStateSection('agents', () => ({ enabled: ['test-agent'], agentSync: {} }));

    const outcome = distributeSubagents(undefined, []);

    assert.equal(outcome.results.length, 0);
  });
});

test('managed project preserves legacy OpenCode paths and calls extension agents', (t) => {
  t.after(clearExtensionTargets);
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex', 'opencode');
    const projectRoot = path.join(agentsHome, 'managed-opencode-project');
    const files = [
      path.join(agentsHome, '.codex', 'agents', 'global.toml'),
      path.join(projectRoot, '.opencode', 'agent', 'foreign.md'),
      path.join(projectRoot, '.opencode', 'skill', 'foreign', 'SKILL.md'),
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'keep\n');
    }
    let receivedProject: string | undefined;
    registerExtensionTarget({
      id: 'extension-agent',
      agents: {
        custom: true,
        distribute: (_entries, _byId, scope) => {
          receivedProject = scope?.project;
          return [];
        },
      },
    });
    const targets = ['codex', 'opencode', 'extension-agent'];
    const outcome = distributeSubagents(
      { project: projectRoot },
      targets,
      new Set(targets),
      managedProjectOptions
    );
    distributeSkills(
      { project: projectRoot },
      {
        activeAppIds: ['opencode'],
        assumeInstalled: new Set(['opencode']),
        ...managedProjectOptions,
      }
    );
    assert.equal(receivedProject, projectRoot);
    assert.ok(outcome.results.every((result) => result.status !== 'error'));
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf-8'), 'keep\n');
  });
});

function createSkill(id: string, body = 'Skill body'): void {
  const skillsDir = ensureSkillsDirectory();
  const skillDir = path.join(skillsDir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\n---\n${body}\n`
  );
}

test('distributeSkills: only distributes to activeAppIds targets', () => {
  withTempHomes(() => {
    simulateAppsInstalled();
    simulateTraeInstalled();
    createSkill('test-skill');
    updateLibraryStateSection('skills', (s) => ({ ...s, enabled: ['test-skill'] }));

    const outcome = distributeSkills(undefined, { activeAppIds: ['claude-code'] });

    const platforms = new Set(outcome.results.map((r) => r.platform));
    assert.ok(platforms.has('claude-code'), 'should include claude-code');
    assert.ok(!platforms.has('cursor'), 'should NOT include cursor');
    assert.ok(!platforms.has('trae'), 'should NOT include trae');
    assert.ok(!platforms.has('codex'), 'should NOT include codex');
  });
});

test('distributeSkills: agents mode respects activeAppIds', () => {
  withTempHomes(() => {
    simulateAppsInstalled();
    simulateTraeInstalled();
    createSkill('test-skill');
    updateLibraryStateSection('skills', (s) => ({ ...s, enabled: ['test-skill'] }));

    const outcome = distributeSkills(undefined, {
      useAgentsDir: true,
      activeAppIds: ['claude-code'],
    });

    const platforms = new Set(outcome.results.map((r) => r.platform));
    assert.ok(platforms.has('claude-code'), 'should include claude-code');
    assert.ok(!platforms.has('agents'), 'should NOT include agents virtual target');
    assert.ok(!platforms.has('trae'), 'should NOT include trae');
    assert.ok(!platforms.has('cursor'), 'should NOT include cursor');
  });
});

test('distributeSkills: agents virtual target included when codex is active', () => {
  withTempHomes(() => {
    simulateAppsInstalled();
    createSkill('test-skill');
    updateLibraryStateSection('skills', (s) => ({ ...s, enabled: ['test-skill'] }));

    const outcome = distributeSkills(undefined, {
      useAgentsDir: true,
      activeAppIds: ['claude-code', 'codex'],
    });

    const platforms = new Set(outcome.results.map((r) => r.platform));
    assert.ok(platforms.has('claude-code'), 'should include claude-code');
    assert.ok(platforms.has('agents'), 'should include agents (codex is active)');
  });
});

test('distributeSkills: empty activeAppIds produces no results', () => {
  withTempHomes(() => {
    createSkill('test-skill');
    updateLibraryStateSection('skills', (s) => ({ ...s, enabled: ['test-skill'] }));

    const outcome = distributeSkills(undefined, { activeAppIds: [] });

    assert.equal(outcome.results.length, 0);
  });
});
