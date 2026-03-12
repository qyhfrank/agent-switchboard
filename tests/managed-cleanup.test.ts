import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { distributeCommands } from '../src/commands/distribution.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import {
  computeLibraryCleanupSet,
  loadManifest,
  recordLibraryEntry,
  saveManifest,
} from '../src/manifest/store.js';
import type { ProjectDistributionManifest } from '../src/manifest/types.js';
import { distributeSkills } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import {
  simulateAppsInstalled,
  simulateTraeInstalled,
  withTempDir,
  withTempHomes,
} from './helpers/tmp.js';

test('managed mode cleanup only removes previously owned entries', () => {
  withTempDir((dir) => {
    const projectRoot = path.join(dir, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    // Set up manifest with two previously owned commands (composite keys)
    const manifest: ProjectDistributionManifest = {
      version: 1,
      updatedAt: '',
      sections: {
        commands: {
          'owned-cmd::test-platform': {
            relativePath: '.test/commands/owned-cmd.md',
            targetId: 'test-platform',
            hash: 'h1',
            updatedAt: '',
          },
          'still-active-cmd::test-platform': {
            relativePath: '.test/commands/still-active-cmd.md',
            targetId: 'test-platform',
            hash: 'h2',
            updatedAt: '',
          },
        },
      },
    };

    // Compute cleanup: only 'still-active-cmd' is still desired
    const toClean = computeLibraryCleanupSet(
      manifest,
      'commands',
      new Set(['still-active-cmd']),
      'test-platform'
    );

    const ids = toClean.map((i) => i.id);
    assert.deepStrictEqual(ids, ['owned-cmd']);
    assert.ok(!ids.includes('still-active-cmd'));
  });
});

test('managed mode cleanup does not touch entries from other targets', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {
      commands: {
        'cmd-for-claude::claude-code': {
          relativePath: 'a',
          targetId: 'claude-code',
          hash: 'h',
          updatedAt: '',
        },
        'cmd-for-cursor::cursor': {
          relativePath: 'b',
          targetId: 'cursor',
          hash: 'h',
          updatedAt: '',
        },
      },
    },
  };

  // Cleanup for claude-code with empty desired set should only return claude-code entries
  const toClean = computeLibraryCleanupSet(manifest, 'commands', new Set(), 'claude-code');
  const ids = toClean.map((i) => i.id);
  assert.deepStrictEqual(ids, ['cmd-for-claude']);
  assert.ok(!ids.includes('cmd-for-cursor'));
});

test('managed mode cleanup returns empty when no manifest section exists', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  const toClean = computeLibraryCleanupSet(manifest, 'skills', new Set());
  assert.deepStrictEqual(toClean, []);
});

test('recordLibraryEntry updates manifest on successful write', () => {
  const manifest: ProjectDistributionManifest = {
    version: 1,
    updatedAt: '',
    sections: {},
  };

  recordLibraryEntry(manifest, 'commands', 'my-cmd', {
    relativePath: '.claude/commands/my-cmd.md',
    targetId: 'claude-code',
    hash: 'sha256-hash',
    updatedAt: '2025-01-01T00:00:00Z',
  });

  assert.ok(manifest.sections.commands);
  assert.equal(Object.keys(manifest.sections.commands).length, 1);
  // Composite key: id::targetId
  assert.equal(manifest.sections.commands['my-cmd::claude-code'].hash, 'sha256-hash');
});

test('manifest-driven cleanup handles transition from no manifest to managed', () => {
  // When there's no prior manifest, cleanup set should be empty (no previously owned items)
  const { manifest: freshManifest } = loadManifest('/nonexistent/path');
  const toClean = computeLibraryCleanupSet(freshManifest, 'commands', new Set(['new-cmd']));
  assert.deepStrictEqual(toClean, []);
});

// ---------------------------------------------------------------------------
// Bootstrap sync: first managed sync adopts pre-existing directories
// ---------------------------------------------------------------------------

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

