import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import {
  applyKeysEdits,
  type KeysEdit,
  keyedArraySegment,
  parseStructured,
  sliceHash,
  valueAtKeyPath,
} from '../src/engine/shapes.js';
import {
  installApps,
  mcpHostPath,
  readMcpHost,
  type ScratchHomes,
  seedMcpLibrary,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The keys writer: every MCP and agent host is a document the user also owns,
 * so a write addresses one slice and leaves every byte around it alone. What
 * the writer cannot address safely it refuses rather than normalizes.
 */

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

  const populated = [
    '{',
    '  "servers": [',
    '    { "name": "alpha", "command": "old" },',
    '    { "name": "beta", "command": "keep" }',
    '  ],',
    '  "keep": true',
    '}',
    '',
  ].join('\n');
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

test('a keys edit list is applied in order against the updated text', () => {
  // Offsets are recomputed per edit, so a later removal wins over an earlier
  // write to the same key path.
  const edits: KeysEdit[] = [
    { keyPath: ['mcpServers', 'a'], value: { command: '1' } },
    { keyPath: ['mcpServers', 'b'], value: { command: '2' } },
    { keyPath: ['mcpServers', 'a'], remove: true },
  ];
  const root = parseStructured(applyKeysEdits('', 'json', edits), 'json').root;

  assert.deepEqual(Object.keys(valueAtKeyPath(root, ['mcpServers']) as object), ['b']);
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

test('toml: a table is replaced in place and everything else keeps its bytes', () => {
  const source = [
    '# my codex config -- hand written',
    'model = "gpt-5-codex"          # the model I use',
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

  const content = applyKeysEdits(source, 'toml', [
    {
      keyPath: ['mcp_servers', 'alpha'],
      value: { command: 'new' },
      text: '[mcp_servers.alpha]\ncommand = "new"',
    },
  ]);

  assert.match(content, /# my codex config -- hand written/);
  assert.match(content, /model = "gpt-5-codex" {10}# the model I use/);
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

test('toml: content the writer could never re-serialize survives a splice untouched', () => {
  // A config whose foreign tables would defeat any parse-and-stringify pass: a
  // writer that re-serialized what it did not write would either fail or
  // replace the whole document with its own slice. The byte splice must leave
  // every foreign byte alone and only grow the document.
  const deep = Array.from({ length: 6000 }, (_, index) => `k${index}`).join('.');
  const source = `model = "gpt-5.4"\napi_key_helper = "/usr/local/bin/get-key"\n\n[${deep}]\nleaf = 1\n`;

  const content = applyKeysEdits(source, 'toml', [
    {
      keyPath: ['mcp_servers', 'alpha'],
      value: { command: 'npx' },
      text: '[mcp_servers.alpha]\ncommand = "npx"\n',
    },
  ]);

  assert.match(content, /^model = "gpt-5\.4"$/m);
  assert.match(content, /^api_key_helper = "\/usr\/local\/bin\/get-key"$/m);
  assert.match(content, /\[k0\.k1\.k2\./);
  assert.match(content, /\[mcp_servers\.alpha\]\ncommand = "npx"/);
  assert.ok(content.length > source.length, 'the document grew rather than being replaced');
});

test('toml: a bracket in a multi-line string or a nested array is not a table header', () => {
  // Real codex configs carry triple-quoted instructions and nested arrays; a
  // line-naive scan would index them as tables and splice through them.
  const source = [
    'instructions = """',
    '[mcp_servers.fake]',
    'not a table',
    '"""',
    'matrix = [',
    '  [1],',
    '  [2]',
    ']',
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
  assert.match(content, /matrix = \[\n {2}\[1\],\n {2}\[2\]\n\]/);
  assert.equal(parseStructured(content, 'toml').tables.length, 0);
});

test('yaml: targeted edits preserve comments, key order, quoting, and nested maps', () => {
  const source = [
    '# user heading',
    'theme: "dark" # beside the key',
    "quoted: 'keep this style'",
    'nested:',
    '  child: yes',
    'mcp_servers:',
    '  - name: beta',
    '    command: old',
    '',
  ].join('\n');
  const alpha = keyedArraySegment('mcp_servers', 'name', 'alpha');

  const content = applyKeysEdits(source, 'yaml', [
    { keyPath: [alpha], value: { name: 'alpha', command: 'npx' } },
  ]);

  assert.match(content, /^# user heading\ntheme: "dark" # beside the key$/m);
  assert.match(content, /^quoted: 'keep this style'$/m);
  assert.match(content, /^nested:\n {2}child: yes$/m);
  assert.deepEqual(valueAtKeyPath(parseStructured(content, 'yaml').root, [alpha]), {
    name: 'alpha',
    command: 'npx',
  });
});

test('yaml: a keyed-array identity edits one member, or fails when it is not unique', () => {
  const alpha = keyedArraySegment('mcp_servers', 'name', 'plugin:alpha@shop');
  const source = [
    'mcp_servers:',
    '  - name: plugin:alpha@shop',
    '    command: old',
    '  - name: foreign',
    '    command: theirs',
    'other: true',
    '',
  ].join('\n');

  const updated = applyKeysEdits(source, 'yaml', [
    { keyPath: [alpha], value: { name: 'plugin:alpha@shop', command: 'new' } },
  ]);
  assert.deepEqual(valueAtKeyPath(parseStructured(updated, 'yaml').root, [alpha]), {
    name: 'plugin:alpha@shop',
    command: 'new',
  });
  assert.match(updated, /name: foreign\n {4}command: theirs/);

  const removed = applyKeysEdits(updated, 'yaml', [{ keyPath: [alpha], remove: true }]);
  assert.equal(valueAtKeyPath(parseStructured(removed, 'yaml').root, [alpha]), undefined);
  assert.match(removed, /name: foreign\n {4}command: theirs/);
  assert.match(removed, /other: true/);

  // Guessing which member was meant is the one thing worse than not writing.
  const plain = keyedArraySegment('mcp_servers', 'name', 'alpha');
  assert.throws(
    () =>
      applyKeysEdits('mcp_servers:\n  - command: npx\n', 'yaml', [
        { keyPath: [plain], remove: true },
      ]),
    /mcp_servers.*missing identity field "name"/
  );
  assert.throws(
    () =>
      applyKeysEdits(
        'mcp_servers:\n  - name: alpha\n    command: one\n  - name: alpha\n    command: two\n',
        'yaml',
        [{ keyPath: [plain], remove: true }]
      ),
    /mcp_servers.*duplicate identity "alpha"/
  );
});

test('yaml: an unmanaged construct that toString normalizes blocks the write', () => {
  const source = 'flow: [a, b]\nmcp_servers: []\n';
  const alpha = keyedArraySegment('mcp_servers', 'name', 'alpha');

  assert.throws(
    () =>
      applyKeysEdits(source, 'yaml', [
        { keyPath: [alpha], value: { name: 'alpha', command: 'npx' } },
      ]),
    /unmanaged YAML would not round-trip byte-identically/
  );
});

test('yaml: malformed input and non-map roots fail instead of becoming empty objects', () => {
  assert.equal(parseStructured('root: [\n', 'yaml').root, null);
  assert.match(parseStructured('root: [\n', 'yaml').error ?? '', /invalid YAML/);
  assert.equal(parseStructured('- one\n- two\n', 'yaml').root, null);
  assert.match(parseStructured('- one\n- two\n', 'yaml').error ?? '', /root must be an object/);
});

/** Write an app's MCP host document with a server map of its own. */
function seedHost(homes: ScratchHomes, servers: Record<string, unknown>): string {
  const filePath = mcpHostPath(homes, 'cursor');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf-8');
  return filePath;
}

test('a customized library server is left behind and reported once on deselection', async () => {
  // The comparator reads the key, not a record of what was written: a slice is
  // asb's while its value is the render. Carrying a user's addition makes it
  // the user's, so deselection reports it rather than removing it.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'npx', args: ['-y', 'alpha'] } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = []\n');
    const customized = {
      command: 'npx',
      args: ['-y', 'alpha'],
      type: 'stdio',
      env: { TOKEN: 'mine' },
    };
    seedHost(homes, { alpha: customized });

    const report = await runSync({});

    assert.deepEqual(readMcpHost(homes, 'cursor')?.alpha, customized);
    const rows = report.entries.filter((entry) => entry.type === 'mcp' && entry.id === 'alpha');
    assert.equal(rows.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(rows[0].outcome, 'left-behind');
    assert.equal(rows[0].detail, 'modified');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});
