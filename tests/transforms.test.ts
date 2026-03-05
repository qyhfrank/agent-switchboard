import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyDefaults,
  envMapToKvArray,
  joinFields,
  keyedArrayToRecord,
  kvArrayToEnvMap,
  omitFields,
  pickFields,
  recordToKeyedArray,
  renameFields,
  transformFrontmatter,
  transformMcpServers,
} from '../src/targets/dsl/transforms.js';

// ---------------------------------------------------------------------------
// recordToKeyedArray / keyedArrayToRecord
// ---------------------------------------------------------------------------

test('recordToKeyedArray converts record to array with key field', () => {
  const record = {
    'my-server': { command: 'node', args: ['server.js'] },
    other: { command: 'python' },
  };
  const result = recordToKeyedArray(record, 'name');
  assert.deepEqual(result, [
    { name: 'my-server', command: 'node', args: ['server.js'] },
    { name: 'other', command: 'python' },
  ]);
});

test('keyedArrayToRecord reverses recordToKeyedArray', () => {
  const array = [
    { name: 'my-server', command: 'node' },
    { name: 'other', command: 'python' },
  ];
  const result = keyedArrayToRecord(array, 'name');
  assert.deepEqual(result, {
    'my-server': { command: 'node' },
    other: { command: 'python' },
  });
});

test('keyedArrayToRecord skips items without key field', () => {
  const array = [{ command: 'node' }, { name: 'ok', command: 'python' }];
  const result = keyedArrayToRecord(array, 'name');
  assert.deepEqual(result, { ok: { command: 'python' } });
});

// ---------------------------------------------------------------------------
// envMapToKvArray / kvArrayToEnvMap
// ---------------------------------------------------------------------------

test('envMapToKvArray converts flat map to kv-array', () => {
  const env = { API_KEY: 'secret', PORT: '3000' };
  const result = envMapToKvArray(env);
  assert.deepEqual(result, [
    { key: 'API_KEY', value: 'secret' },
    { key: 'PORT', value: '3000' },
  ]);
});

test('envMapToKvArray with custom field names', () => {
  const env = { API_KEY: 'secret' };
  const result = envMapToKvArray(env, 'k', 'v');
  assert.deepEqual(result, [{ k: 'API_KEY', v: 'secret' }]);
});

test('kvArrayToEnvMap reverses envMapToKvArray', () => {
  const array = [
    { key: 'API_KEY', value: 'secret' },
    { key: 'PORT', value: '3000' },
  ];
  const result = kvArrayToEnvMap(array);
  assert.deepEqual(result, { API_KEY: 'secret', PORT: '3000' });
});

// ---------------------------------------------------------------------------
// renameFields / omitFields / pickFields
// ---------------------------------------------------------------------------

test('renameFields renames specified keys', () => {
  const obj = { allowed_tools: ['Read'], description: 'test' };
  const result = renameFields(obj, { allowed_tools: 'allowed-tools' });
  assert.deepEqual(result, { 'allowed-tools': ['Read'], description: 'test' });
});

test('renameFields passes through unmatched keys', () => {
  const obj = { a: 1, b: 2 };
  const result = renameFields(obj, { c: 'd' });
  assert.deepEqual(result, { a: 1, b: 2 });
});

test('omitFields removes specified keys', () => {
  const obj = { a: 1, b: 2, c: 3 };
  const result = omitFields(obj, ['b']);
  assert.deepEqual(result, { a: 1, c: 3 });
});

test('pickFields includes only specified keys', () => {
  const obj = { a: 1, b: 2, c: 3 };
  const result = pickFields(obj, ['a', 'c']);
  assert.deepEqual(result, { a: 1, c: 3 });
});

// ---------------------------------------------------------------------------
// applyDefaults / joinFields
// ---------------------------------------------------------------------------

test('applyDefaults sets missing fields', () => {
  const obj = { a: 1 };
  const result = applyDefaults(obj, { a: 99, b: 2 });
  assert.deepEqual(result, { a: 1, b: 2 });
});

test('joinFields converts arrays to delimited strings', () => {
  const obj = { tools: ['Read', 'Write'], name: 'test' };
  const result = joinFields(obj, { tools: ',' });
  assert.deepEqual(result, { tools: 'Read,Write', name: 'test' });
});

test('joinFields ignores non-array values', () => {
  const obj = { tools: 'already-string' };
  const result = joinFields(obj, { tools: ',' });
  assert.deepEqual(result, { tools: 'already-string' });
});

// ---------------------------------------------------------------------------
// transformMcpServers
// ---------------------------------------------------------------------------

test('transformMcpServers applies env transform and keyed-array conversion', () => {
  const servers = {
    'my-server': {
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'secret' },
    },
  };
  const result = transformMcpServers(servers, {
    structure: 'keyed-array',
    keyField: 'name',
    envTransform: { keyName: 'key', valueName: 'value' },
    defaults: { type: 'stdio' },
  });
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [
    {
      name: 'my-server',
      command: 'node',
      args: ['server.js'],
      env: [{ key: 'API_KEY', value: 'secret' }],
      type: 'stdio',
    },
  ]);
});

test('transformMcpServers returns record when structure is record', () => {
  const servers = { s1: { command: 'cmd' } };
  const result = transformMcpServers(servers, { structure: 'record' });
  assert.ok(!Array.isArray(result));
  assert.deepEqual(result, { s1: { command: 'cmd' } });
});

test('transformMcpServers does not transform env when already an array', () => {
  const servers = {
    s1: { command: 'cmd', env: [{ key: 'K', value: 'V' }] },
  };
  const result = transformMcpServers(servers, {
    structure: 'record',
    envTransform: {},
  });
  const s = (result as Record<string, Record<string, unknown>>).s1;
  assert.deepEqual(s.env, [{ key: 'K', value: 'V' }]);
});

// ---------------------------------------------------------------------------
// transformFrontmatter
// ---------------------------------------------------------------------------

test('transformFrontmatter applies full pipeline: defaults, join, omit, rename', () => {
  const fm = { allowed_tools: ['Read', 'Write'], description: 'test', internal: 'skip' };
  const result = transformFrontmatter(fm, {
    defaults: { model: 'gpt-4' },
    join: { allowed_tools: ',' },
    omit: ['internal'],
    rename: { allowed_tools: 'allowed-tools' },
  });
  assert.deepEqual(result, {
    'allowed-tools': 'Read,Write',
    description: 'test',
    model: 'gpt-4',
  });
});

test('transformFrontmatter with include instead of omit', () => {
  const fm = { a: 1, b: 2, c: 3 };
  const result = transformFrontmatter(fm, { include: ['a', 'c'] });
  assert.deepEqual(result, { a: 1, c: 3 });
});
