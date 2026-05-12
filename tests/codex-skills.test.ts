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

test('distributeSkills: executable mode drift is repaired without content changes', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-drift-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeSkills();
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeSkills: executable mode drift is visible in dryRun without chmod', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-drift-dryrun-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    fs.chmodSync(targetScript, 0o644);

    const outcome = distributeSkills(undefined, { dryRun: true });
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeSkills: executable mode removal is repaired without content changes', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-removal-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    fs.chmodSync(scriptPath, 0o644);

    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    const outcome = distributeSkills();
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeSkills: executable mode removal is visible in dryRun without chmod', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-removal-dryrun-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    fs.chmodSync(scriptPath, 0o644);

    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    const outcome = distributeSkills(undefined, { dryRun: true });
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeSkills: executable mode repair reports chmod failure as error', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-chmod-failure-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    fs.chmodSync(targetScript, 0o644);

    const originalChmodSync = fs.chmodSync;
    try {
      fs.chmodSync = ((filePath, mode) => {
        if (filePath === targetScript) {
          throw new Error('chmod denied');
        }
        return originalChmodSync(filePath, mode);
      }) as typeof fs.chmodSync;

      const outcome = distributeSkills();
      const result = outcome.results.find(
        (r) => r.platform === 'claude-code' && r.targetDir === targetDir
      );

      assert.equal(fs.statSync(targetScript).mode & 0o111, 0);
      assert.equal(result?.status, 'error');
      assert.match(result?.error ?? '', /chmod denied/);
    } finally {
      fs.chmodSync = originalChmodSync;
    }
  });
});

test('distributeSkills: executable mode repair replaces target symlink without touching target', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-symlink-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    const outsideTarget = path.join(agentsHome, 'outside.sh');
    fs.writeFileSync(outsideTarget, '#!/bin/sh\necho ok\n');
    fs.chmodSync(outsideTarget, 0o644);
    fs.unlinkSync(targetScript);
    fs.symlinkSync(outsideTarget, targetScript);

    const outcome = distributeSkills();
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.lstatSync(targetScript).isSymbolicLink(), false);
    assert.equal(fs.statSync(outsideTarget).mode & 0o111, 0);
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
  });
});

test('distributeSkills: executable mode repair replaces dangling target symlink', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-dangling-symlink-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    distributeSkills();
    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    const outsideTarget = path.join(agentsHome, 'missing-outside.sh');
    fs.unlinkSync(targetScript);
    fs.symlinkSync(outsideTarget, targetScript);

    const outcome = distributeSkills();
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.lstatSync(targetScript).isSymbolicLink(), false);
    assert.equal(fs.existsSync(outsideTarget), false);
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
  });
});

test('distributeSkills: executable mode repair replaces target directory symlink', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'mode-dir-symlink-skill';
    const skillDir = createSkill(agentsHome, skillId);
    const scriptPath = path.join(skillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const targetDir = path.join(agentsHome, '.claude', 'skills', skillId);
    const outsideDir = path.join(agentsHome, 'outside-skill-dir');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, targetDir);

    const outcome = distributeSkills();
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');

    assert.equal(fs.lstatSync(targetDir).isSymbolicLink(), false);
    assert.equal(fs.existsSync(path.join(outsideDir, 'scripts', 'run.sh')), false);
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
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

test('distributeSkills: useAgentsDir leaves non-empty legacy Gemini skills directory in place', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const skillId = 'shared-skill';
    createSkill(agentsHome, skillId);

    const legacySkillDir = path.join(agentsHome, '.gemini', 'skills', 'user-owned');
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(path.join(legacySkillDir, 'keep.txt'), 'keep\n', 'utf-8');

    updateLibraryStateSection('skills', (s) => ({
      ...s,
      enabled: [skillId],
    }));

    const outcome = distributeSkills(undefined, { useAgentsDir: true, activeAppIds: ['codex'] });

    assert.equal(
      fs.existsSync(path.join(agentsHome, '.gemini', 'skills', 'user-owned', 'keep.txt')),
      true,
      'non-empty legacy skills directory should be preserved'
    );
    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'agents' &&
          result.targetDir === path.join(agentsHome, '.gemini', 'skills') &&
          result.status === 'skipped'
      ),
      'legacy path should be reported as left in place'
    );
  });
});
