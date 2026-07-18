import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { distributeCommands } from '../src/commands/distribution.js';
import { loadLibraryAgentSync, updateLibraryStateSection } from '../src/library/state.js';
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
  assert.equal(manifest.sections.commands['my-cmd::claude-code'].hash, 'sha256-hash');
});

test('manifest-driven cleanup handles transition from no manifest to managed', () => {
  const { manifest: freshManifest } = loadManifest('/nonexistent/path');
  const toClean = computeLibraryCleanupSet(freshManifest, 'commands', new Set(['new-cmd']));
  assert.deepStrictEqual(toClean, []);
});

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

    distributeSkills({ project: projectRoot });
    const skillDir = path.join(projectRoot, '.claude', 'skills', 'skill-a');
    assert.ok(fs.existsSync(skillDir), 'skill should exist after initial sync');

    const { manifest } = loadManifest(projectRoot);
    assert.deepStrictEqual(manifest.sections, {}, 'manifest should start empty');

    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );

    const skillResults = outcome.results.filter(
      (r) => r.platform === 'claude-code' && r.targetDir === skillDir
    );
    assert.ok(
      skillResults.every((r) => r.status !== 'conflict'),
      'bootstrap sync should not report conflict for pre-existing ASB directories'
    );

    assert.ok(manifest.sections.skills, 'manifest should have skills section');
    const keys = Object.keys(manifest.sections.skills);
    assert.ok(
      keys.some((k) => k.startsWith('skill-a::')),
      'manifest should contain skill-a entry'
    );

    saveManifest(projectRoot, manifest);

    const { manifest: manifest2 } = loadManifest(projectRoot);
    assert.ok(Object.keys(manifest2.sections.skills ?? {}).length > 0);
  });
});

test('bootstrap sync repairs executable mode drift while adopting skill directories', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'skill-mode-drift';
    const sourceSkillDir = createSkill(skillId);
    const sourceScript = path.join(sourceSkillDir, 'scripts', 'run.sh');
    fs.mkdirSync(path.dirname(sourceScript), { recursive: true });
    fs.writeFileSync(sourceScript, '#!/bin/sh\necho ok\n');
    fs.chmodSync(sourceScript, 0o755);

    const projectRoot = path.join(agentsHome, 'bootstrap-mode-project');
    fs.mkdirSync(projectRoot, { recursive: true });

    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [skillId] }), {
      project: projectRoot,
    });

    distributeSkills({ project: projectRoot });
    const targetDir = path.join(projectRoot, '.claude', 'skills', skillId);
    const targetScript = path.join(targetDir, 'scripts', 'run.sh');
    fs.chmodSync(targetScript, 0o644);

    const { manifest } = loadManifest(projectRoot);
    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );
    const result = outcome.results.find(
      (entry) => entry.platform === 'claude-code' && entry.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
    assert.ok(manifest.sections.skills, 'manifest should have skills section after adoption');
    assert.ok(
      Object.keys(manifest.sections.skills).some((key) => key.startsWith(`${skillId}::`)),
      'manifest should adopt mode-drifted skill directory'
    );
  });
});

test('managed skill publication rejects a symlinked project parent', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('skill-parent-symlink');

    const projectRoot = path.join(agentsHome, 'bootstrap-parent-symlink-project');
    const skillsLink = path.join(projectRoot, '.claude', 'skills');
    const outsideDir = path.join(agentsHome, 'outside-parent-symlink');
    fs.mkdirSync(path.dirname(skillsLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, skillsLink);

    updateLibraryStateSection(
      'skills',
      (state) => ({ ...state, enabled: ['skill-parent-symlink'] }),
      {
        project: projectRoot,
      }
    );

    const { manifest } = loadManifest(projectRoot);
    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );
    const targetDir = path.join(projectRoot, '.claude', 'skills', 'skill-parent-symlink');
    const result = outcome.results.find(
      (entry) => entry.platform === 'claude-code' && entry.targetDir === targetDir
    );

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /escapes root/);
    assert.equal(fs.existsSync(path.join(outsideDir, 'skill-parent-symlink', 'SKILL.md')), false);
    assert.equal(fs.lstatSync(skillsLink).isSymbolicLink(), true);
    assert.equal(manifest.sections.skills?.['skill-parent-symlink::claude-code'], undefined);
  });
});

