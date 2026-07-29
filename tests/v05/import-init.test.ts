import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { parseCliArgs, runImport, runInit } from '../../src/engine/cli.js';
import { renderGeminiCommand } from '../../src/engine/dialects.js';
import { scanLibrary } from '../../src/engine/library.js';
import { savePeerState } from '../../src/engine/peer.js';
import { installApps, withScratchHomes } from './helpers/scratch.js';

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

test('the unified import CLI carries app, type, recursion, and force', () => {
  assert.deepEqual(parseCliArgs(['import', 'gemini', '--type', 'commands', '-r', '-f']), {
    command: 'import',
    app: 'gemini',
    path: undefined,
    options: { types: ['commands'], recursive: true, force: true, json: false },
  });
});

test('Gemini import preserves unknown fields and keeps batch successes on failure', async () => {
  await withScratchHomes(async (homes) => {
    const source = path.join(homes.agentsHome, '.gemini', 'commands');
    write(
      path.join(source, 'good.toml'),
      'prompt = "Do it"\ndescription = "Useful"\ncustom_field = "kept"\n'
    );
    write(path.join(source, 'bad.toml'), 'prompt = "unterminated\n');

    const result = await runImport('gemini', undefined, {
      types: ['commands'],
      recursive: true,
      force: true,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.entries.filter((entry) => entry.outcome === 'written').length, 1);
    assert.equal(result.entries.filter((entry) => entry.outcome === 'failed').length, 1);

    const component = scanLibrary().components.find(
      (entry) => entry.type === 'commands' && entry.id === 'good'
    );
    assert.ok(component);
    assert.deepEqual(parseToml(renderGeminiCommand(component)), {
      prompt: 'Do it',
      description: 'Useful',
      custom_field: 'kept',
    });
  });
});

test('no-type import uses every app reader and existing files skip unless forced', async () => {
  await withScratchHomes(async (homes) => {
    const claude = path.join(homes.agentsHome, '.claude');
    write(
      path.join(claude, 'commands', 'ship.md'),
      '---\ndescription: Ship\nargument-hint: branch\n---\nRun it.\n'
    );
    write(
      path.join(claude, 'agents', 'review.md'),
      '---\ndescription: Review\nmodel: opus\npermissionMode: plan\n---\nReview it.\n'
    );
    write(
      path.join(claude, 'skills', 'lint', 'SKILL.md'),
      '---\nname: lint\ndescription: Lint files\n---\nLint.\n'
    );
    const managed = { hooks: [{ type: 'command', command: 'echo managed' }] };
    const user = { hooks: [{ type: 'command', command: 'echo user' }] };
    write(
      path.join(claude, 'settings.json'),
      `${JSON.stringify({ hooks: { PreToolUse: [managed, user] } })}\n`
    );
    savePeerState(homes.asbHome, 'claude-code', {
      version: 1,
      events: { PreToolUse: [managed] },
      bundles: [],
      legacyBundles: [],
    });

    const first = await runImport('claude-code', undefined, { recursive: true, force: true });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries));
    assert.deepEqual(
      new Set(
        first.entries.filter((entry) => entry.outcome === 'written').map((entry) => entry.type)
      ),
      new Set(['commands', 'agents', 'skills', 'hooks'])
    );
    const inventory = scanLibrary();
    assert.equal(
      (
        inventory.components.find((entry) => entry.type === 'commands')?.metadata.extras as Record<
          string,
          unknown
        >
      )?.['claude-code'] instanceof Object,
      true
    );
    assert.equal(
      (
        inventory.components.find((entry) => entry.type === 'agents')?.metadata.extras as Record<
          string,
          Record<string, unknown>
        >
      )?.['claude-code']?.permissionMode,
      'plan'
    );
    assert.deepEqual(
      inventory.components.find((entry) => entry.type === 'hooks')?.hooks,
      { PreToolUse: [user] },
      'import excludes groups proven ASB-owned by the peer state'
    );

    const second = await runImport('claude-code', undefined, { recursive: true });
    assert.equal(
      second.entries.every((entry) => entry.outcome === 'skipped'),
      true
    );
  });
});

test('init writes a dormant commented scaffold with detected apps only active in the example', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    const result = runInit(project, { force: true, createAgentsMd: false });
    assert.equal(result.outcome, 'written');
    const scaffold = fs.readFileSync(path.join(project, '.asb.toml'), 'utf-8');
    assert.match(scaffold, /^# ASB project configuration/m);
    assert.match(scaffold, /# Docs: .*README\.md/);
    assert.match(scaffold, /# \[applications\]/);
    assert.match(scaffold, /# {3}"claude-code", # detected/);
    assert.match(scaffold, /# {3}"cursor", # detected/);
    assert.match(scaffold, /# {3}# "codex",/);
    for (const type of ['rules', 'commands', 'agents', 'skills', 'hooks', 'mcp']) {
      assert.match(scaffold, new RegExp(`# \\[${type}\\]\\n# enabled = \\[\\]`));
    }
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
  });
});
