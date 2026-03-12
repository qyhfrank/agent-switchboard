import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse } from '@iarna/toml';
import {
  loadLibraryStateSection,
  loadWritableLibraryStateSection,
  resetAgentSyncCache,
  updateLibraryStateSection,
} from '../src/library/state.js';
import { loadRuleState, loadWritableRuleState, updateRuleState } from '../src/rules/state.js';
import { distributeSkills } from '../src/skills/distribution.js';
import { ensureSkillsDirectory } from '../src/skills/library.js';
import { shouldPersistSelection } from '../src/ui/selection-state.js';
import { simulateAppsInstalled, withTempHomes } from './helpers/tmp.js';

function writeConfig(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8');
}

function readToml(filePath: string): Record<string, unknown> {
  return parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

test('project writable library state does not inherit user-level enabled entries', () => {
  withTempHomes(({ asbHome }) => {
    resetAgentSyncCache();
    writeConfig(path.join(asbHome, 'config.toml'), ['[skills]', 'enabled = ["user-skill"]']);

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const effective = loadLibraryStateSection('skills', { project: projectRoot });
    const writable = loadWritableLibraryStateSection('skills', { project: projectRoot });

    assert.deepEqual(effective.enabled, ['user-skill']);
    assert.deepEqual(writable.enabled, []);
  });
});

test('profile writable library state does not inherit user-level enabled entries', () => {
  withTempHomes(({ asbHome }) => {
    resetAgentSyncCache();
    writeConfig(path.join(asbHome, 'config.toml'), ['[skills]', 'enabled = ["user-skill"]']);

    const effective = loadLibraryStateSection('skills', { profile: 'team' });
    const writable = loadWritableLibraryStateSection('skills', { profile: 'team' });

    assert.deepEqual(effective.enabled, ['user-skill']);
    assert.deepEqual(writable.enabled, []);
  });
});

test('updateLibraryStateSection mutates only the writable project layer', () => {
  withTempHomes(({ asbHome }) => {
    resetAgentSyncCache();
    writeConfig(path.join(asbHome, 'config.toml'), ['[skills]', 'enabled = ["user-skill"]']);

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const updated = updateLibraryStateSection(
      'skills',
      (current) => ({
        ...current,
        enabled: [...current.enabled, 'project-skill'],
      }),
      { project: projectRoot }
    );

    const projectConfig = readToml(path.join(projectRoot, '.asb.toml'));
    const skills = (projectConfig.skills ?? {}) as Record<string, unknown>;

    assert.deepEqual(updated.enabled, ['project-skill']);
    assert.deepEqual(skills.enabled, ['project-skill']);
    assert.ok(!(skills.enabled as string[]).includes('user-skill'));
  });
});

test('project writable rule state does not inherit user-level enabled entries', () => {
  withTempHomes(({ asbHome }) => {
    writeConfig(path.join(asbHome, 'config.toml'), ['[rules]', 'enabled = ["user-rule"]']);

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const effective = loadRuleState({ project: projectRoot });
    const writable = loadWritableRuleState({ project: projectRoot });

    assert.deepEqual(effective.enabled, ['user-rule']);
    assert.deepEqual(writable.enabled, []);
  });
});

test('updateRuleState mutates only the writable project layer', () => {
  withTempHomes(({ asbHome }) => {
    writeConfig(path.join(asbHome, 'config.toml'), ['[rules]', 'enabled = ["user-rule"]']);

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const updated = updateRuleState(
      (current) => ({
        ...current,
        enabled: [...current.enabled, 'project-rule'],
      }),
      { project: projectRoot }
    );

    const projectConfig = readToml(path.join(projectRoot, '.asb.toml'));
    const rules = (projectConfig.rules ?? {}) as Record<string, unknown>;

    assert.deepEqual(updated.enabled, ['project-rule']);
    assert.deepEqual(rules.enabled, ['project-rule']);
    assert.ok(!(rules.enabled as string[]).includes('user-rule'));
  });
});

test('project skill distribution does not materialize inherited enabled entries into .asb.toml', () => {
  withTempHomes(({ asbHome }) => {
    resetAgentSyncCache();
    simulateAppsInstalled('claude-code');
    writeConfig(path.join(asbHome, 'config.toml'), [
      '[applications]',
      'enabled = ["claude-code"]',
      '',
      '[skills]',
      'enabled = ["user-skill"]',
    ]);

    const skillDir = path.join(ensureSkillsDirectory(), 'user-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      ['---', 'name: User Skill', 'description: Test skill', '---', 'Body'].join('\n'),
      'utf-8'
    );

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });

    const outcome = distributeSkills({ project: projectRoot });

    assert.equal(
      outcome.results.some((result) => result.platform === 'claude-code'),
      false
    );
    assert.equal(fs.existsSync(path.join(projectRoot, '.asb.toml')), false);
  });
});

test('shouldPersistSelection requires explicit empty override when only inherited entries exist', () => {
  assert.equal(
    shouldPersistSelection({
      effectiveEnabled: ['user-skill'],
      selectedEnabled: [],
    }),
    true
  );
  assert.equal(
    shouldPersistSelection({
      effectiveEnabled: [],
      selectedEnabled: [],
    }),
    false
  );
});
