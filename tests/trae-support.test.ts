import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { loadJsonFile } from '../src/agents/json-utils.js';
import { getAgentById } from '../src/agents/registry.js';
import { TraeAgent } from '../src/agents/trae.js';
import { distributeRules } from '../src/rules/distribution.js';
import { ensureRulesDirectory } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, saveRuleState } from '../src/rules/state.js';
import { getTargetsForSection } from '../src/targets/registry.js';
import { withTempDir, withTempHomes } from './helpers/tmp.js';

// ---------------------------------------------------------------------------
// Registry: trae variants are registered
// ---------------------------------------------------------------------------

test('getAgentById returns TraeAgent for both variants', () => {
  const trae = getAgentById('trae');
  assert.equal(trae.id, 'trae');

  const traeCn = getAgentById('trae-cn');
  assert.equal(traeCn.id, 'trae-cn');
});

// ---------------------------------------------------------------------------
// Rules: target registry includes trae
// ---------------------------------------------------------------------------

test('rules targets include trae and trae-cn', () => {
  const ids = getTargetsForSection('rules').map((t) => t.id);
  assert.ok(ids.includes('trae'), 'trae should support rules');
  assert.ok(ids.includes('trae-cn'), 'trae-cn should support rules');
});

// ---------------------------------------------------------------------------
// MCP: TraeAgent adapter
// ---------------------------------------------------------------------------

test('TraeAgent.configPath returns platform-specific path', () => {
  withTempHomes(({ agentsHome }) => {
    const agent = new TraeAgent('trae');
    const configPath = agent.configPath();
    // On macOS: ~/Library/Application Support/Trae/User/mcp.json
    assert.ok(configPath.startsWith(agentsHome), 'should be under agents home');
    assert.ok(configPath.endsWith('mcp.json'), 'should end with mcp.json');
  });
});

test('TraeAgent.projectConfigPath returns .trae/mcp.json', () => {
  const agent = new TraeAgent('trae');
  const projectPath = agent.projectConfigPath('/some/project');
  assert.equal(projectPath, path.join('/some/project', '.trae', 'mcp.json'));
});

test('TraeAgent.applyConfig writes MCP servers to config', () => {
  withTempHomes(() => {
    const agent = new TraeAgent('trae');
    const configDir = path.dirname(agent.configPath());
    fs.mkdirSync(configDir, { recursive: true });

    agent.applyConfig({
      mcpServers: {
        'test-server': { command: 'node', args: ['server.js'], type: 'stdio' },
      },
    });

    type McpJson = { mcpServers: Record<string, unknown> };
    const written = loadJsonFile<McpJson>(agent.configPath(), { mcpServers: {} });
    assert.ok('test-server' in written.mcpServers, 'server should be written');
  });
});

test('TraeAgent.applyProjectConfig creates directory and writes config', () => {
  withTempDir((dir) => {
    withTempHomes(() => {
      const agent = new TraeAgent('trae-cn');
      agent.applyProjectConfig(dir, {
        mcpServers: {
          'proj-server': { command: 'echo', args: [], type: 'stdio' },
        },
      });

      const configPath = agent.projectConfigPath(dir);
      assert.ok(fs.existsSync(configPath), 'project config should exist');

      type McpJson = { mcpServers: Record<string, unknown> };
      const written = loadJsonFile<McpJson>(configPath, { mcpServers: {} });
      assert.ok('proj-server' in written.mcpServers, 'project server should be written');
    });
  });
});

test('TraeAgent.applyConfig preserves existing non-MCP fields', () => {
  withTempHomes(() => {
    const agent = new TraeAgent('trae');
    const configDir = path.dirname(agent.configPath());
    fs.mkdirSync(configDir, { recursive: true });

    // Pre-populate with extra fields
    fs.writeFileSync(
      agent.configPath(),
      JSON.stringify({ customField: 'keep-me', mcpServers: {} })
    );

    agent.applyConfig({
      mcpServers: {
        srv: { command: 'node', args: [], type: 'stdio' },
      },
    });

    type FullConfig = { customField?: string; mcpServers: Record<string, unknown> };
    const written = loadJsonFile<FullConfig>(agent.configPath(), { mcpServers: {} });
    assert.equal(written.customField, 'keep-me', 'non-MCP fields should be preserved');
    assert.ok('srv' in written.mcpServers, 'MCP server should be written');
  });
});

test('TraeAgent.applyConfig sanitizes server names', () => {
  withTmpTraeAgent('trae', (agent) => {
    agent.applyConfig({
      mcpServers: {
        'ns:server': { command: 'echo', args: [], type: 'stdio' },
        'plain-name': { command: 'node', args: [], type: 'stdio' },
      },
    });

    type McpJson = { mcpServers: Record<string, unknown> };
    const written = loadJsonFile<McpJson>(agent.configPath(), { mcpServers: {} });
    const names = Object.keys(written.mcpServers);

    assert.ok(!names.includes('ns:server'), 'coloned name should not appear');
    assert.ok(names.includes('ns-server'), 'coloned name should be sanitized');
    assert.ok(names.includes('plain-name'), 'valid name should be preserved');
  });
});

// ---------------------------------------------------------------------------
// Rules: trae distribution
// ---------------------------------------------------------------------------

test('distributeRules: writes asb-rules.md for trae with frontmatter', () => {
  withTmpTraeRules((agentsHome) => {
    const outcome = distributeRules();

    const traeResults = outcome.results.filter((r) => r.agent === 'trae');
    assert.equal(traeResults.length, 1, 'should have one trae distribution result');
    assert.equal(traeResults[0].status, 'written');

    const content = fs.readFileSync(traeResults[0].filePath, 'utf-8');
    assert.match(content, /^---/);
    assert.match(content, /description: Agent Switchboard Rules/);
    assert.match(content, /alwaysApply: true/);
    assert.match(content, /Test rule body/);

    // Verify path is under the trae data dir
    assert.ok(
      traeResults[0].filePath.includes(path.join(agentsHome, '.trae')),
      'should write to .trae data dir'
    );
    assert.ok(
      traeResults[0].filePath.endsWith(path.join('user_rules', 'asb-rules.md')),
      'should write to user_rules/asb-rules.md'
    );
  });
});

test('distributeRules: writes asb-rules.md for trae-cn with frontmatter', () => {
  withTmpTraeRules((agentsHome) => {
    const outcome = distributeRules();

    const traeCnResults = outcome.results.filter((r) => r.agent === 'trae-cn');
    assert.equal(traeCnResults.length, 1, 'should have one trae-cn distribution result');
    assert.equal(traeCnResults[0].status, 'written');

    const content = fs.readFileSync(traeCnResults[0].filePath, 'utf-8');
    assert.match(content, /^---/);
    assert.match(content, /alwaysApply: true/);

    assert.ok(
      traeCnResults[0].filePath.includes(path.join(agentsHome, '.trae-cn')),
      'should write to .trae-cn data dir'
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpTraeAgent(variant: 'trae' | 'trae-cn', fn: (agent: TraeAgent) => void): void {
  withTempHomes(() => {
    const agent = new TraeAgent(variant);
    const configDir = path.dirname(agent.configPath());
    fs.mkdirSync(configDir, { recursive: true });
    fn(agent);
  });
}

function withTmpTraeRules(fn: (agentsHome: string) => void): void {
  withTempHomes(({ agentsHome }) => {
    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'trae-test.md'), 'Test rule body.\n');
    saveRuleState({ ...DEFAULT_RULE_STATE, enabled: ['trae-test'], agentSync: {} });
    fn(agentsHome);
  });
}
