import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfigLayers, loadMergedSwitchboardConfig } from '../src/config/layered-config.js';
import { getProfileConfigPath, getProjectConfigPath } from '../src/config/paths.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('loadConfigLayers returns empty configs when files are missing', () => {
  withTempAsbHome(() => {
    const result = loadConfigLayers({ profile: 'team', projectPath: 'some/project' });

    assert.equal(result.user.exists, false);
    assert.deepEqual(result.user.config, {});

    assert.ok(result.profile);
    assert.equal(result.profile?.exists, false);
    assert.deepEqual(result.profile?.config, {});

    assert.ok(result.project);
    assert.equal(result.project?.exists, false);
    assert.deepEqual(result.project?.config, {});
  });
});

test('loadConfigLayers reads user, profile, and project configs when present', () => {
  withTempAsbHome((asbHome) => {
    const userPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(
      userPath,
      [
        '[agents]',
        'active = ["claude-code", "opencode"]',
        '[commands]',
        'active = ["cmd-user"]',
      ].join('\n')
    );

    const profilePath = getProfileConfigPath('team');
    fs.writeFileSync(
      profilePath,
      ['[commands]', 'active = ["cmd-profile"]', '[rules]', 'includeDelimiters = true'].join('\n')
    );

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectPath = getProjectConfigPath(projectRoot);
    fs.writeFileSync(
      projectPath,
      ['[commands]', 'active = ["cmd-project"]', '[subagents]', 'active = ["agent-project"]'].join(
        '\n'
      )
    );

    const result = loadConfigLayers({ profile: 'team', projectPath: projectRoot });

    assert.equal(result.user.exists, true);
    assert.deepEqual(result.user.config.agents?.active, ['claude-code', 'opencode']);
    assert.deepEqual(result.user.config.commands?.active, ['cmd-user']);

    assert.ok(result.profile);
    assert.equal(result.profile?.exists, true);
    assert.equal(result.profile?.config.agents, undefined);
    assert.deepEqual(result.profile?.config.commands?.active, ['cmd-profile']);
    assert.deepEqual(result.profile?.config.rules?.includeDelimiters, true);

    assert.ok(result.project);
    assert.equal(result.project?.exists, true);
    assert.deepEqual(result.project?.config.commands?.active, ['cmd-project']);
    assert.deepEqual(result.project?.config.subagents?.active, ['agent-project']);
  });
});

test('loadConfigLayers surfaces TOML parse errors with file context', () => {
  withTempAsbHome((asbHome) => {
    const userPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(userPath, '[[broken');

    assert.throws(
      () => loadConfigLayers(),
      /Failed to load configuration from/,
      'should wrap TOML errors with file path context'
    );
  });
});

test('buildMergedSwitchboardConfig applies precedence project > profile > user', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[agents]',
        'active = ["user-agent"]',
        '[commands]',
        'active = ["cmd-user"]',
        '[rules]',
        'active = ["rule-user"]',
        'includeDelimiters = false',
      ].join('\n')
    );

    fs.writeFileSync(
      getProfileConfigPath('team'),
      [
        '[commands]',
        'active = ["cmd-profile"]',
        '[rules]',
        'active = ["rule-profile"]',
        'includeDelimiters = true',
      ].join('\n')
    );

    const projectRoot = path.join(asbHome, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      getProjectConfigPath(projectRoot),
      [
        '[commands]',
        'active = ["cmd-project"]',
        '[rules]',
        'active = ["rule-project"]',
        '[subagents]',
        'active = ["sub-project"]',
      ].join('\n')
    );

    const { config: merged } = loadMergedSwitchboardConfig({
      profile: 'team',
      projectPath: projectRoot,
    });

    assert.deepEqual(merged.agents.active, ['user-agent']);
    assert.deepEqual(merged.commands.active, ['cmd-project']);
    assert.deepEqual(merged.rules.active, ['rule-project']);
    assert.equal(merged.rules.includeDelimiters, true);
    assert.deepEqual(merged.subagents.active, ['sub-project']);
    assert.deepEqual(merged.mcp.active, []);
  });
});
