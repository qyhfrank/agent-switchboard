import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type JsonAgentConfig, managedMergeMcp } from '../src/agents/json-utils.js';

test('managedMergeMcp preserves foreign servers', () => {
  const existing: JsonAgentConfig = {
    mcpServers: {
      'user-server': { command: 'node', args: ['server.js'] },
    },
  };

  const result = managedMergeMcp(
    existing,
    {
      'asb-server': { command: 'asb-mcp' },
    },
    new Set()
  );

  assert.ok(result.mcpServers['user-server'], 'Foreign server should be preserved');
  assert.ok(result.mcpServers['asb-server'], 'ASB server should be added');
});

test('managedMergeMcp removes previously owned but now disabled servers', () => {
  const existing: JsonAgentConfig = {
    mcpServers: {
      'asb-old': { command: 'old-cmd' },
      'asb-current': { command: 'current-cmd' },
      'user-server': { command: 'user-cmd' },
    },
  };

  const result = managedMergeMcp(
    existing,
    { 'asb-current': { command: 'updated-cmd' } },
    new Set(['asb-old', 'asb-current'])
  );

  assert.equal(result.mcpServers['asb-old'], undefined, 'Disabled owned server should be removed');
  assert.ok(result.mcpServers['asb-current'], 'Still-active server should remain');
  assert.equal(
    (result.mcpServers['asb-current'] as Record<string, unknown>).command,
    'updated-cmd',
    'Active server should be updated'
  );
  assert.ok(result.mcpServers['user-server'], 'Foreign server should be preserved');
});

test('managedMergeMcp handles empty existing config', () => {
  const existing: JsonAgentConfig = {};

  const result = managedMergeMcp(existing, { 'new-server': { command: 'cmd' } }, new Set());

  assert.ok(result.mcpServers['new-server']);
});

test('managedMergeMcp does not modify original config', () => {
  const existing: JsonAgentConfig = {
    mcpServers: { 'server-a': { command: 'a' } },
  };

  const result = managedMergeMcp(existing, { 'server-b': { command: 'b' } }, new Set());

  assert.equal(existing.mcpServers['server-b'], undefined, 'Original should not be mutated');
  assert.ok(result.mcpServers['server-b']);
});

test('managedMergeMcp merges fields into existing server config', () => {
  const existing: JsonAgentConfig = {
    mcpServers: {
      'my-server': { command: 'old-cmd', args: ['--old'] } as Record<string, unknown>,
    },
  };

  const result = managedMergeMcp(
    existing,
    { 'my-server': { command: 'new-cmd' } },
    new Set(['my-server'])
  );

  const server = result.mcpServers['my-server'] as Record<string, unknown>;
  assert.equal(server.command, 'new-cmd', 'Command should be updated');
  assert.deepStrictEqual(server.args, ['--old'], 'Existing args should be preserved');
});
