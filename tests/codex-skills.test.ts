import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getCodexSkillsDir, getProjectCodexSkillsDir } from '../src/config/paths.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { distributeSkills, resolveSkillTargetDir } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { simulateAppsInstalled, simulateTraeInstalled, withTempHomes } from './helpers/tmp.js';

/**
 * Helper: create a minimal valid skill in the ASB library directory.
 * Returns the skill directory path.
 */
function createSkill(_asbHome: string, id: string, body = 'Skill body'): string {
  const skillsDir = ensureSkillsDirectory();
  const skillDir = path.join(skillsDir, id);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\n---\n${body}\n`
  );
  return skillDir;
}

// ---------------------------------------------------------------------------
// Codex skills path resolution
// ---------------------------------------------------------------------------

test('getCodexSkillsDir resolves to ~/.agents/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    const dir = getCodexSkillsDir();
    assert.equal(dir, path.join(agentsHome, '.agents', 'skills'));
  });
});

test('getProjectCodexSkillsDir resolves to <project>/.agents/skills/', () => {
  withTempHomes(() => {
    const projectRoot = '/tmp/my-project';
    const dir = getProjectCodexSkillsDir(projectRoot);
    assert.equal(dir, path.join(projectRoot, '.agents', 'skills'));
  });
});

// ---------------------------------------------------------------------------
// resolveSkillTargetDir for codex platform
// ---------------------------------------------------------------------------

test('resolveSkillTargetDir: agents target resolves to ~/.agents/skills/<id>', () => {
  withTempHomes(({ agentsHome }) => {
    const target = resolveSkillTargetDir('agents', 'my-skill');
    assert.equal(target, path.join(agentsHome, '.agents', 'skills', 'my-skill'));
  });
});

test('resolveSkillTargetDir: agents target project scope resolves to <project>/.agents/skills/<id>', () => {
  withTempHomes(() => {
    const projectRoot = '/tmp/my-project';
    const target = resolveSkillTargetDir('agents', 'my-skill', { project: projectRoot });
    assert.equal(target, path.join(projectRoot, '.agents', 'skills', 'my-skill'));
  });
});

// ---------------------------------------------------------------------------
// Skills distribution writes to ~/.agents/skills/ for codex
// ---------------------------------------------------------------------------

test('distributeSkills: agents mode writes skills to ~/.agents/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    const skillId = 'test-skill';
    createSkill(agentsHome, skillId);

    // Activate the skill
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills(undefined, { useAgentsDir: true });

    // Find agents results
    const agentsResults = outcome.results.filter(
      (r) => r.platform === 'agents' && r.status === 'written'
    );
    assert.ok(agentsResults.length > 0, 'should have written agents skill');

    // Verify the target directory is under ~/.agents/skills/
    const expectedDir = path.join(agentsHome, '.agents', 'skills', skillId);
    assert.ok(
      agentsResults.some((r) => r.targetDir === expectedDir),
      `agents skill should be at ${expectedDir}, got: ${agentsResults.map((r) => r.targetDir).join(', ')}`
    );

    // Verify SKILL.md was actually written
    const skillMd = path.join(expectedDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md should exist in agents target');
    const content = fs.readFileSync(skillMd, 'utf-8');
    assert.match(content, /name: test-skill/);
  });
});

test('distributeSkills: agents mode does NOT write to ~/.codex/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    const skillId = 'check-path';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills(undefined, { useAgentsDir: true });

    // The old path should NOT have the skill
    const oldPath = path.join(agentsHome, '.codex', 'skills', skillId, 'SKILL.md');
    assert.ok(!fs.existsSync(oldPath), `skill should NOT be at old path ${oldPath}`);
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: second run is skipped (up-to-date)
// ---------------------------------------------------------------------------

test('distributeSkills: second run skips up-to-date agents skills', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    const skillId = 'idempotent-skill';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    // First run
    const outcome1 = distributeSkills(undefined, { useAgentsDir: true });
    const agentsWritten = outcome1.results.filter(
      (r) => r.platform === 'agents' && r.status === 'written'
    );
    assert.ok(agentsWritten.length > 0);

    // Second run
    const outcome2 = distributeSkills(undefined, { useAgentsDir: true });
    const agentsSkipped = outcome2.results.filter(
      (r) => r.platform === 'agents' && r.status === 'skipped'
    );
    assert.ok(agentsSkipped.length > 0, 'second run should skip agents skills');
    const agentsWritten2 = outcome2.results.filter(
      (r) => r.platform === 'agents' && r.status === 'written'
    );
    assert.equal(agentsWritten2.length, 0, 'second run should not write agents skills');
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: project scope
// ---------------------------------------------------------------------------

test('distributeSkills: agents mode project scope writes to <project>/.agents/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    const skillId = 'proj-skill';
    createSkill(agentsHome, skillId);

    // Create a temporary project directory
    const projectRoot = path.join(agentsHome, 'my-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection(
      'skills',
      (s) => ({
        ...s,
        enabled: [skillId],
      }),
      { project: projectRoot }
    );

    const outcome = distributeSkills({ project: projectRoot }, { useAgentsDir: true });

    // Find agents results
    const agentsResults = outcome.results.filter(
      (r) => r.platform === 'agents' && (r.status === 'written' || r.status === 'skipped')
    );
    assert.ok(agentsResults.length > 0, 'should have agents results');

    // Verify the target is under project/.agents/skills/
    const expectedDir = path.join(projectRoot, '.agents', 'skills', skillId);
    assert.ok(
      agentsResults.some((r) => r.targetDir === expectedDir),
      `agents skill should be at ${expectedDir}`
    );

    // Verify file exists
    const skillMd = path.join(expectedDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md should exist in project agents target');
  });
});

test('distributeSkills: project scope removes orphan claude-code skill directories', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill(agentsHome, 'old-skill');
    createSkill(agentsHome, 'new-skill');

    const projectRoot = path.join(agentsHome, 'claude-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection(
      'skills',
      (state) => ({
        ...state,
        enabled: ['old-skill'],
      }),
      { project: projectRoot }
    );
    distributeSkills({ project: projectRoot });

    const oldTarget = path.join(projectRoot, '.claude', 'skills', 'old-skill');
    assert.ok(fs.existsSync(oldTarget), 'old project skill should exist after first distribution');

    updateLibraryStateSection(
      'skills',
      (state) => ({
        ...state,
        enabled: ['new-skill'],
      }),
      { project: projectRoot }
    );
    const outcome = distributeSkills({ project: projectRoot });

    const deleted = outcome.results.filter(
      (result) => result.platform === 'claude-code' && result.status === 'deleted'
    );
    assert.ok(deleted.some((result) => result.targetDir === oldTarget));
    assert.ok(!fs.existsSync(oldTarget), 'orphan project skill should be removed');
  });
});

test('distributeSkills: project scope ignores inherited user-level skills', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill(agentsHome, 'user-skill');
    createSkill(agentsHome, 'project-skill');

    const projectRoot = path.join(agentsHome, 'scoped-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection('skills', (state) => ({
      ...state,
      enabled: ['user-skill'],
    }));
    updateLibraryStateSection(
      'skills',
      (state) => ({
        ...state,
        enabled: ['project-skill'],
      }),
      { project: projectRoot }
    );

    const outcome = distributeSkills({ project: projectRoot });
    const projectSkillTarget = path.join(projectRoot, '.claude', 'skills', 'project-skill');
    const inheritedSkillTarget = path.join(projectRoot, '.claude', 'skills', 'user-skill');

    assert.ok(fs.existsSync(projectSkillTarget), 'project skill should be written');
    assert.equal(
      fs.existsSync(inheritedSkillTarget),
      false,
      'inherited user skill should not be written'
    );
    assert.ok(
      outcome.results.some(
        (result) => result.platform === 'claude-code' && result.targetDir === projectSkillTarget
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: all 5 platforms receive skills (cursor deduped when claude-code is active)
// ---------------------------------------------------------------------------

test('distributeSkills: all platforms receive skills', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    simulateTraeInstalled();
    const skillId = 'multi-platform';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills();

    const platforms = new Set(
      outcome.results.filter((r) => r.status === 'written').map((r) => r.platform)
    );

    for (const p of ['claude-code', 'codex', 'gemini', 'opencode', 'trae', 'trae-cn'] as const) {
      assert.ok(platforms.has(p), `platform ${p} should have received skill`);
    }
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: deactivated skill is cleaned up (orphan removal)
// ---------------------------------------------------------------------------

test('distributeSkills: agents mode removes deactivated skill directory', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled();
    const skillId = 'ephemeral';
    createSkill(agentsHome, skillId);

    // Activate and distribute
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));
    distributeSkills(undefined, { useAgentsDir: true });

    const agentsTarget = path.join(agentsHome, '.agents', 'skills', skillId);
    assert.ok(fs.existsSync(agentsTarget), 'skill should exist after first distribution');

    // Deactivate
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [],
    }));
    const outcome = distributeSkills(undefined, { useAgentsDir: true });

    // Should have a 'deleted' result for agents
    const deleted = outcome.results.filter(
      (r) => r.platform === 'agents' && r.status === 'deleted'
    );
    assert.ok(deleted.length > 0, 'should have deleted orphan agents skill');
    assert.ok(!fs.existsSync(agentsTarget), 'orphan skill directory should be removed');
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: useAgentsDir respects filterInstalled for claude-code
// ---------------------------------------------------------------------------

test('distributeSkills: useAgentsDir does not write to claude-code when it is not installed', () => {
  withTempHomes(({ agentsHome }) => {
    // Only install codex, NOT claude-code
    simulateAppsInstalled('codex');
    const skillId = 'no-claude';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills(undefined, { useAgentsDir: true });

    // Should have agents results but NO claude-code results
    const claudeResults = outcome.results.filter((r) => r.platform === 'claude-code');
    assert.equal(
      claudeResults.length,
      0,
      'should not write to claude-code when it is not installed'
    );

    const agentsResults = outcome.results.filter(
      (r) => r.platform === 'agents' && (r.status === 'written' || r.status === 'skipped')
    );
    assert.ok(agentsResults.length > 0, 'should still write to agents platform');
  });
});
