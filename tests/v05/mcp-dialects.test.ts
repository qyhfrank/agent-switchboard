import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../../src/engine/apps.js';
import {
  codexServer,
  geminiServer,
  inferServerType,
  opencodeServer,
  renderCodexTable,
  sanitizeMcpName,
  traeServer,
} from '../../src/engine/dialects.js';
import {
  applyKeysEdits,
  type KeysEdit,
  keyedArraySegment,
  parseStructured,
  sliceHash,
  valueAtKeyPath,
} from '../../src/engine/shapes.js';

/**
 * The MCP value transforms and the keys-shape writer, as pure functions.
 *
 * Carried from 0.4.35: the 14 `buildNestedToml` cases
 * (`tests/codex-toml.test.ts`), `mapServerForGemini` (`src/agents/gemini.ts`),
 * the opencode local/remote mapping (`tests/opencode-adapter.test.ts`),
 * `sanitizeMcpName` and the load-time type inference
 * (`tests/mcp-config-infer.test.ts`). New here: the byte-splice TOML writer
 * and the jsonc JSON writer that replace 0.4's whole-file re-serialization,
 * including the failure 0.4 turned into whole-document loss (quarry R-3).
 */

const CODEX_KEYS = ['mcp_servers', 'srv'];

function codexToml(server: Record<string, unknown>): string {
  const value = codexServer(server);
  assert.ok(value !== null, 'server should render');
  return renderCodexTable(CODEX_KEYS, value);
}

// ---------------------------------------------------------------------------
// Codex TOML rendering (14 carried cases)
// ---------------------------------------------------------------------------

test('codex: stdio server renders command, args, and alphabetical dotted env', () => {
  const toml = renderCodexTable(['mcp_servers', 'myserver'], {
    ...(codexServer({
      command: 'npx',
      args: ['-y', '@my/server'],
      env: { DEBUG: 'true', API_KEY: 'secret' },
    }) as Record<string, unknown>),
  });

  assert.match(toml, /\[mcp_servers\.myserver\]/);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /args = \[ "-y", "@my\/server" \]/);
  assert.match(toml, /env\.API_KEY = "secret"/);
  assert.match(toml, /env\.DEBUG = "true"/);
  assert.ok(toml.indexOf('env.API_KEY') < toml.indexOf('env.DEBUG'), 'env keys are alphabetical');
});

test('codex: http server renders url and an http_headers inline table', () => {
  const toml = codexToml({
    url: 'https://example.com/mcp',
    http_headers: { 'X-Custom': 'val', Authorization: 'Bearer tok123' },
  });

  assert.match(toml, /url = "https:\/\/example\.com\/mcp"/);
  assert.match(toml, /http_headers = \{ "Authorization" = "Bearer tok123", "X-Custom" = "val" \}/);
  assert.ok(!toml.includes('command ='));
});

test('codex: generic headers are renamed to http_headers', () => {
  const toml = codexToml({ url: 'https://example.com', headers: { 'X-Token': 'abc' } });

  assert.match(toml, /http_headers = \{ "X-Token" = "abc" \}/);
  assert.equal(
    toml.split('\n').filter((line) => /^headers\s*=/.test(line)).length,
    0,
    'the raw headers key never appears'
  );
});

test('codex: an explicit http_headers wins over headers', () => {
  const toml = codexToml({
    url: 'https://example.com',
    headers: { 'X-Old': 'old' },
    http_headers: { 'X-New': 'new' },
  });

  assert.match(toml, /"X-New" = "new"/);
  assert.ok(!toml.includes('X-Old'));
});

test('codex: bearer_token_env_var is emitted', () => {
  assert.match(
    codexToml({ url: 'https://example.com', bearer_token_env_var: 'MY_TOKEN' }),
    /bearer_token_env_var = "MY_TOKEN"/
  );
});

test('codex: cwd follows command in canonical order', () => {
  const toml = codexToml({ command: 'node', args: ['server.js'], cwd: '/opt/app' });
  assert.match(toml, /cwd = "\/opt\/app"/);
  assert.ok(toml.indexOf('command =') < toml.indexOf('cwd ='));
});

test('codex: enabled_tools and disabled_tools are emitted as arrays', () => {
  const toml = codexToml({
    command: 'node',
    args: ['server.js'],
    enabled_tools: ['tool_a', 'tool_b'],
    disabled_tools: ['tool_c'],
  });
  assert.match(toml, /enabled_tools = \[ "tool_a", "tool_b" \]/);
  assert.match(toml, /disabled_tools = \[ "tool_c" \]/);
});

