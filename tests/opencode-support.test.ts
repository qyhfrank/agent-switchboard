import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { distributeCommands, resolveCommandFilePath } from '../src/commands/distribution.js';
import { ensureCommandsDirectory } from '../src/commands/library.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { distributeSkills, resolveSkillTargetDir } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { distributeSubagents, resolveSubagentFilePath } from '../src/subagents/distribution.js';
import { ensureAgentsDirectory } from '../src/subagents/library.js';
import { simulateAppsInstalled, withTempHomes } from './helpers/tmp.js';

function createSkill(id: string, body = 'Skill body'): string {
  const skillsDir = ensureSkillsDirectory();
  const skillDir = path.join(skillsDir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\n---\n${body}\n`
  );
  return skillDir;
}

test('opencode distribution uses documented plural directories', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('opencode');

    const commandId = 'explain';
    const agentId = 'reviewer';
    const skillId = 'test-skill';

    fs.writeFileSync(
      path.join(ensureCommandsDirectory(), `${commandId}.md`),
      '---\ndescription: Explain code\n---\nExplain the selected code.\n'
    );
    fs.writeFileSync(
      path.join(ensureAgentsDirectory(), `${agentId}.md`),
      '---\ndescription: Review code\n---\nReview the implementation.\n'
    );
    createSkill(skillId);

    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: [commandId] }));
    updateLibraryStateSection('agents', (state) => ({ ...state, enabled: [agentId] }));
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [skillId] }));

    distributeCommands();
    distributeSubagents();
    distributeSkills(undefined, { activeAppIds: ['opencode'] });

    const commandPath = resolveCommandFilePath('opencode', commandId);
    const agentPath = resolveSubagentFilePath('opencode', agentId);
    const skillPath = resolveSkillTargetDir('opencode', skillId);

    assert.equal(
      commandPath,
      path.join(agentsHome, '.config', 'opencode', 'commands', 'explain.md')
    );
    assert.equal(agentPath, path.join(agentsHome, '.config', 'opencode', 'agents', 'reviewer.md'));
    assert.equal(skillPath, path.join(agentsHome, '.config', 'opencode', 'skills', skillId));

    assert.equal(
      fs.existsSync(commandPath),
      true,
      'opencode command should be written to commands/'
    );
    assert.equal(fs.existsSync(agentPath), true, 'opencode agent should be written to agents/');
    assert.equal(
      fs.existsSync(path.join(skillPath, 'SKILL.md')),
      true,
      'opencode skill should be written to skills/'
    );
  });
});

test('opencode agent output omits generic top-level model passthrough', () => {
  withTempHomes(() => {
    simulateAppsInstalled('opencode');
    const agentId = 'no-invalid-model';

    fs.writeFileSync(
      path.join(ensureAgentsDirectory(), `${agentId}.md`),
      [
        '---',
        'description: Review code',
        'model: inherit',
        'extras:',
        '  opencode:',
        '    temperature: 0.1',
        '---',
        'Review the implementation.',
        '',
      ].join('\n')
    );

    updateLibraryStateSection('agents', (state) => ({ ...state, enabled: [agentId] }));
    distributeSubagents();

    const content = fs.readFileSync(resolveSubagentFilePath('opencode', agentId), 'utf-8');
    assert.doesNotMatch(content, /^model:/m);
    assert.match(content, /^temperature: 0.1$/m);
  });
});

test('opencode agent output preserves extras.opencode.model', () => {
  withTempHomes(() => {
    simulateAppsInstalled('opencode');
    const agentId = 'with-opencode-model';

    fs.writeFileSync(
      path.join(ensureAgentsDirectory(), `${agentId}.md`),
      [
        '---',
        'description: Review code',
        'model: inherit',
        'extras:',
        '  opencode:',
        '    model: aiohub-openai/gpt-5.4',
        '---',
        'Review the implementation.',
        '',
      ].join('\n')
    );

    updateLibraryStateSection('agents', (state) => ({ ...state, enabled: [agentId] }));
    distributeSubagents();

    const content = fs.readFileSync(resolveSubagentFilePath('opencode', agentId), 'utf-8');
    assert.match(content, /^model: aiohub-openai\/gpt-5.4$/m);
  });
});

test('opencode distribution cleans legacy singular agent path duplicates', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('opencode');
    const agentId = 'legacy-reviewer';

    fs.mkdirSync(path.join(agentsHome, '.config', 'opencode', 'agent'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsHome, '.config', 'opencode', 'agent', `${agentId}.md`),
      '---\ndescription: Legacy review agent\nmodel: inherit\n---\nLegacy prompt.\n'
    );

    fs.writeFileSync(
      path.join(ensureAgentsDirectory(), `${agentId}.md`),
      '---\ndescription: Review code\n---\nReview the implementation.\n'
    );

    updateLibraryStateSection('agents', (state) => ({ ...state, enabled: [agentId] }));
    distributeSubagents();

    assert.equal(
      fs.existsSync(path.join(agentsHome, '.config', 'opencode', 'agent', `${agentId}.md`)),
      false,
      'legacy duplicate under agent/ should be removed'
    );
    assert.equal(
      fs.existsSync(path.join(agentsHome, '.config', 'opencode', 'agents', `${agentId}.md`)),
      true,
      'current copy under agents/ should exist'
    );
  });
});
