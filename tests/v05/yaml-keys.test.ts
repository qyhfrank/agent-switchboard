import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyKeysEdits,
  keyedArraySegment,
  parseStructured,
  valueAtKeyPath,
} from '../../src/engine/shapes.js';

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

test('yaml: keyed-array identity segments update and remove exactly one member', () => {
  const alpha = keyedArraySegment('mcp_servers', 'name', 'plugin:alpha@shop');
  assert.equal(alpha, '@array:mcp_servers[name=plugin%3Aalpha%40shop]');
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
});

test('yaml: missing and duplicate keyed-array identities fail closed', () => {
  const alpha = keyedArraySegment('mcp_servers', 'name', 'alpha');
  const missing = 'mcp_servers:\n  - command: npx\n';
  const duplicate =
    'mcp_servers:\n  - name: alpha\n    command: one\n  - name: alpha\n    command: two\n';

  assert.throws(
    () => applyKeysEdits(missing, 'yaml', [{ keyPath: [alpha], remove: true }]),
    /mcp_servers.*missing identity field "name"/
  );
  assert.throws(
    () => applyKeysEdits(duplicate, 'yaml', [{ keyPath: [alpha], remove: true }]),
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