test('codex: env_vars renders as an array', () => {
  const toml = codexToml({ command: 'node', env_vars: ['HOME', 'PATH'] });
  assert.match(toml, /env_vars = \[ "HOME", "PATH" \]/);
});

test('codex: required renders as a boolean', () => {
  assert.match(codexToml({ command: 'node', required: true }), /required = true/);
});

test('codex: timeout fields keep their numeric form', () => {
  const toml = codexToml({
    command: 'node',
    startup_timeout_sec: 30,
    startup_timeout_ms: 5000,
    tool_timeout_sec: 60,
  });
  assert.match(toml, /startup_timeout_sec = 30/);
  assert.match(toml, /startup_timeout_ms = 5[_,]?000/);
  assert.match(toml, /tool_timeout_sec = 60/);
});

test('codex: env_http_headers renders as a sorted inline table', () => {
  const toml = codexToml({
    url: 'https://example.com',
    env_http_headers: { 'X-Api-Key': 'API_KEY_VAR', Authorization: 'AUTH_TOKEN_VAR' },
  });
  assert.match(
    toml,
    /env_http_headers = \{ "Authorization" = "AUTH_TOKEN_VAR", "X-Api-Key" = "API_KEY_VAR" \}/
  );
});

test('codex: type and enabled are never emitted', () => {
  const lines = codexToml({ command: 'node', type: 'stdio', enabled: true }).split('\n');
  assert.ok(lines.some((line) => /^command = "node"/.test(line)));
  assert.ok(!lines.some((line) => /^type\s*=/.test(line)), 'type is excluded');
  assert.ok(!lines.some((line) => /^enabled\s*=/.test(line)), 'enabled is excluded');
});

test('codex: unknown keys are emitted last, alphabetically', () => {
  const toml = codexToml({ command: 'node', zebra_option: 'z', alpha_option: 'a' });
  assert.match(toml, /alpha_option = "a"/);
  assert.match(toml, /zebra_option = "z"/);
  assert.ok(toml.indexOf('alpha_option') < toml.indexOf('zebra_option'));
  assert.ok(toml.indexOf('command') < toml.indexOf('alpha_option'), 'known keys come first');
});

test('codex: canonical key order holds however the definition is written', () => {
  const toml = codexToml({
    tool_timeout_sec: 60,
    url: 'https://example.com',
    command: 'node',
    args: ['server.js'],
    required: true,
    cwd: '/opt',
    env_file: '.env',
    bearer_token_env_var: 'TOKEN',
    startup_timeout_sec: 10,
  });

  const keys = toml
    .split('\n')
    .filter((line) => line.includes(' = '))
    .map((line) => line.split(' = ')[0].trim());

  assert.deepEqual(keys, [
    'command',
    'args',
    'url',
    'cwd',
    'bearer_token_env_var',
    'env_file',
    'required',
    'startup_timeout_sec',
    'tool_timeout_sec',
  ]);
});

