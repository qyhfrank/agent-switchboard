import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import {
  codexServer,
  geminiServer,
  opencodeServer,
  renderCodexTable,
} from '../src/engine/dialects.js';
import {
  applyKeysEdits,
  parseStructured,
  sliceHash,
  valueAtKeyPath,
} from '../src/engine/shapes.js';

/**
 * The per-app MCP value transforms and the codex TOML text renderer.
 *
 * Codex is the one app whose slice is rendered as text rather than serialized
 * from the value, so the table bytes are the contract: they are what lands in
 * a config the user also writes, and what the drift check hashes back.
 */

function codexTable(name: string, server: Record<string, unknown>): string {
  const value = codexServer(server);
  assert.ok(value !== null, `${name} should render`);
  return renderCodexTable(['mcp_servers', name], value);
}

test('codex: a table spells args, dotted env, bare numbers, and inline headers', () => {
  assert.equal(
    codexTable('myserver', {
      command: 'npx',
      args: ['-y', '@my/server'],
      env: { DEBUG: 'true', API_KEY: 'secret' },
      startup_timeout_sec: 30,
      startup_timeout_ms: 5000,
      tool_timeout_sec: 60,
    }),
    [
      '[mcp_servers.myserver]',
      'command = "npx"',
      'args = [ "-y", "@my/server" ]',
      'startup_timeout_sec = 30',
      'startup_timeout_ms = 5_000',
      'tool_timeout_sec = 60',
      'env.API_KEY = "secret"',
      'env.DEBUG = "true"',
    ].join('\n')
  );

  // A url server carries no command line at all, and its headers become one
  // alphabetically sorted inline table.
  assert.equal(
    codexTable('remote', {
      url: 'https://example.com/mcp',
      headers: { 'X-Custom': 'val', Authorization: 'Bearer tok123' },
      required: true,
      enabled_tools: ['tool_a', 'tool_b'],
      env_vars: ['HOME', 'PATH'],
    }),
    [
      '[mcp_servers.remote]',
      'url = "https://example.com/mcp"',
      'required = true',
      'enabled_tools = [ "tool_a", "tool_b" ]',
      'env_vars = [ "HOME", "PATH" ]',
      'http_headers = { "Authorization" = "Bearer tok123", "X-Custom" = "val" }',
    ].join('\n')
  );
});

test('codex: canonical key order holds however the definition is written', () => {
  const value = codexServer({
    tool_timeout_sec: 60,
    zebra_option: 'z',
    url: 'https://example.com',
    enabled: true,
    env_http_headers: { 'X-Api-Key': 'API_KEY_VAR', Authorization: 'AUTH_TOKEN_VAR' },
    command: 'node',
    args: ['server.js'],
    headers: { 'X-Old': 'old' },
    required: true,
    cwd: '/opt',
    type: 'stdio',
    env_file: '.env',
    alpha_option: 'a',
    http_headers: { 'X-New': 'new' },
    bearer_token_env_var: 'TOKEN',
    disabled_tools: ['tool_c'],
    env_vars: ['HOME'],
    enabled_tools: ['tool_a'],
    startup_timeout_sec: 10,
  });
  assert.ok(value !== null, 'a stdio definition should render');

  // The allowlist in its fixed order, then the header maps, then unknown keys
  // alphabetically. type, enabled and the raw headers key are never emitted.
  assert.deepEqual(Object.keys(value), [
    'command',
    'args',
    'url',
    'cwd',
    'bearer_token_env_var',
    'env_file',
    'required',
    'enabled_tools',
    'disabled_tools',
    'env_vars',
    'startup_timeout_sec',
    'tool_timeout_sec',
    'http_headers',
    'env_http_headers',
    'alpha_option',
    'zebra_option',
  ]);
  assert.deepEqual(value.http_headers, { 'X-New': 'new' }, 'an explicit map wins over headers');
  assert.deepEqual(Object.keys(value.env_http_headers as object), ['Authorization', 'X-Api-Key']);
});

test('codex: two servers land as separate tables one blank line apart', () => {
  const first = codexServer({ command: 'a' }) as Record<string, unknown>;
  const second = codexServer({ command: 'b' }) as Record<string, unknown>;

  const content = applyKeysEdits('', 'toml', [
    {
      keyPath: ['mcp_servers', 'first'],
      value: first,
      text: renderCodexTable(['mcp_servers', 'first'], first),
    },
    {
      keyPath: ['mcp_servers', 'second'],
      value: second,
      text: renderCodexTable(['mcp_servers', 'second'], second),
    },
  ]);

  assert.equal(
    content,
    '[mcp_servers.first]\ncommand = "a"\n\n[mcp_servers.second]\ncommand = "b"\n'
  );
});

test('codex: a rendered table parses back to the value that was recorded', () => {
  // Backslashes, newlines and quotes in header names and values are ordinary
  // content on Windows paths; hand-quoting them wrote TOML codex cannot read.
  const value = codexServer({
    command: 'npx',
    args: ['-y', 'srv'],
    type: 'stdio',
    headers: { 'X-Path': 'C:\\Users\\me', 'X-"Q"': 'line1\nline2' },
    env: { Z: '9', A: 'C:\\tmp' },
    startup_timeout_sec: 5,
    required: true,
    'weird key': 'x',
  });
  assert.ok(value !== null, 'a stdio definition should render');

  const parsed = parseToml(`${renderCodexTable(['mcp_servers', 'srv'], value)}\n`) as Record<
    string,
    unknown
  >;

  // The recorded hash is a hash of the rendered value, so a round trip through
  // the file has to reproduce it exactly or every run reads as drift.
  assert.equal(sliceHash(valueAtKeyPath(parsed, ['mcp_servers', 'srv'])), sliceHash(value));
});

test('codex: a quoted server name round-trips through the table header', () => {
  const value = codexServer({ command: 'x' }) as Record<string, unknown>;
  const content = applyKeysEdits('', 'toml', [
    {
      keyPath: ['mcp_servers', 'my.server'],
      value,
      text: renderCodexTable(['mcp_servers', 'my.server'], value),
    },
  ]);

  assert.match(content, /\[mcp_servers\."my\.server"\]/);
  assert.deepEqual(parseStructured(content, 'toml').tables, [['mcp_servers', 'my.server']]);
});

test('gemini: http becomes httpUrl, url-only servers keep url, and type never survives', () => {
  assert.deepEqual(geminiServer({ type: 'http', url: 'https://example.com', timeout: 10 }), {
    httpUrl: 'https://example.com',
    timeout: 10,
  });
  assert.deepEqual(geminiServer({ type: 'sse', url: 'https://example.com' }), {
    url: 'https://example.com',
  });
  assert.deepEqual(geminiServer({ url: 'https://example.com' }), { url: 'https://example.com' });
  assert.deepEqual(
    geminiServer({ type: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' }, extra: 1 }),
    { command: 'npx', args: ['a'], env: { K: 'v' }, extra: 1 }
  );
});

test('opencode: a local server becomes an argv array and a remote one keeps url and headers', () => {
  assert.deepEqual(
    opencodeServer({ type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' } }),
    { type: 'local', command: ['npx', '-y', 'srv'], environment: { K: 'v' }, enabled: true }
  );
  assert.deepEqual(
    opencodeServer({ type: 'http', url: 'https://example.com', headers: { A: 'b' }, command: 'x' }),
    { type: 'remote', url: 'https://example.com', headers: { A: 'b' }, enabled: true }
  );
});
