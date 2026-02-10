import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  getCodexSkillsDir,
  getProjectCodexSkillsDir,
} from '../src/config/paths.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import {
  distributeSkills,
  resolveSkillTargetDir,
} from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { withTempHomes } from './helpers/tmp.js';

/**
 * Helper: create a minimal valid skill in the ASB library directory.
 * Returns the skill directory path.
 */
function createSkill(asbHome: string, id: string, body = 'Skill body'): string {
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

test('resolveSkillTargetDir: codex user scope targets ~/.agents/skills/<id>', () => {
  withTempHomes(({ agentsHome }) => {
    const target = resolveSkillTargetDir('codex', 'my-skill');
    assert.equal(target, path.join(agentsHome, '.agents', 'skills', 'my-skill'));
  });
});

test('resolveSkillTargetDir: codex project scope targets <project>/.agents/skills/<id>', () => {
  withTempHomes(() => {
    const projectRoot = '/tmp/my-project';
    const target = resolveSkillTargetDir('codex', 'my-skill', { project: projectRoot });
    assert.equal(target, path.join(projectRoot, '.agents', 'skills', 'my-skill'));
  });
});

// ---------------------------------------------------------------------------
// Skills distribution writes to ~/.agents/skills/ for codex
// ---------------------------------------------------------------------------

test('distributeSkills: codex skills land in ~/.agents/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'test-skill';
    createSkill(agentsHome, skillId);

    // Activate the skill
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    const outcome = distributeSkills();

    // Find codex results
    const codexResults = outcome.results.filter(
      (r) => r.platform === 'codex' && r.status === 'written'
    );
    assert.ok(codexResults.length > 0, 'should have written codex skill');

    // Verify the target directory is under ~/.agents/skills/
    const expectedDir = path.join(agentsHome, '.agents', 'skills', skillId);
    assert.ok(
      codexResults.some((r) => r.targetDir === expectedDir),
      `codex skill should be at ${expectedDir}, got: ${codexResults.map((r) => r.targetDir).join(', ')}`
    );

    // Verify SKILL.md was actually written
    const skillMd = path.join(expectedDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md should exist in codex target');
    const content = fs.readFileSync(skillMd, 'utf-8');
    assert.match(content, /name: test-skill/);
  });
});

test('distributeSkills: codex skills NOT written to ~/.codex/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'check-path';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    distributeSkills();

    // The old path should NOT have the skill
    const oldPath = path.join(agentsHome, '.codex', 'skills', skillId, 'SKILL.md');
    assert.ok(!fs.existsSync(oldPath), `skill should NOT be at old path ${oldPath}`);
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: second run is skipped (up-to-date)
// ---------------------------------------------------------------------------

test('distributeSkills: second run skips up-to-date codex skills', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'idempotent-skill';
    createSkill(agentsHome, skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));

    // First run
    const outcome1 = distributeSkills();
    const codexWritten = outcome1.results.filter(
      (r) => r.platform === 'codex' && r.status === 'written'
    );
    assert.ok(codexWritten.length > 0);

    // Second run
    const outcome2 = distributeSkills();
    const codexSkipped = outcome2.results.filter(
      (r) => r.platform === 'codex' && r.status === 'skipped'
    );
    assert.ok(codexSkipped.length > 0, 'second run should skip codex skills');
    const codexWritten2 = outcome2.results.filter(
      (r) => r.platform === 'codex' && r.status === 'written'
    );
    assert.equal(codexWritten2.length, 0, 'second run should not write codex skills');
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: project scope
// ---------------------------------------------------------------------------

test('distributeSkills: project scope writes codex skills to <project>/.agents/skills/', () => {
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

    const outcome = distributeSkills({ project: projectRoot });

    // Find codex results
    const codexResults = outcome.results.filter(
      (r) => r.platform === 'codex' && (r.status === 'written' || r.status === 'skipped')
    );
    assert.ok(codexResults.length > 0, 'should have codex results');

    // Verify the target is under project/.agents/skills/
    const expectedDir = path.join(projectRoot, '.agents', 'skills', skillId);
    assert.ok(
      codexResults.some((r) => r.targetDir === expectedDir),
      `codex skill should be at ${expectedDir}`
    );

    // Verify file exists
    const skillMd = path.join(expectedDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md should exist in project codex target');
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: all 4 platforms receive skills
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
      outcome.results
        .filter((r) => r.status === 'written')
        .map((r) => r.platform)
    );

    for (const p of ['claude-code', 'codex', 'gemini', 'opencode'] as const) {
      assert.ok(platforms.has(p), `platform ${p} should have received skill`);
    }
  });
});

// ---------------------------------------------------------------------------
// Skills distribution: deactivated skill is cleaned up (orphan removal)
// ---------------------------------------------------------------------------

test('distributeSkills: deactivated skill directory is removed', () => {
  withTempHomes(({ agentsHome }) => {
    const skillId = 'ephemeral';
    createSkill(agentsHome, skillId);

    // Activate and distribute
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [skillId],
    }));
    distributeSkills();

    const codexTarget = path.join(agentsHome, '.agents', 'skills', skillId);
    assert.ok(fs.existsSync(codexTarget), 'skill should exist after first distribution');

    // Deactivate
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      active: [],
    }));
    const outcome = distributeSkills();

    // Should have a 'deleted' result for codex
    const deleted = outcome.results.filter(
      (r) => r.platform === 'codex' && r.status === 'deleted'
    );
    assert.ok(deleted.length > 0, 'should have deleted orphan codex skill');
    assert.ok(!fs.existsSync(codexTarget), 'orphan skill directory should be removed');
  });
});
