import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getCodexSkillsDir, getProjectCodexSkillsDir } from '../src/config/paths.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { distributeSkills, resolveSkillTargetDir } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { withTempHomes } from './helpers/tmp.js';

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
    const skillId = 'test-skill';
    createSkill(agentsHome, skillId);

    // Activate the skill
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
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
    const skillId = 'check-path';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
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
    const skillId = 'idempotent-skill';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
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
    const skillId = 'proj-skill';
    createSkill(agentsHome, skillId);

    // Create a temporary project directory
    const projectRoot = path.join(agentsHome, 'my-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

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

// ---------------------------------------------------------------------------
// Skills distribution: all 5 platforms receive skills (cursor deduped when claude-code is active)
// ---------------------------------------------------------------------------

test('distributeSkills: all platforms receive skills', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'multi-platform';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    const outcome = distributeSkills();

    const platforms = new Set(
      outcome.results.filter((r) => r.status === 'written').map((r) => r.platform)
    );

    for (const p of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      assert.ok(platforms.has(p), `platform ${p} should have received skill`);
    }
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: deactivated skill is cleaned up (orphan removal)
// ---------------------------------------------------------------------------

test('distributeSkills: agents mode removes deactivated skill directory', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'ephemeral';
    createSkill(agentsHome, skillId);

    // Activate and distribute
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));
    distributeSkills(undefined, { useAgentsDir: true });

    const agentsTarget = path.join(agentsHome, '.agents', 'skills', skillId);
    assert.ok(fs.existsSync(agentsTarget), 'skill should exist after first distribution');

    // Deactivate
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [],
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
