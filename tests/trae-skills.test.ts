import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getProjectTraeDir, getTraeDataDir } from '../src/config/paths.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { distributeSkills, resolveSkillTargetDir } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { getTargetsForSection } from '../src/targets/registry.js';
import { simulateTraeInstalled, withTempHomes } from './helpers/tmp.js';

/**
 * Helper: create a minimal valid skill in the ASB library directory.
 */
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

// ---------------------------------------------------------------------------
// Target registry includes trae variants for skills
// ---------------------------------------------------------------------------

test('skills targets include trae and trae-cn', () => {
  const ids = getTargetsForSection('skills').map((t) => t.id);
  assert.ok(ids.includes('trae'), 'trae should support skills');
  assert.ok(ids.includes('trae-cn'), 'trae-cn should support skills');
});

// ---------------------------------------------------------------------------
// resolveSkillTargetDir for trae variants (global scope)
// ---------------------------------------------------------------------------
test('resolveSkillTargetDir: trae global resolves to ~/.trae/skills/<id>', () => {
  withTempHomes(({ agentsHome }) => {
    const target = resolveSkillTargetDir('trae', 'my-skill');
    const expected = path.join(agentsHome, '.trae', 'skills', 'my-skill');
    assert.equal(target, expected);
  });
});

test('resolveSkillTargetDir: trae-cn global resolves to ~/.trae-cn/skills/<id>', () => {
  withTempHomes(({ agentsHome }) => {
    const target = resolveSkillTargetDir('trae-cn', 'my-skill');
    const expected = path.join(agentsHome, '.trae-cn', 'skills', 'my-skill');
    assert.equal(target, expected);
  });
});

// ---------------------------------------------------------------------------
// resolveSkillTargetDir for trae variants (project scope)
// ---------------------------------------------------------------------------

test('resolveSkillTargetDir: trae project scope resolves to <project>/.trae/skills/<id>', () => {
  withTempHomes(() => {
    const projectRoot = '/tmp/my-project';
    const target = resolveSkillTargetDir('trae', 'my-skill', { project: projectRoot });
    assert.equal(target, path.join(projectRoot, '.trae', 'skills', 'my-skill'));
  });
});

test('resolveSkillTargetDir: trae-cn project scope resolves to <project>/.trae/skills/<id>', () => {
  withTempHomes(() => {
    const projectRoot = '/tmp/my-project';
    const target = resolveSkillTargetDir('trae-cn', 'my-skill', { project: projectRoot });
    assert.equal(target, path.join(projectRoot, '.trae', 'skills', 'my-skill'));
  });
});

// ---------------------------------------------------------------------------
// Path helpers: getTraeDataDir / getProjectTraeDir
// ---------------------------------------------------------------------------

test('getTraeDataDir returns ~/.trae for trae variant', () => {
  withTempHomes(({ agentsHome }) => {
    assert.equal(getTraeDataDir('trae'), path.join(agentsHome, '.trae'));
  });
});

test('getTraeDataDir returns ~/.trae-cn for trae-cn variant', () => {
  withTempHomes(({ agentsHome }) => {
    assert.equal(getTraeDataDir('trae-cn'), path.join(agentsHome, '.trae-cn'));
  });
});

test('getProjectTraeDir returns <project>/.trae', () => {
  const dir = getProjectTraeDir('/tmp/proj');
  assert.equal(dir, path.join('/tmp/proj', '.trae'));
});

// ---------------------------------------------------------------------------
// distributeSkills: trae receives skills in legacy mode
// ---------------------------------------------------------------------------