test('bootstrap sync adopts pre-existing skill directories into manifest', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('skill-a');

    const projectRoot = path.join(agentsHome, 'bootstrap-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: ['skill-a'] }), {
      project: projectRoot,
    });

    // First sync without managed mode: creates skill directory
    distributeSkills({ project: projectRoot });
    const skillDir = path.join(projectRoot, '.claude', 'skills', 'skill-a');
    assert.ok(fs.existsSync(skillDir), 'skill should exist after initial sync');

    // Now run managed sync with empty manifest (simulating first managed sync)
    const { manifest } = loadManifest(projectRoot);
    assert.deepStrictEqual(manifest.sections, {}, 'manifest should start empty');

    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );

    // Skill should be skipped (up-to-date), NOT conflict
    const skillResults = outcome.results.filter(
      (r) => r.platform === 'claude-code' && r.targetDir === skillDir
    );
    assert.ok(
      skillResults.every((r) => r.status !== 'conflict'),
      'bootstrap sync should not report conflict for pre-existing ASB directories'
    );

    // Manifest should now have the skill recorded
    assert.ok(manifest.sections.skills, 'manifest should have skills section');
    const keys = Object.keys(manifest.sections.skills);
    assert.ok(
      keys.some((k) => k.startsWith('skill-a::')),
      'manifest should contain skill-a entry'
    );

    saveManifest(projectRoot, manifest);

    // Second managed sync: manifest is populated, conflict detection is active
    const { manifest: manifest2 } = loadManifest(projectRoot);
    assert.ok(Object.keys(manifest2.sections.skills ?? {}).length > 0);
  });
});

test('managed command sync reports error when collision policy is error', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');

    const commandsDir = path.join(asbHome, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'demo.md'), '---\ndescription: demo\n---\n/demo\n');

    const projectRoot = path.join(agentsHome, 'project-collision-file');
    fs.mkdirSync(path.join(projectRoot, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'commands', 'demo.md'),
      'foreign command\n',
      'utf-8'
    );

    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: ['demo'] }), {
      project: projectRoot,
    });

    const { manifest } = loadManifest(projectRoot);
    recordLibraryEntry(manifest, 'commands', 'existing-managed', {
      relativePath: '.claude/commands/existing-managed.md',
      targetId: 'claude-code',
      hash: 'existing',
      updatedAt: '',
    });
    const outcome = distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
      collision: 'error',
    });
    const result = outcome.results.find((entry) => entry.platform === 'claude-code');

    assert.ok(result);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /foreign file exists/);
  });
});

test('managed skill sync reports error for non-adoptable bootstrap directories', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('skill-collision');

    const projectRoot = path.join(agentsHome, 'project-collision-bundle');
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills', 'skill-collision'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectRoot, '.claude', 'skills', 'skill-collision', 'SKILL.md'),
      'foreign skill\n',
      'utf-8'
    );

    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: ['skill-collision'] }), {
      project: projectRoot,
    });

    const { manifest } = loadManifest(projectRoot);
    const outcome = distributeSkills(
      { project: projectRoot },
      { manifest, projectMode: 'managed', collision: 'error' }
    );
    const result = outcome.results.find(
      (entry) => entry.platform === 'claude-code' && entry.entryId === 'skill-collision'
    );

    assert.ok(result);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /foreign directory exists/);
  });
});

test('managed skill cleanup preserves shared project path owned by another target', () => {
  withTempHomes(({ agentsHome }) => {
    simulateTraeInstalled();
    createSkill('shared-skill');

    const projectRoot = path.join(agentsHome, 'project-shared-trae');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["trae", "trae-cn"]',
        '',
        '[skills]',
        'enabled = ["shared-skill"]',
      ].join('\n'),
      'utf-8'
    );

    const { manifest } = loadManifest(projectRoot);
    distributeSkills(
      { project: projectRoot },
      { manifest, projectMode: 'managed', collision: 'warn-skip' }
    );

    fs.writeFileSync(
      path.join(projectRoot, '.asb.toml'),
      [
        '[applications]',
        'enabled = ["trae", "trae-cn"]',
        '',
        '[skills]',
        'enabled = ["shared-skill"]',
        '',
        '[applications.trae-cn.skills]',
        'enabled = []',
      ].join('\n'),
      'utf-8'
    );

    const outcome = distributeSkills(
      { project: projectRoot },
      { manifest, projectMode: 'managed', collision: 'warn-skip' }
    );
    const targetDir = path.join(projectRoot, '.trae', 'skills', 'shared-skill');
    const skipResult = outcome.results.find(
      (entry) =>
        entry.platform === 'trae-cn' &&
        entry.entryId === 'shared-skill' &&
        entry.status === 'skipped'
    );

    assert.ok(fs.existsSync(targetDir), 'shared skill directory should remain for trae');
    assert.ok(skipResult, 'trae-cn cleanup should skip deleting a shared path still owned by trae');
  });
});