test('managed mode cleanup preserves a symlinked skill directory', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');

    const projectRoot = path.join(agentsHome, 'managed-symlink-cleanup-project');
    const targetDir = path.join(projectRoot, '.claude', 'skills', 'stale-skill');
    const outsideDir = path.join(agentsHome, 'outside-stale-skill');
    const outsideFile = path.join(outsideDir, 'protected.txt');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideDir, targetDir);

    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [] }), {
      project: projectRoot,
    });

    const { manifest } = loadManifest(projectRoot);
    recordLibraryEntry(manifest, 'skills', 'stale-skill', {
      relativePath: path.relative(projectRoot, targetDir),
      targetId: 'claude-code',
      hash: 'old',
      updatedAt: '',
    });

    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );
    const result = outcome.results.find(
      (entry) => entry.platform === 'claude-code' && entry.entryId === 'stale-skill'
    );

    assert.equal(fs.lstatSync(targetDir).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /escapes root/);
    assert.ok(manifest.sections.skills?.['stale-skill::claude-code']);
  });
});

test('managed mode cleanup preserves entries through a symlinked ancestor', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('stale-skill');

    const projectRoot = path.join(agentsHome, 'managed-symlink-ancestor-project');
    const skillsLink = path.join(projectRoot, '.claude', 'skills');
    const outsideDir = path.join(agentsHome, 'outside-skills-parent');
    const outsideStaleDir = path.join(outsideDir, 'stale-skill');

    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: ['stale-skill'] }), {
      project: projectRoot,
    });
    const { manifest } = loadManifest(projectRoot);
    distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.renameSync(path.join(skillsLink, 'stale-skill'), outsideStaleDir);
    fs.rmdirSync(skillsLink);
    fs.symlinkSync(outsideDir, skillsLink);
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [] }), {
      project: projectRoot,
    });

    const outcome = distributeSkills(
      { project: projectRoot },
      {
        manifest,
        projectMode: 'managed',
      }
    );
    const result = outcome.results.find(
      (entry) => entry.platform === 'claude-code' && entry.entryId === 'stale-skill'
    );
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /escapes root/);
    assert.equal(fs.existsSync(outsideStaleDir), true);
    assert.equal(fs.lstatSync(skillsLink).isSymbolicLink(), true);
    assert.ok(manifest.sections.skills?.['stale-skill::claude-code']);
  });
});

test('managed mode retries a handled partial orphan cleanup', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('active-skill');
    const staleSource = createSkill('stale-skill');
    fs.writeFileSync(path.join(staleSource, 'extra.txt'), 'extra\n');
    const projectRoot = path.join(agentsHome, 'managed-cleanup-rollback-project');
    updateLibraryStateSection(
      'skills',
      () => ({
        enabled: ['active-skill', 'stale-skill'],
        agentSync: {},
      }),
      {
        project: projectRoot,
      }
    );
    const { manifest } = loadManifest(projectRoot);
    distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: ['active-skill'] }), {
      project: projectRoot,
    });

    const staleDir = path.join(projectRoot, '.claude', 'skills', 'stale-skill');
    const originalUnlinkSync = fs.unlinkSync;
    let unlinks = 0;
    let outcome: ReturnType<typeof distributeSkills>;
    try {
      fs.unlinkSync = ((target: fs.PathLike) => {
        if (String(target).startsWith(`${staleDir}${path.sep}`) && ++unlinks === 2) {
          throw new Error('mock partial cleanup failure');
        }
        return originalUnlinkSync(target);
      }) as typeof fs.unlinkSync;
      outcome = distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    const cleanupResult = outcome.results.find((entry) => entry.entryId === 'stale-skill');

    assert.equal(cleanupResult?.status, 'error');
    assert.ok(manifest.sections.skills?.['stale-skill::claude-code']);
    assert.ok(manifest.sections.skills?.['active-skill::claude-code']);
    const retry = distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    assert.equal(retry.results.find((entry) => entry.entryId === 'stale-skill')?.status, 'deleted');
    assert.equal(fs.existsSync(staleDir), false);
  });
});