test('distributeSkills: trae platforms receive skills in legacy mode', () => {
  withTempHomes(() => {
    simulateTraeInstalled();
    const skillId = 'trae-test-skill';
    createSkill(skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills();

    const platforms = new Set(
      outcome.results.filter((r) => r.status === 'written').map((r) => r.platform)
    );

    assert.ok(platforms.has('trae'), 'trae should have received skill');
    assert.ok(platforms.has('trae-cn'), 'trae-cn should have received skill');
  });
});

// ---------------------------------------------------------------------------
// distributeSkills: trae receives skills in agents mode
// ---------------------------------------------------------------------------

test('distributeSkills: trae platforms receive skills in agents mode', () => {
  withTempHomes(() => {
    simulateTraeInstalled();
    const skillId = 'trae-agents-skill';
    createSkill(skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills(undefined, { useAgentsDir: true });

    const platforms = new Set(
      outcome.results.filter((r) => r.status === 'written').map((r) => r.platform)
    );

    assert.ok(platforms.has('trae'), 'trae should have received skill in agents mode');
    assert.ok(platforms.has('trae-cn'), 'trae-cn should have received skill in agents mode');
  });
});

// ---------------------------------------------------------------------------
// distributeSkills: SKILL.md content is correct in trae target
// ---------------------------------------------------------------------------

test('distributeSkills: writes SKILL.md to trae target directory', () => {
  withTempHomes(({ agentsHome }) => {
    simulateTraeInstalled();
    const skillId = 'trae-content-check';
    createSkill(skillId, 'Trae skill content');

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();

    const traeSkillMd = path.join(agentsHome, '.trae', 'skills', skillId, 'SKILL.md');
    assert.ok(fs.existsSync(traeSkillMd), 'SKILL.md should exist in trae target');
    const content = fs.readFileSync(traeSkillMd, 'utf-8');
    assert.match(content, /name: trae-content-check/);
    assert.match(content, /Trae skill content/);

    const traeCnSkillMd = path.join(agentsHome, '.trae-cn', 'skills', skillId, 'SKILL.md');
    assert.ok(fs.existsSync(traeCnSkillMd), 'SKILL.md should exist in trae-cn target');
  });
});

// ---------------------------------------------------------------------------
// distributeSkills: second run skips up-to-date trae skills
// ---------------------------------------------------------------------------

test('distributeSkills: second run skips up-to-date trae skills', () => {
  withTempHomes(() => {
    simulateTraeInstalled();
    const skillId = 'trae-idempotent';
    createSkill(skillId);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    // First run
    const outcome1 = distributeSkills();
    const traeWritten = outcome1.results.filter(
      (r) => r.platform === 'trae' && r.status === 'written'
    );
    assert.ok(traeWritten.length > 0, 'first run should write trae skill');

    // Second run
    const outcome2 = distributeSkills();
    const traeSkipped = outcome2.results.filter(
      (r) => r.platform === 'trae' && r.status === 'skipped'
    );
    assert.ok(traeSkipped.length > 0, 'second run should skip trae skill');
    const traeWritten2 = outcome2.results.filter(
      (r) => r.platform === 'trae' && r.status === 'written'
    );
    assert.equal(traeWritten2.length, 0, 'second run should not re-write trae skill');
  });
});

// ---------------------------------------------------------------------------
// distributeSkills: deactivated skill is cleaned up from trae
// ---------------------------------------------------------------------------

test('distributeSkills: removes deactivated skill from trae directories', () => {
  withTempHomes(({ agentsHome }) => {
    simulateTraeInstalled();
    const skillId = 'trae-ephemeral';
    createSkill(skillId);

    // Activate and distribute
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));
    distributeSkills();

    const traeTarget = path.join(agentsHome, '.trae', 'skills', skillId);
    assert.ok(fs.existsSync(traeTarget), 'trae skill should exist after first distribution');

    // Deactivate
    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [],
    }));
    const outcome = distributeSkills();

    const deleted = outcome.results.filter((r) => r.platform === 'trae' && r.status === 'deleted');
    assert.ok(deleted.length > 0, 'should have deleted orphan trae skill');
    assert.ok(!fs.existsSync(traeTarget), 'orphan trae skill directory should be removed');
  });
});

// ---------------------------------------------------------------------------
// distributeSkills: project scope writes to <project>/.trae/skills/
// ---------------------------------------------------------------------------

test('distributeSkills: project scope writes to <project>/.trae/skills/', () => {
  withTempHomes(({ agentsHome }) => {
    simulateTraeInstalled();
    const skillId = 'trae-proj-skill';
    createSkill(skillId);

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

    const outcome = distributeSkills({ project: projectRoot });

    // Both trae and trae-cn share the same project dir (.trae)
    const traeResults = outcome.results.filter(
      (r) => r.platform === 'trae' && (r.status === 'written' || r.status === 'skipped')
    );
    assert.ok(traeResults.length > 0, 'should have trae results for project scope');

    const expectedDir = path.join(projectRoot, '.trae', 'skills', skillId);
    assert.ok(
      traeResults.some((r) => r.targetDir === expectedDir),
      `trae skill should be at ${expectedDir}`
    );

    const skillMd = path.join(expectedDir, 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'SKILL.md should exist in project trae target');
  });
});
