import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../src/engine/apps.js';
import { runExplain, runImport, runSync } from '../src/engine/cli.js';
import {
  renderClaudeAgent,
  renderClaudeCommand,
  renderCodexAgent,
  renderCursorAgent,
  renderCursorCommand,
  renderGeminiCommand,
  renderOpencodeAgent,
} from '../src/engine/dialects.js';
import { type Component, scanLibrary } from '../src/engine/library.js';
import { hashContent } from '../src/engine/shapes.js';
import { installApps, seedTree, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

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

test('commands and agents are first-class library components', async () => {
  await withScratchHomes(async (homes) => {
    seedTree(homes.asbHome, {
      'commands/docs.md':
        '---\ndescription: Generate docs\nextras:\n  cursor:\n    model: fast\n---\nWrite docs.\n',
      'agents/reviewer.markdown':
        '---\ndescription: Review changes\nmodel: precise\n---\nFind defects.\n',
    });

    const inventory = scanLibrary();
    const byKey = new Map(
      inventory.components.map((entry) => [`${entry.type}:${entry.id}`, entry])
    );

    const docs = byKey.get('commands:docs');
    assert.equal(docs?.path, path.join(homes.asbHome, 'commands', 'docs.md'));
    assert.equal(docs?.content, 'Write docs.\n');
    assert.equal(docs?.metadata.description, 'Generate docs');
    assert.deepEqual(docs?.metadata.extras, { cursor: { model: 'fast' } });
    assert.equal(
      byKey.get('agents:reviewer')?.path,
      path.join(homes.asbHome, 'agents', 'reviewer.markdown')
    );
    assert.equal(byKey.get('agents:reviewer')?.metadata.model, 'precise');
    assert.deepEqual(inventory.failed, []);
  });
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

test('commands and agents obey the active app set and per-app selection overrides', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    seedTree(homes.asbHome, {
      'commands/build.md': 'Build.\n',
      'agents/reviewer.md': 'Review.\n',
    });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code", "cursor"]',
        '',
        '[commands]',
        'enabled = ["build"]',
        '',
        '[agents]',
        'enabled = ["reviewer"]',
        '',
        '[applications.cursor.commands]',
        'enabled = []',
        '',
        '[applications.cursor.agents]',
        'remove = ["reviewer"]',
      ].join('\n')
    );

    const report = await runSync({ dryRun: true });
    assert.ok(report.entries.some((row) => row.app === 'claude-code' && row.id === 'build'));
    assert.ok(report.entries.some((row) => row.app === 'claude-code' && row.id === 'reviewer'));
    assert.equal(
      report.entries.some((row) => row.app === 'cursor' && row.id === 'build'),
      false,
      'an empty per-app enabled list plans nothing for that app'
    );
    assert.equal(
      report.entries.some((row) => row.app === 'cursor' && row.id === 'reviewer'),
      false,
      'a per-app remove strips the id from that app alone'
    );
  });
});

test('every built-in command and agent importer round-trips through its AppRow dialect', async () => {
  await withScratchHomes(async (homes) => {
    const commandSources = new Map<string, string>([
      ['claude-code', '---\ndescription: Claude command\nmodel: opus\n---\nBODY-claude-code\n'],
      ['codex', 'BODY-codex\n'],
      ['cursor', 'BODY-cursor\n'],
      [
        'gemini',
        'prompt = "BODY-gemini\\n"\ndescription = "Gemini command"\ncustom_field = "kept"\n',
      ],
      ['opencode', '---\ndescription: OpenCode command\nmodel: test-model\n---\nBODY-opencode\n'],
    ]);
    const agentSources = new Map<string, string>([
      [
        'claude-code',
        '---\ndescription: Claude agent\nmodel: opus\ntools: [Read]\n---\nBODY-claude-code\n',
      ],
      ['codex', 'model = "gpt-test"\ndeveloper_instructions = "BODY-codex\\n"\n'],
      [
        'cursor',
        '---\ndescription: Cursor agent\nreadonly: true\nignored: drop\n---\nBODY-cursor\n',
      ],
      ['opencode', '---\ndescription: OpenCode agent\nmode: subagent\n---\nBODY-opencode\n'],
    ]);

    for (const [type, sources] of [
      ['commands', commandSources],
      ['agents', agentSources],
    ] as const) {
      for (const [app, content] of sources) {
        const row = APP_ROWS.find((candidate) => candidate.id === app)?.[type];
        assert.ok(row?.importer);
        const extension = row.importer.extensions[0] as string;
        seedTree(row.dir(homes), { [`${app}${extension}`]: content });
        const result = await runImport(app, undefined, {
          types: [type],
          recursive: true,
          force: true,
        });
        assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
      }
    }

    const inventory = scanLibrary();
    for (const [type, sources] of [
      ['commands', commandSources],
      ['agents', agentSources],
    ] as const) {
      for (const app of sources.keys()) {
        const imported = inventory.components.find(
          (candidate) => candidate.type === type && candidate.id === app
        );
        assert.ok(imported, `${type}:${app}`);
        assert.ok(
          (imported.metadata.extras as Record<string, unknown> | undefined)?.[app] !== undefined,
          `${type}:${app} keeps app-native fields under extras.${app}`
        );
        const row = APP_ROWS.find((candidate) => candidate.id === app)?.[type];
        assert.match(row?.render(imported) ?? '', new RegExp(`BODY-${app}`));
      }
    }
  });
});

test('explain completes command and agent slices with source, owner, and all hashes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/build.md': '---\ndescription: Build\n---\nBuild it.\n',
      'agents/reviewer.md': '---\ndescription: Review\n---\nReview it.\n',
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["build"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );
    await runSync();

    for (const [id, source] of [
      ['build', path.join(homes.asbHome, 'commands', 'build.md')],
      ['reviewer', path.join(homes.asbHome, 'agents', 'reviewer.md')],
    ] as const) {
      const { slices } = await runExplain(id);
      assert.equal(slices.length, 1, JSON.stringify(slices, null, 2));
      const [slice] = slices;
      assert.equal(slice.provenance, 'identity');
      assert.equal(slice.currentHash, slice.desiredHash);
      assert.equal(slice.desiredHash, hashContent(slice.desired as string));
      assert.deepEqual(slice.sources, [{ id, source: 'library', path: source }]);
    }
  });
});
