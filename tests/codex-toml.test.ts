import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNestedToml, ensureTrustEntry, mergeConfig } from '../src/agents/codex.js';

// ---------------------------------------------------------------------------
// buildNestedToml: basic stdio server
// ---------------------------------------------------------------------------

test('buildNestedToml: stdio server with command, args, env', () => {
  const toml = buildNestedToml({
    myserver: {
      command: 'npx',
      args: ['-y', '@my/server'],
      env: { API_KEY: 'secret', DEBUG: 'true' },
    },
  });

  assert.match(toml, /\[mcp_servers\.myserver\]/);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /args = \[?\s*"-y",?\s*"@my\/server"\s*\]?/);
  // env keys should be alphabetical
  assert.match(toml, /env\.API_KEY = "secret"/);
  assert.match(toml, /env\.DEBUG = "true"/);
  // API_KEY should come before DEBUG (alphabetical)
  const apiIdx = toml.indexOf('env.API_KEY');
  const debugIdx = toml.indexOf('env.DEBUG');
  assert.ok(apiIdx < debugIdx, 'env keys should be alphabetical');
});

// ---------------------------------------------------------------------------
// buildNestedToml: http server with url
// ---------------------------------------------------------------------------

test('buildNestedToml: http server with url and http_headers', () => {
  const toml = buildNestedToml({
    remote: {
      url: 'https://example.com/mcp',
      http_headers: { Authorization: 'Bearer tok123', 'X-Custom': 'val' },
    },
  });

  assert.match(toml, /\[mcp_servers\.remote\]/);
  assert.match(toml, /url = "https:\/\/example\.com\/mcp"/);
  // http_headers rendered as inline table
  assert.match(toml, /http_headers = \{/);
  assert.match(toml, /"Authorization"/);
  assert.match(toml, /"Bearer tok123"/);
  // Should NOT contain a bare command key
  assert.ok(!toml.includes('command ='));
});

// ---------------------------------------------------------------------------
// buildNestedToml: headers -> http_headers mapping
// ---------------------------------------------------------------------------

test('buildNestedToml: generic headers mapped to http_headers', () => {
  const toml = buildNestedToml({
    srv: {
      url: 'https://example.com',
      headers: { 'X-Token': 'abc' },
    },
  });

  // Should be rendered as http_headers, not headers
  assert.match(toml, /http_headers = \{.*"X-Token".*"abc"/);
  // The raw "headers" key should NOT appear as a top-level key
  const lines = toml.split('\n');
  const headerLines = lines.filter((l) => /^headers\s*=/.test(l));
  assert.equal(headerLines.length, 0, 'raw headers key should not appear');
});

test('buildNestedToml: explicit http_headers takes precedence over headers', () => {
  const toml = buildNestedToml({
    srv: {
      url: 'https://example.com',
      headers: { 'X-Old': 'old' },
      http_headers: { 'X-New': 'new' },
    },
  });

  assert.match(toml, /"X-New".*"new"/);
  assert.ok(!toml.includes('X-Old'), 'headers field should be ignored when http_headers is set');
});

// ---------------------------------------------------------------------------
// buildNestedToml: new Codex fields
// ---------------------------------------------------------------------------

test('buildNestedToml: bearer_token_env_var', () => {
  const toml = buildNestedToml({
    srv: { url: 'https://example.com', bearer_token_env_var: 'MY_TOKEN' },
  });
  assert.match(toml, /bearer_token_env_var = "MY_TOKEN"/);
});

test('buildNestedToml: cwd field', () => {
  const toml = buildNestedToml({
    srv: { command: 'node', args: ['server.js'], cwd: '/opt/app' },
  });
  assert.match(toml, /cwd = "\/opt\/app"/);
  // cwd should come after url position but before bearer_token_env_var in canonical order
  const cmdIdx = toml.indexOf('command =');
  const cwdIdx = toml.indexOf('cwd =');
  assert.ok(cmdIdx < cwdIdx, 'cwd should come after command');
});

test('buildNestedToml: enabled_tools and disabled_tools', () => {
  const toml = buildNestedToml({
    srv: {
      command: 'node',
      args: ['server.js'],
      enabled_tools: ['tool_a', 'tool_b'],
      disabled_tools: ['tool_c'],
    },
  });
  assert.match(toml, /enabled_tools = \[/);
  assert.match(toml, /disabled_tools = \[/);
  assert.match(toml, /"tool_a"/);
  assert.match(toml, /"tool_c"/);
});

test('buildNestedToml: env_vars array', () => {
  const toml = buildNestedToml({
    srv: { command: 'node', env_vars: ['HOME', 'PATH'] },
  });
  assert.match(toml, /env_vars = \[/);
  assert.match(toml, /"HOME"/);
  assert.match(toml, /"PATH"/);
});

test('buildNestedToml: required field', () => {
  const toml = buildNestedToml({
    srv: { command: 'node', required: true },
  });
  assert.match(toml, /required = true/);
});

test('buildNestedToml: timeout fields', () => {
  const toml = buildNestedToml({
    srv: {
      command: 'node',
      startup_timeout_sec: 30,
      startup_timeout_ms: 5000,
      tool_timeout_sec: 60,
    },
  });
  assert.match(toml, /startup_timeout_sec = 30/);
  assert.match(toml, /startup_timeout_ms = 5[_,]?000/);
  assert.match(toml, /tool_timeout_sec = 60/);
});

test('buildNestedToml: env_http_headers as inline table', () => {
  const toml = buildNestedToml({
    srv: {
      url: 'https://example.com',
      env_http_headers: { Authorization: 'AUTH_TOKEN_VAR', 'X-Api-Key': 'API_KEY_VAR' },
    },
  });
  assert.match(toml, /env_http_headers = \{/);
  assert.match(toml, /"Authorization".*"AUTH_TOKEN_VAR"/);
  assert.match(toml, /"X-Api-Key".*"API_KEY_VAR"/);
});

// ---------------------------------------------------------------------------
// buildNestedToml: type and enabled are excluded
// ---------------------------------------------------------------------------

test('buildNestedToml: type and enabled fields are excluded', () => {
  const toml = buildNestedToml({
    srv: {
      command: 'node',
      type: 'stdio',
      enabled: true,
    },
  });
  assert.match(toml, /command = "node"/);
  // type and enabled should NOT appear
  const lines = toml.split('\n');
  assert.ok(!lines.some((l) => /^type\s*=/.test(l)), 'type should be excluded');
  assert.ok(!lines.some((l) => /^enabled\s*=/.test(l)), 'enabled should be excluded');
});

// ---------------------------------------------------------------------------
// buildNestedToml: unknown keys are passed through alphabetically
// ---------------------------------------------------------------------------

test('buildNestedToml: unknown keys passed through alphabetically', () => {
  const toml = buildNestedToml({
    srv: {
      command: 'node',
      zebra_option: 'z',
      alpha_option: 'a',
    },
  });
  assert.match(toml, /alpha_option = "a"/);
  assert.match(toml, /zebra_option = "z"/);
  const alphaIdx = toml.indexOf('alpha_option');
  const zebraIdx = toml.indexOf('zebra_option');
  assert.ok(alphaIdx < zebraIdx, 'unknown keys should be alphabetical');
});

// ---------------------------------------------------------------------------
// buildNestedToml: multiple servers with blank line separator
// ---------------------------------------------------------------------------

test('buildNestedToml: multiple servers separated by blank line', () => {
  const toml = buildNestedToml({
    first: { command: 'a' },
    second: { command: 'b' },
  });
  const sections = toml.split(/\n\n/);
  assert.ok(sections.length >= 2, 'should have blank line between servers');
  assert.match(sections[0], /\[mcp_servers\.first\]/);
  assert.match(sections[1], /\[mcp_servers\.second\]/);
});

// ---------------------------------------------------------------------------
// buildNestedToml: empty servers produces empty string
// ---------------------------------------------------------------------------

test('buildNestedToml: empty servers produces empty string', () => {
  const toml = buildNestedToml({});
  assert.equal(toml, '');
});

// ---------------------------------------------------------------------------
// buildNestedToml: canonical key order
// ---------------------------------------------------------------------------

test('buildNestedToml: canonical key order is maintained', () => {
  const toml = buildNestedToml({
    srv: {
      // Provide fields in non-canonical order
      tool_timeout_sec: 60,
      url: 'https://example.com',
      command: 'node',
      args: ['server.js'],
      required: true,
      cwd: '/opt',
      env_file: '.env',
      bearer_token_env_var: 'TOKEN',
      startup_timeout_sec: 10,
    },
  });

  const lines = toml.split('\n').filter((l) => l.includes(' = '));
  const keys = lines.map((l) => l.split(' = ')[0].trim());

  // Expected canonical order for the keys present
  const expectedOrder = [
    'command',
    'args',
    'url',
    'cwd',
    'bearer_token_env_var',
    'env_file',
    'required',
    'startup_timeout_sec',
    'tool_timeout_sec',
  ];

  assert.deepEqual(keys, expectedOrder);
});

// ---------------------------------------------------------------------------
// mergeConfig: SSE servers are filtered with warning
// ---------------------------------------------------------------------------

test('mergeConfig: SSE servers are filtered out', () => {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => warnings.push(msg);

  try {
    const result = mergeConfig('', {
      good: { command: 'node', args: ['server.js'] },
      bad_sse: { type: 'sse', url: 'https://example.com/sse' },
    });

    // good server should be present
    assert.match(result, /\[mcp_servers\.good\]/);
    // SSE server should be absent
    assert.ok(!result.includes('bad_sse'));
    // Warning should have been emitted
    assert.ok(warnings.some((w) => w.includes('bad_sse')));
    assert.ok(warnings.some((w) => w.includes('SSE')));
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// mergeConfig: preserves unrelated top-level keys
// ---------------------------------------------------------------------------

test('mergeConfig: preserves unrelated top-level TOML keys', () => {
  const existing = `
model = "o3"
approval_mode = "suggest"

[mcp_servers.old]
command = "old-cmd"
`;

  const result = mergeConfig(existing, {
    newserver: { command: 'new-cmd' },
  });

  // Old top-level keys preserved
  assert.match(result, /model = "o3"/);
  assert.match(result, /approval_mode = "suggest"/);
  // Old mcp_servers replaced
  assert.ok(!result.includes('old-cmd'));
  // New server present
  assert.match(result, /\[mcp_servers\.newserver\]/);
  assert.match(result, /command = "new-cmd"/);
});

// ---------------------------------------------------------------------------
// mergeConfig: empty servers clears mcp_servers section
// ---------------------------------------------------------------------------

test('mergeConfig: empty servers with existing config', () => {
  const existing = `
model = "o3"

[mcp_servers.old]
command = "old-cmd"
`;

  const result = mergeConfig(existing, {});

  assert.match(result, /model = "o3"/);
  assert.ok(!result.includes('mcp_servers'));
  assert.ok(!result.includes('old-cmd'));
});

// ---------------------------------------------------------------------------
// ensureTrustEntry
// ---------------------------------------------------------------------------

test('ensureTrustEntry: adds trust section to empty config', () => {
  const result = ensureTrustEntry('', '/projects/myapp');
  assert.ok(result.changed);
  assert.match(result.content, /\[projects."\/projects\/myapp"\]/);
  assert.match(result.content, /trust_level = "trusted"/);
  assert.equal(result.warning, undefined);
});

test('ensureTrustEntry: adds trust section to existing config', () => {
  const existing = `model = "o3"\napproval_mode = "suggest"\n`;
  const result = ensureTrustEntry(existing, '/projects/myapp');
  assert.ok(result.changed);
  // Preserves existing content
  assert.match(result.content, /model = "o3"/);
  // Adds trust section
  assert.match(result.content, /\[projects."\/projects\/myapp"\]/);
  assert.match(result.content, /trust_level = "trusted"/);
});

test('ensureTrustEntry: no-op when already trusted', () => {
  const existing = `model = "o3"\n\n[projects."/projects/myapp"]\ntrust_level = "trusted"\n`;
  const result = ensureTrustEntry(existing, '/projects/myapp');
  assert.ok(!result.changed);
  assert.equal(result.content, existing);
  assert.equal(result.warning, undefined);
});

test('ensureTrustEntry: warns and skips when explicitly untrusted', () => {
  const existing = `model = "o3"\n\n[projects."/projects/myapp"]\ntrust_level = "untrusted"\n`;
  const result = ensureTrustEntry(existing, '/projects/myapp');
  assert.ok(!result.changed);
  assert.equal(result.content, existing);
  assert.ok(result.warning?.includes('untrusted'));
  assert.ok(result.warning?.includes('not overriding'));
});

test('ensureTrustEntry: handles unparseable config gracefully', () => {
  const broken = `[[[invalid toml`;
  const result = ensureTrustEntry(broken, '/projects/myapp');
  assert.ok(!result.changed);
  assert.equal(result.content, broken);
});