test('exclusive bundle cleanup reports parent scan failure without recording sync state', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');

    const projectRoot = path.join(agentsHome, 'exclusive-cleanup-scan-project');
    const parentDir = path.join(projectRoot, '.claude', 'skills');
    const staleDir = path.join(parentDir, 'stale-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), 'stale\n');

    updateLibraryStateSection('skills', () => ({ enabled: [], agentSync: {} }), {
      project: projectRoot,
    });

    const originalReaddirSync = fs.readdirSync;
    try {
      fs.readdirSync = ((target: fs.PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
        if (path.resolve(String(target)) === path.resolve(parentDir)) {
          throw new Error('mock parent scan failure');
        }
        return originalReaddirSync(target, options);
      }) as typeof fs.readdirSync;

      const outcome = distributeSkills({ project: projectRoot });
      const cleanupResult = outcome.results.find(
        (entry) => entry.platform === 'claude-code' && entry.targetDir === parentDir
      );

      assert.equal(cleanupResult?.status, 'error');
      assert.match(cleanupResult?.error ?? '', /mock parent scan failure/);
      assert.equal(loadLibraryAgentSync('skills')['claude-code'], undefined);
      assert.equal(fs.existsSync(staleDir), true);
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });
});

test('exclusive bundle cleanup deletes orphans through a symlinked agents root', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');

    const agentsRoot = path.join(agentsHome, '.agents');
    const outsideRoot = path.join(agentsHome, 'outside-agents-root');
    const outsideStaleDir = path.join(outsideRoot, 'skills', 'stale-skill');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideRoot, agentsRoot);

    updateLibraryStateSection('skills', () => ({ enabled: [], agentSync: {} }));

    const outcome = distributeSkills(undefined, {
      useAgentsDir: true,
      activeAppIds: ['codex'],
    });
    const result = outcome.results.find(
      (entry) =>
        entry.platform === 'agents' &&
        entry.targetDir === path.join(agentsRoot, 'skills', 'stale-skill')
    );

    assert.equal(result?.status, 'deleted');
    assert.equal(fs.existsSync(outsideStaleDir), false);
    assert.equal(fs.lstatSync(agentsRoot).isSymbolicLink(), true);
  });
});

test('managed command bootstrap preserves a foreign file', () => {
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
    const outcome = distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
      collision: 'error',
    });
    const result = outcome.results.find((entry) => entry.platform === 'claude-code');

    assert.ok(result);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /foreign file exists/);
    assert.equal(
      fs.readFileSync(path.join(projectRoot, '.claude', 'commands', 'demo.md'), 'utf-8'),
      'foreign command\n'
    );
  });
});

test('managed command cleanup rejects an exact file through a symlinked ancestor', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'managed-command-symlink-project');
    const commandsLink = path.join(projectRoot, '.claude', 'commands');
    const outsideDir = path.join(agentsHome, 'outside-command-parent');
    const outsideFile = path.join(outsideDir, 'stale.md');
    const content = 'owned command\n';
    fs.mkdirSync(path.dirname(commandsLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, content);
    fs.symlinkSync(outsideDir, commandsLink);

    const { manifest } = loadManifest(projectRoot);
    recordLibraryEntry(manifest, 'commands', 'stale', {
      relativePath: path.join('.claude', 'commands', 'stale.md'),
      targetId: 'claude-code',
      hash: createHash('sha256').update(content).digest('hex'),
      updatedAt: '',
    });
    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: [] }), {
      project: projectRoot,
    });

    const outcome = distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
    });
    const result = outcome.results.find((entry) => entry.entryId === 'stale');

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /escapes root/);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), content);
    assert.ok(manifest.sections.commands?.['stale::claude-code']);
  });
});

