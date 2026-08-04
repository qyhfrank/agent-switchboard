import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { parseCliArgs, runImport, runInit, runSync } from '../../src/engine/cli.js';
import { renderGeminiCommand } from '../../src/engine/dialects.js';
import { scanLibrary } from '../../src/engine/library.js';
import { installApps, withScratchHomes } from './helpers/scratch.js';

const HOOK_DIR = `\${HOOK_DIR}`;

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
    // The selected library hook renders the first group verbatim, which is the
    // only thing that proves the group is asb's rather than the user's.
    write(
      path.join(homes.asbHome, 'hooks', 'managed.json'),
      `${JSON.stringify({ hooks: { PreToolUse: [managed] } })}\n`
    );
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["managed"]\n'
    );

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
      inventory.components.find((entry) => entry.id === 'claude-code-hooks')?.hooks,
      { PreToolUse: [user] },
      'import excludes the group a selected hook renders'
    );

    const second = await runImport('claude-code', undefined, { recursive: true });
    assert.equal(
      second.entries.every((entry) => entry.outcome === 'skipped'),
      true
    );
  });
});

test('hook import excludes a stale group proven by its managed bundle path', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const hookDir = path.join(homes.asbHome, 'hooks', 'managed');
    write(
      path.join(hookDir, 'hook.json'),
      `${JSON.stringify({
        name: 'managed',
        hooks: {
          PreToolUse: [
            {
              matcher: 'old',
              hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }],
            },
          ],
        },
      })}\n`
    );
    write(path.join(hookDir, 'run.sh'), '#!/bin/sh\n');
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["managed"]\n'
    );
    await runSync();
    const settings = path.join(homes.agentsHome, '.claude', 'settings.json');
    const installed = JSON.parse(fs.readFileSync(settings, 'utf-8')) as {
      hooks: { PreToolUse: unknown[] };
    };
    const user = { matcher: 'user', hooks: [{ type: 'command', command: 'echo user' }] };
    installed.hooks.PreToolUse.push(user);
    write(settings, `${JSON.stringify(installed)}\n`);
    write(
      path.join(hookDir, 'hook.json'),
      `${JSON.stringify({
        name: 'managed',
        hooks: {
          PreToolUse: [
            {
              matcher: 'new',
              hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }],
            },
          ],
        },
      })}\n`
    );

    const result = await runImport('claude-code', undefined, { types: ['hooks'], force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries, null, 2));
    const imported = scanLibrary().components.find(
      (entry) => entry.type === 'hooks' && entry.id === 'claude-code-hooks'
    );
    assert.deepEqual(imported?.hooks, { PreToolUse: [user] });
  });
});

test('forced skill import overlays copied files and preserves library-only files', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    write(
      path.join(homes.agentsHome, '.claude', 'skills', 'notes', 'SKILL.md'),
      '---\nname: notes\ndescription: App copy\n---\nApp.\n'
    );
    const target = path.join(homes.asbHome, 'skills', 'notes');
    write(
      path.join(target, 'SKILL.md'),
      '---\nname: notes\ndescription: Library copy\n---\nLibrary.\n'
    );
    write(path.join(target, 'reference.md'), 'library reference\n');
    write(path.join(target, '.library-note'), 'keep\n');

    const result = await runImport('claude-code', undefined, {
      types: ['skills'],
      force: true,
    });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
    assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8'), /App copy/);
    assert.equal(
      fs.readFileSync(path.join(target, 'reference.md'), 'utf-8'),
      'library reference\n'
    );
    assert.equal(fs.readFileSync(path.join(target, '.library-note'), 'utf-8'), 'keep\n');
    assert.match(result.entries[0]?.reason ?? '', /overwrote SKILL\.md/);
  });
});

test('importing straight after a sync brings back nothing asb wrote', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    write(
      path.join(homes.asbHome, 'hooks', 'guard.json'),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }],
        },
      })}\n`
    );
    write(
      path.join(homes.asbHome, 'config.toml'),
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["guard"]\n'
    );
    await runSync();

    const result = await runImport('claude-code', undefined, {
      types: ['hooks'],
      force: true,
    });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(homes.asbHome, 'hooks', 'claude-code-hooks.json'), 'utf-8')
      ),
      { hooks: {} }
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
    assert.match(
      scaffold,
      /asb sync/,
      'the scaffold says what a sync in this directory does with the file'
    );
    assert.doesNotMatch(scaffold, /\bM[67]\b/, 'the scaffold names behavior, not a milestone');
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
