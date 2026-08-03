import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../../src/engine/apps.js';
import {
  encodeComponentId,
  renderClaudeAgent,
  renderClaudeCommand,
  renderCodexAgent,
  renderCursorAgent,
  renderCursorCommand,
  renderGeminiCommand,
  renderOpencodeAgent,
} from '../../src/engine/dialects.js';
import type { Component } from '../../src/engine/library.js';

function component(
  type: 'commands' | 'agents',
  id: string,
  content: string,
  metadata: Record<string, unknown> = {}
): Component {
  return {
    type,
    id,
    source: 'library',
    path: `/library/${type}/${id}.md`,
    content,
    metadata: { tags: [], requires: [], ...metadata },
  };
}

test('the shared filename encoder is Windows-safe and rows use it', () => {
  assert.equal(encodeComponentId('pack@shop:review/a'), 'pack-shop-review-a');
  assert.equal(encodeComponentId('plain._-9'), 'plain._-9');

  const byId = new Map(APP_ROWS.map((row) => [row.id, row]));
  assert.equal(byId.get('claude-code')?.commands?.filename('pack:docs'), 'pack-docs.md');
  assert.equal(byId.get('codex')?.agents?.filename('pack:reviewer'), 'pack-reviewer.toml');
  assert.equal(byId.get('gemini')?.commands?.filename('pack:docs'), 'pack-docs.toml');
});

test('builtin command dialects preserve their platform contracts', () => {
  const entry = component('commands', 'docs', '\nWrite docs.\n', {
    description: 'Generate docs',
    extras: { 'claude-code': { model: 'sonnet' }, gemini: { model: 'gemini-pro' } },
  });

  assert.equal(
    renderClaudeCommand(entry),
    '---\ndescription: Generate docs\nmodel: sonnet\n---\n\nWrite docs.\n'
  );
  assert.equal(renderCursorCommand(entry), '\nWrite docs.\n');
  assert.deepEqual(parseToml(renderGeminiCommand(entry)), {
    prompt: 'Write docs.\n',
    description: 'Generate docs',
    model: 'gemini-pro',
  });
});

test('builtin agent dialects apply passthrough, allowlist, and defaults exactly', () => {
  const claude = component('agents', 'reviewer', 'Review.\n', {
    description: 'Review changes',
    model: 'global-model',
    extras: { 'claude-code': { model: 'override-model' } },
  });
  assert.match(renderClaudeAgent(claude), /name: reviewer/);
  assert.match(renderClaudeAgent(claude), /model: override-model/);

  const cursor = component('agents', 'reviewer', 'Review.\n', {
    description: 'Review changes',
    extras: { cursor: { readonly: true, unsupported: 'drop-me' } },
  });
  const cursorText = renderCursorAgent(cursor);
  assert.match(cursorText, /name: reviewer/);
  assert.match(cursorText, /model: inherit/);
  assert.match(cursorText, /readonly: true/);
  assert.doesNotMatch(cursorText, /unsupported/);

  const opencode = component('agents', 'reviewer', 'Review.\n', {
    description: 'Review changes',
    model: 'must-not-pass',
  });
  assert.doesNotMatch(renderOpencodeAgent(opencode), /model:/);
});

test('codex agents require extras.codex and render a managed role plus addressed keys', () => {
  const generic = component('agents', 'reviewer', 'Review.\n', { description: 'Review changes' });
  assert.equal(renderCodexAgent(generic), null);

  const role = component('agents', 'pack:reviewer', '  Review carefully.  \n', {
    description: 'Review changes',
    extras: {
      codex: {
        model: 'gpt-test',
        model_reasoning_effort: 'high',
        unknown: 'drop-me',
      },
    },
  });
  assert.equal(
    renderCodexAgent(role),
    'model = "gpt-test"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "Review carefully."\n'
  );

  const row = APP_ROWS.find((candidate) => candidate.id === 'codex')?.agents;
  const config = row?.config?.component(role, row.filename(role.id));
  assert.deepEqual(config?.keyPath, ['agents', 'pack:reviewer']);
  assert.deepEqual(config?.value, {
    description: 'Review changes',
    config_file: 'agents/pack-reviewer.toml',
  });
  assert.deepEqual(row?.config?.activation, {
    keyPath: ['features', 'multi_agent'],
    value: true,
  });
});
