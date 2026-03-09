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
        '[applications]',
        'enabled = ["claude-code", "opencode"]',
        '[commands]',
        'enabled = ["cmd-user"]',
      ].join('\n')
    );

    const profilePath = getProfileConfigPath('team');
    fs.writeFileSync(
      profilePath,
      ['[commands]', 'enabled = ["cmd-profile"]', '[rules]', 'includeDelimiters = true'].join('\n')
    );

    const projectRoot = path.join(asbHome, 'project');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectPath = getProjectConfigPath(projectRoot);
    fs.writeFileSync(
      projectPath,
      ['[commands]', 'enabled = ["cmd-project"]', '[agents]', 'enabled = ["agent-project"]'].join(
        '\n'
      )
    );

    const result = loadConfigLayers({ profile: 'team', projectPath: projectRoot });

    assert.equal(result.user.exists, true);
    assert.deepEqual(result.user.config.applications?.enabled, ['claude-code', 'opencode']);
    assert.deepEqual(result.user.config.commands?.enabled, ['cmd-user']);

    assert.ok(result.profile);
    assert.equal(result.profile?.exists, true);
    assert.equal(result.profile?.config.applications, undefined);
    assert.deepEqual(result.profile?.config.commands?.enabled, ['cmd-profile']);
    assert.deepEqual(result.profile?.config.rules?.includeDelimiters, true);

    assert.ok(result.project);
    assert.equal(result.project?.exists, true);
    assert.deepEqual(result.project?.config.commands?.enabled, ['cmd-project']);
    assert.deepEqual(result.project?.config.agents?.enabled, ['agent-project']);
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

test('loadConfigLayers migrates applications.active to applications.enabled across layers', () => {
  withTempAsbHome((asbHome) => {
    const userPath = path.join(asbHome, 'config.toml');
    fs.writeFileSync(userPath, ['[applications]', 'active = ["claude-code"]'].join('\n'));

    const profilePath = getProfileConfigPath('team');
    fs.writeFileSync(profilePath, ['[applications]', 'active = ["codex"]'].join('\n'));

    const projectRoot = path.join(asbHome, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    const projectPath = getProjectConfigPath(projectRoot);
    fs.writeFileSync(projectPath, ['[applications]', 'active = ["cursor"]'].join('\n'));

    const result = loadConfigLayers({ profile: 'team', projectPath: projectRoot });

    assert.deepEqual(result.user.config.applications?.enabled, ['claude-code']);
    assert.deepEqual(result.profile?.config.applications?.enabled, ['codex']);
    assert.deepEqual(result.project?.config.applications?.enabled, ['cursor']);

    assert.match(fs.readFileSync(userPath, 'utf-8'), /enabled = \[\s*"claude-code"\s*\]/);
    assert.doesNotMatch(fs.readFileSync(userPath, 'utf-8'), /active = \[/);
    assert.match(fs.readFileSync(profilePath, 'utf-8'), /enabled = \[\s*"codex"\s*\]/);
    assert.doesNotMatch(fs.readFileSync(profilePath, 'utf-8'), /active = \[/);
    assert.match(fs.readFileSync(projectPath, 'utf-8'), /enabled = \[\s*"cursor"\s*\]/);
    assert.doesNotMatch(fs.readFileSync(projectPath, 'utf-8'), /active = \[/);
  });
});

test('buildMergedSwitchboardConfig applies precedence project > profile > user', () => {
  withTempAsbHome((asbHome) => {
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      [
        '[applications]',
        'enabled = ["user-agent"]',
        '[commands]',
        'enabled = ["cmd-user"]',
        '[rules]',
        'enabled = ["rule-user"]',
        'includeDelimiters = false',
      ].join('\n')
    );

    fs.writeFileSync(
      getProfileConfigPath('team'),
      [
        '[commands]',
        'enabled = ["cmd-profile"]',
        '[rules]',
        'enabled = ["rule-profile"]',
        'includeDelimiters = true',
      ].join('\n')
    );

    const projectRoot = path.join(asbHome, 'proj');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(
      getProjectConfigPath(projectRoot),
      [
        '[commands]',
        'enabled = ["cmd-project"]',
        '[rules]',
        'enabled = ["rule-project"]',
        '[agents]',
        'enabled = ["sub-project"]',
      ].join('\n')
    );

    const { config: merged } = loadMergedSwitchboardConfig({
      profile: 'team',
      projectPath: projectRoot,
    });

    assert.deepEqual(merged.applications.enabled, ['user-agent']);
    assert.deepEqual(merged.commands.enabled, ['cmd-project']);
    assert.deepEqual(merged.rules.enabled, ['rule-project']);
    assert.equal(merged.rules.includeDelimiters, true);
    assert.deepEqual(merged.agents.enabled, ['sub-project']);
    assert.deepEqual(merged.mcp.enabled, []);
  });
});