test('managed command publication rejects physical and lexical project escapes', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('codex', 'claude-code');
    fs.mkdirSync(path.join(asbHome, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(asbHome, 'commands', 'outside.md'), '/outside\n');
    const projectRoot = path.join(agentsHome, 'managed-outside-command-project');
    fs.mkdirSync(projectRoot, { recursive: true });
    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: ['outside'] }), {
      project: projectRoot,
    });
    const { manifest } = loadManifest(projectRoot);

    const outcome = distributeCommands({ project: projectRoot }, ['codex'], undefined, {
      manifest,
      projectMode: 'managed',
    });
    const result = outcome.results.find((entry) => entry.platform === 'codex');

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /escapes root/);
    assert.equal(manifest.sections.commands, undefined);

    const targetFile = path.join(projectRoot, '.claude', 'commands', 'outside.md');
    const outsideFile = path.join(agentsHome, 'outside', 'outside.md');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.symlinkSync(outsideFile, targetFile);
    const dangling = distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
      collision: 'takeover',
    }).results.find((entry) => entry.filePath === targetFile);
    assert.equal(dangling?.status, 'error');
    assert.equal(fs.existsSync(outsideFile), false);
  });
});

test('managed command cleanup preserves modified owned content', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    fs.mkdirSync(path.join(asbHome, 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(asbHome, 'commands', 'demo.md'),
      '---\ndescription: demo\n---\n/demo\n'
    );
    const projectRoot = path.join(agentsHome, 'modified-command-project');
    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: ['demo'] }), {
      project: projectRoot,
    });
    const { manifest } = loadManifest(projectRoot);
    distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
    });
    const target = path.join(projectRoot, '.claude', 'commands', 'demo.md');
    const generated = fs.readFileSync(target, 'utf-8');
    fs.writeFileSync(target, 'user edit\n');
    updateLibraryStateSection('commands', (state) => ({ ...state, enabled: [] }), {
      project: projectRoot,
    });

    const outcome = distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
    });
    const result = outcome.results.find((entry) => entry.entryId === 'demo');

    assert.equal(fs.readFileSync(target, 'utf-8'), 'user edit\n');
    assert.equal(result?.status, 'conflict');
    assert.ok(manifest.sections.commands?.['demo::claude-code']);

    fs.writeFileSync(target, generated);
    distributeCommands({ project: projectRoot }, ['claude-code'], undefined, {
      manifest,
      projectMode: 'managed',
    });
    assert.equal(fs.existsSync(target), false, 'unchanged owned file is removed');
  });
});

test('managed skill cleanup preserves modified owned content', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createSkill('modified-skill');
    const projectRoot = path.join(agentsHome, 'modified-skill-project');
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: ['modified-skill'] }), {
      project: projectRoot,
    });
    const { manifest } = loadManifest(projectRoot);
    distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    const targetDir = path.join(projectRoot, '.claude', 'skills', 'modified-skill');
    const targetFile = path.join(targetDir, 'SKILL.md');
    const generated = fs.readFileSync(targetFile, 'utf-8');
    fs.writeFileSync(targetFile, 'user edit\n');
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [] }), {
      project: projectRoot,
    });

    const outcome = distributeSkills(
      { project: projectRoot },
      { manifest, projectMode: 'managed' }
    );
    const result = outcome.results.find((entry) => entry.entryId === 'modified-skill');

    assert.equal(fs.readFileSync(targetFile, 'utf-8'), 'user edit\n');
    assert.equal(result?.status, 'conflict');
    assert.ok(manifest.sections.skills?.['modified-skill::claude-code']);

    fs.writeFileSync(targetFile, generated);
    distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    assert.equal(fs.existsSync(targetDir), false, 'unchanged owned directory is removed');
  });
});