test('codex: an sse server renders as nothing at all', () => {
  assert.equal(codexServer({ type: 'sse', url: 'https://example.com/sse' }), null);
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
  const value = codexServer({
    command: 'npx',
    args: ['-y', 'srv'],
    type: 'stdio',
    headers: { B: '2', A: '1' },
    env: { Z: '9', A: '1' },
    startup_timeout_sec: 5,
    'weird key': 'x',
  }) as Record<string, unknown>;

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

// ---------------------------------------------------------------------------
// Gemini, opencode, trae, sanitize, inference
// ---------------------------------------------------------------------------

test('gemini: http renames url to httpUrl and drops type', () => {
  assert.deepEqual(geminiServer({ type: 'http', url: 'https://example.com', timeout: 10 }), {
    httpUrl: 'https://example.com',
    timeout: 10,
  });
});

test('gemini: sse and untyped url-only servers keep url and drop type', () => {
  assert.deepEqual(geminiServer({ type: 'sse', url: 'https://example.com' }), {
    url: 'https://example.com',
  });
  assert.deepEqual(geminiServer({ url: 'https://example.com' }), { url: 'https://example.com' });
});

test('gemini: everything else is stdio with command, args, and env', () => {
  assert.deepEqual(
    geminiServer({ type: 'stdio', command: 'npx', args: ['a'], env: { K: 'v' }, extra: 1 }),
    { command: 'npx', args: ['a'], env: { K: 'v' }, extra: 1 }
  );
});

test('opencode: a local server becomes an argv array with environment and enabled', () => {
  assert.deepEqual(
    opencodeServer({ type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'v' } }),
    { type: 'local', command: ['npx', '-y', 'srv'], environment: { K: 'v' }, enabled: true }
  );
});

test('opencode: a remote server keeps url and headers and drops command keys', () => {
  assert.deepEqual(
    opencodeServer({ type: 'http', url: 'https://example.com', headers: { A: 'b' }, command: 'x' }),
    { type: 'remote', url: 'https://example.com', headers: { A: 'b' }, enabled: true }
  );
});

test('trae: the rendered value carries no type at all', () => {
  assert.deepEqual(traeServer({ type: 'stdio', command: 'npx', args: ['a'] }), {
    command: 'npx',
    args: ['a'],
  });
});

test('sanitizeMcpName rewrites everything outside [a-zA-Z0-9_-]', () => {
  assert.equal(sanitizeMcpName('my-plugin@mkt:remote-api'), 'my-plugin-mkt-remote-api');
  assert.equal(sanitizeMcpName('plain_name-1'), 'plain_name-1');
});

test('type inference fills http from url and stdio from command, never overriding', () => {
  assert.equal(inferServerType({ url: 'https://example.com' }).type, 'http');
  assert.equal(inferServerType({ command: 'npx' }).type, 'stdio');
  assert.equal(inferServerType({ type: 'sse', url: 'https://example.com' }).type, 'sse');
  assert.equal(inferServerType({ args: ['a'] }).type, undefined);
});

// ---------------------------------------------------------------------------
// The keys-shape writers
// ---------------------------------------------------------------------------

test('json: an edit preserves comments, indentation, and every other key', () => {
  const source = [
    '{',
    '    // the theme I picked',
    '    "theme": "dark",',
    '    "mcpServers": {',
    '        "beta": {',
    '            "command": "b"',
    '        }',
    '    },',
    '    "other": [1, 2]',
    '}',
    '',
  ].join('\n');

  const content = applyKeysEdits(source, 'json', [
    { keyPath: ['mcpServers', 'alpha'], value: { command: 'npx' } },
  ]);

  assert.match(content, /\/\/ the theme I picked/);
  assert.match(content, /"theme": "dark"/);
  assert.match(content, /"other": \[1, 2\]/);
  assert.match(content, /^ {4}"mcpServers"/m, 'the file keeps its own indentation');
  const root = parseStructured(content, 'json').root;
  assert.deepEqual(valueAtKeyPath(root, ['mcpServers', 'alpha']), { command: 'npx' });
  assert.deepEqual(valueAtKeyPath(root, ['mcpServers', 'beta']), { command: 'b' });
});

test('json: replacing a value is wholesale, so a stale key is erased', () => {
  const source = '{\n  "mcpServers": {\n    "a": { "command": "x", "type": "stdio" }\n  }\n}\n';
  const content = applyKeysEdits(source, 'json', [
    { keyPath: ['mcpServers', 'a'], value: { command: 'x' } },
  ]);

  assert.deepEqual(valueAtKeyPath(parseStructured(content, 'json').root, ['mcpServers', 'a']), {
    command: 'x',
  });
});

test('json: a removal takes the key and leaves the document', () => {
  const source = '{\n  "keep": 1,\n  "mcpServers": {\n    "a": {},\n    "b": {}\n  }\n}\n';
  const content = applyKeysEdits(source, 'json', [{ keyPath: ['mcpServers', 'a'], remove: true }]);

  const root = parseStructured(content, 'json').root;
  assert.deepEqual(Object.keys(valueAtKeyPath(root, ['mcpServers']) as object), ['b']);
  assert.equal(valueAtKeyPath(root, ['keep']), 1);
});

test('json: an absent host materializes as the managed slice alone', () => {
  const content = applyKeysEdits('', 'json', [
    { keyPath: ['mcpServers', 'a'], value: { command: 'x' } },
  ]);

  assert.equal(content, '{\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n');
});

test('json: keyed-array edits create, append, update, and remove by identity', () => {
  const alpha = keyedArraySegment('servers', 'name', 'alpha');
  const beta = keyedArraySegment('servers', 'name', 'beta');

  for (const source of ['', '{\n  "servers": [],\n  "keep": true\n}\n']) {
    const content = applyKeysEdits(source, 'json', [
      { keyPath: [alpha], value: { name: 'alpha', command: 'one' } },
    ]);
    const root = parseStructured(content, 'json').root;
    assert.deepEqual(valueAtKeyPath(root, [alpha]), { name: 'alpha', command: 'one' });
    assert.equal(root?.[alpha], undefined, 'the address never becomes a literal object key');
  }

  const populated =
    '{\n  "servers": [\n    { "name": "alpha", "command": "old" },\n    { "name": "beta", "command": "keep" }\n  ],\n  "keep": true\n}\n';
  const content = applyKeysEdits(populated, 'json', [
    { keyPath: [alpha], value: { name: 'alpha', command: 'new' } },
    { keyPath: [beta], remove: true },
  ]);
  const root = parseStructured(content, 'json').root;
  assert.deepEqual(valueAtKeyPath(root, [alpha]), { name: 'alpha', command: 'new' });
  assert.equal(valueAtKeyPath(root, [beta]), undefined);
  assert.equal(root?.keep, true);
});

test('a record key that resembles a keyed-array address stays a plain nested key', () => {
  const hostile = '@array:mcp_servers[name=alpha]';
  const root = { mcpServers: { [hostile]: { command: 'user-edited' } } };

  assert.deepEqual(valueAtKeyPath(root, ['mcpServers', hostile]), { command: 'user-edited' });
});

test('toml: a table is replaced in place and everything else keeps its bytes', () => {
  const source = [
    '# my codex config -- hand written',
    'model = "gpt-5.4"          # the model I use',
    '',
    '[model_providers.openai]',
    'name    = "OpenAI"',
    '',
    '[mcp_servers.alpha]',
    'command = "old"',
    '',
    '[history]',
    'persistence = "save-all"',
    '',
  ].join('\n');

  const value = codexServer({ command: 'new' }) as Record<string, unknown>;
  const content = applyKeysEdits(source, 'toml', [
    {
      keyPath: ['mcp_servers', 'alpha'],
      value,
      text: renderCodexTable(['mcp_servers', 'alpha'], value),
    },
  ]);

  assert.match(content, /# my codex config -- hand written/);
  assert.match(content, /model = "gpt-5\.4" {10}# the model I use/);
  assert.match(content, /name {4}= "OpenAI"/);
  assert.match(content, /\[history\]\npersistence = "save-all"/);
  assert.match(content, /\[mcp_servers\.alpha\]\ncommand = "new"\n\n\[history\]/);
});

test('toml: a removal takes only its own table', () => {
  const source =
    'model = "x"\n\n[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.b]\ncommand = "b"\n';
  const content = applyKeysEdits(source, 'toml', [{ keyPath: ['mcp_servers', 'a'], remove: true }]);

  assert.equal(content, 'model = "x"\n\n[mcp_servers.b]\ncommand = "b"\n');
});

test('toml: a bracket inside a multi-line string is not mistaken for a table header', () => {
  const source = [
    'instructions = """',
    '[mcp_servers.fake]',
    'not a table',
    '"""',
    '',
    '[mcp_servers.real]',
    'command = "r"',
    '',
  ].join('\n');

  assert.deepEqual(parseStructured(source, 'toml').tables, [['mcp_servers', 'real']]);
  const content = applyKeysEdits(source, 'toml', [
    { keyPath: ['mcp_servers', 'real'], remove: true },
  ]);
  assert.match(content, /\[mcp_servers\.fake\]/, 'the string body survives');
  assert.equal(parseStructured(content, 'toml').tables.length, 0);
});

test('toml: a nested array element on its own line is not a table header', () => {
  const source = 'matrix = [\n  [1],\n  [2]\n]\n\n[mcp_servers.a]\ncommand = "a"\n';
  assert.deepEqual(parseStructured(source, 'toml').tables, [['mcp_servers', 'a']]);
});

test('toml: a value the writer cannot serialize never takes the document with it', () => {
  // 0.4 parsed config.toml, re-stringified every other top-level key, and on a
  // stringify failure replaced the whole file with the mcp_servers section
  // alone (quarry R-3, reproduced on 0.4.35: a 35KB config became 55 bytes).
  // A deeply nested table is exactly that input; the byte splice never touches
  // it because it never re-serializes what it did not write.
  const deep = Array.from({ length: 6000 }, (_, index) => `k${index}`).join('.');
  const source = `model = "gpt-5.4"\napi_key_helper = "/usr/local/bin/get-key"\n\n[${deep}]\nleaf = 1\n`;

  const value = codexServer({ command: 'npx' }) as Record<string, unknown>;
  const content = applyKeysEdits(source, 'toml', [
    {
      keyPath: ['mcp_servers', 'alpha'],
      value,
      text: renderCodexTable(['mcp_servers', 'alpha'], value),
    },
  ]);

  assert.match(content, /^model = "gpt-5\.4"$/m);
  assert.match(content, /^api_key_helper = "\/usr\/local\/bin\/get-key"$/m);
  assert.match(content, /\[k0\.k1\.k2\./);
  assert.match(content, /\[mcp_servers\.alpha\]\ncommand = "npx"/);
  assert.ok(content.length > source.length, 'the document grew rather than being replaced');
});

test('the slice hash follows the value, not the formatting around it', () => {
  const compact = parseStructured('{"mcpServers":{"a":{"command":"x"}}}', 'json').root;
  const spread = parseStructured(
    '{\n\n  "mcpServers": {\n     "a": {\n        "command": "x"\n     }\n  }\n}\n',
    'json'
  ).root;
  const reordered = parseStructured('{"mcpServers":{"a":{"command":"x","args":[]}}}', 'json').root;

  assert.equal(
    sliceHash(valueAtKeyPath(compact, ['mcpServers', 'a'])),
    sliceHash(valueAtKeyPath(spread, ['mcpServers', 'a']))
  );
  assert.notEqual(
    sliceHash(valueAtKeyPath(compact, ['mcpServers', 'a'])),
    sliceHash(valueAtKeyPath(reordered, ['mcpServers', 'a']))
  );
});

test('an unreadable structured host reports why instead of parsing to nothing', () => {
  assert.equal(parseStructured('{ "a": }', 'json').root, null);
  assert.match(parseStructured('{ "a": }', 'json').error ?? '', /invalid JSON/);
  assert.equal(parseStructured('[1, 2]', 'json').root, null);
  assert.match(parseStructured('[1, 2]', 'json').error ?? '', /root must be an object/);
  assert.equal(parseStructured('this is not = = toml\n', 'toml').root, null);
  assert.equal(parseStructured('', 'json').root !== null, true);
});

test('every TOML row in the table brings the renderer its writer needs', () => {
  for (const row of APP_ROWS) {
    if (row.mcp?.format !== 'toml') continue;
    assert.equal(typeof row.mcp.render, 'function', `${row.id} must render its own tables`);
  }
});

test('the table names one host per app and never two apps per host', () => {
  const rows = APP_ROWS.filter((row) => row.mcp !== undefined);
  assert.equal(rows.length, 9, 'all nine apps take MCP');
  const homes = {
    asbHome: '/tmp/asb',
    agentsHome: '/tmp/home',
    cacheHome: '/tmp/cache',
    stateHome: '/tmp/state',
  };
  const paths = rows.map((row) => (row.mcp as NonNullable<typeof row.mcp>).path(homes));
  assert.equal(new Set(paths).size, paths.length, 'global hosts are distinct');
});

test('a keys edit list is applied in order against the updated text', () => {
  const edits: KeysEdit[] = [
    { keyPath: ['mcpServers', 'a'], value: { command: '1' } },
    { keyPath: ['mcpServers', 'b'], value: { command: '2' } },
    { keyPath: ['mcpServers', 'a'], remove: true },
  ];
  const root = parseStructured(applyKeysEdits('', 'json', edits), 'json').root;
  assert.deepEqual(Object.keys(valueAtKeyPath(root, ['mcpServers']) as object), ['b']);
});

test('codex: an inline table escapes its names and values like every other value', () => {
  // Hand-quoting wrote a backslash, a newline or a quote straight through, so
  // an ordinary Windows path in a header produced TOML codex cannot read.
  const hostile: readonly [string, Record<string, string>][] = [
    ['backslash', { 'X-Path': 'C:\\Users\\me' }],
    ['newline', { 'X-Note': 'line1\nline2' }],
    ['quote in the name', { 'X-"Q"': 'v' }],
  ];

  for (const [label, headers] of hostile) {
    const text = codexToml({ url: 'https://example.invalid/mcp', headers });
    const root = parseToml(text) as { mcp_servers: { srv: { http_headers: unknown } } };
    assert.deepEqual(root.mcp_servers.srv.http_headers, headers, label);
  }
});

test('a TOML parse error keeps the parser position and drops the lines it quotes', () => {
  const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
  const source = [
    '[mcp_servers.private]',
    'command = "my-server"',
    `env.API_TOKEN = "${placeholder}"`,
    'broken here',
    '',
  ].join('\n');

  const document = parseStructured(source, 'toml');

  assert.equal(document.root, null);
  assert.match(document.error ?? '', /row 4/);
  assert.equal(document.error?.includes(placeholder), false, 'no source excerpt');
  assert.equal(document.error?.includes('\n'), false, 'a reason is one line');
});