test('managed skill sync preserves active file and empty-directory modifications', () => {
  for (const modification of ['file', 'empty-directory'] as const) {
    withTempHomes(({ agentsHome }) => {
      simulateAppsInstalled('claude-code');
      const skillId = `active-modified-${modification}`;
      createSkill(skillId);
      const projectRoot = path.join(agentsHome, `${skillId}-project`);
      updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [skillId] }), {
        project: projectRoot,
      });
      const { manifest } = loadManifest(projectRoot);
      distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
      const targetDir = path.join(projectRoot, '.claude', 'skills', skillId);
      const changedPath = path.join(targetDir, modification === 'file' ? 'notes.txt' : 'empty');
      if (modification === 'file') fs.writeFileSync(changedPath, 'user notes\n');
      else fs.mkdirSync(changedPath);

      const outcome = distributeSkills(
        { project: projectRoot },
        { manifest, projectMode: 'managed' }
      );
      const result = outcome.results.find((entry) => entry.targetDir === targetDir);

      assert.equal(result?.status, 'conflict');
      assert.equal(result?.reason, 'managed directory was modified');
      assert.equal(fs.existsSync(changedPath), true);
    });
  }
});

test('managed skill update retries after a handled partial write failure', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'partial-update-retry';
    const sourceDir = createSkill(skillId);
    const staleSource = path.join(sourceDir, 'stale.txt');
    fs.writeFileSync(staleSource, 'stale\n');
    const projectRoot = path.join(agentsHome, 'partial-update-retry-project');
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [skillId] }), {
      project: projectRoot,
    });
    const { manifest } = loadManifest(projectRoot);
    distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });

    const targetDir = path.join(projectRoot, '.claude', 'skills', skillId);
    createSkill(skillId, 'new body');
    fs.unlinkSync(staleSource);
    const staleTarget = path.join(targetDir, 'stale.txt');
    const originalUnlinkSync = fs.unlinkSync;
    try {
      fs.unlinkSync = ((target: fs.PathLike) => {
        if (String(target) === staleTarget) throw new Error('mock stale cleanup failure');
        return originalUnlinkSync(target);
      }) as typeof fs.unlinkSync;

      const outcome = distributeSkills(
        { project: projectRoot },
        { manifest, projectMode: 'managed' }
      );
      const result = outcome.results.find((entry) => entry.targetDir === targetDir);
      assert.equal(result?.status, 'error');
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    assert.match(fs.readFileSync(path.join(targetDir, 'SKILL.md'), 'utf-8'), /new body/);
    const retry = distributeSkills({ project: projectRoot }, { manifest, projectMode: 'managed' });
    const retryResult = retry.results.find((entry) => entry.targetDir === targetDir);
    assert.notEqual(retryResult?.status, 'conflict');
    assert.equal(fs.existsSync(staleTarget), false);
  });
});

test('managed skill bootstrap preserves an extra empty directory', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const skillId = 'skill-collision';
    createSkill(skillId);
    const projectRoot = path.join(agentsHome, 'project-collision-bundle');
    updateLibraryStateSection('skills', (state) => ({ ...state, enabled: [skillId] }), {
      project: projectRoot,
    });
    distributeSkills({ project: projectRoot });
    const targetDir = path.join(projectRoot, '.claude', 'skills', skillId);
    const emptyDir = path.join(targetDir, 'user-empty');
    fs.mkdirSync(emptyDir);

    const { manifest } = loadManifest(projectRoot);
    const outcome = distributeSkills(
      { project: projectRoot },
      { manifest, projectMode: 'managed', collision: 'error' }
    );
    const result = outcome.results.find((entry) => entry.targetDir === targetDir);

    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /foreign directory exists/);
    assert.equal(fs.existsSync(emptyDir), true);
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
