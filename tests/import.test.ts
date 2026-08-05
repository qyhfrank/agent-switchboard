import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../src/engine/apps.js';
import { runImport, runInit, runSync } from '../src/engine/cli.js';
import { renderGeminiCommand } from '../src/engine/dialects.js';
import { scanLibrary } from '../src/engine/library.js';
import {
  inCwd,
  installApps,
  runMain,
  seedTree,
  skillDoc,
  withScratchHomes,
} from './helpers/scratch.js';

/**
 * Reading an app's own files back into the library, and the commented project
 * scaffold init leaves behind.
 */

const HOOK_DIR = `\${HOOK_DIR}`;

test('an import batch keeps its successes and round-trips unknown dialect fields', async () => {
  await withScratchHomes(async (homes) => {
    seedTree(path.join(homes.agentsHome, '.gemini', 'commands'), {
      'good.toml': 'prompt = "Do it"\ndescription = "Useful"\ncustom_field = "kept"\n',
      'bad.toml': 'prompt = "unterminated\n',
    });

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

test('a typeless import uses every reader and existing files skip unless forced', async () => {
  await withScratchHomes(async (homes) => {
    const managed = { hooks: [{ type: 'command', command: 'echo managed' }] };
    const user = { hooks: [{ type: 'command', command: 'echo user' }] };
    seedTree(path.join(homes.agentsHome, '.claude'), {
      'commands/ship.md': '---\ndescription: Ship\nargument-hint: branch\n---\nRun it.\n',
      'agents/review.md':
        '---\ndescription: Review\nmodel: opus\npermissionMode: plan\n---\nReview it.\n',
      'skills/lint/SKILL.md': skillDoc('lint'),
      'settings.json': `${JSON.stringify({ hooks: { PreToolUse: [managed, user] } })}\n`,
    });
    // The selected library hook renders the first group verbatim, which is the
    // only thing that proves the group is asb's rather than the user's.
    seedTree(homes.asbHome, {
      'hooks/managed.json': `${JSON.stringify({ hooks: { PreToolUse: [managed] } })}\n`,
      'config.toml':
        '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["managed"]\n',
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

test('an import without recursion still reads the default component directory', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'gemini');
    const row = APP_ROWS.find((candidate) => candidate.id === 'gemini');
    assert.ok(row?.commands);
    seedTree(row.commands.dir(homes), { 'review.toml': 'prompt = "Review this"\n' });

    const result = await runImport('gemini', undefined, { force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries, null, 2));
    assert.ok(result.entries.some((entry) => entry.type === 'commands' && entry.id === 'review'));
  });
});

test('hook import excludes a stale group proven by its managed bundle path', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const hookDir = path.join(homes.asbHome, 'hooks', 'managed');
    const bundle = (matcher: string) =>
      `${JSON.stringify({
        name: 'managed',
        hooks: {
          PreToolUse: [{ matcher, hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }],
        },
      })}\n`;
    seedTree(hookDir, { 'hook.json': bundle('old'), 'run.sh': '#!/bin/sh\n' });
    seedTree(homes.asbHome, {
      'config.toml':
        '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["managed"]\n',
    });
    await runSync();

    const settingsPath = path.join(homes.agentsHome, '.claude', 'settings.json');
    const installed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: { PreToolUse: unknown[] };
    };
    const user = { matcher: 'user', hooks: [{ type: 'command', command: 'echo user' }] };
    installed.hooks.PreToolUse.push(user);
    fs.writeFileSync(settingsPath, `${JSON.stringify(installed)}\n`, 'utf-8');
    // The library moved on: the installed group no longer equals any render.
    seedTree(hookDir, { 'hook.json': bundle('new') });

    const result = await runImport('claude-code', undefined, { types: ['hooks'], force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries, null, 2));
    const imported = scanLibrary().components.find(
      (entry) => entry.type === 'hooks' && entry.id === 'claude-code-hooks'
    );
    assert.deepEqual(imported?.hooks, { PreToolUse: [user] });
  });
});

test('a forced skill import overlays copied files and preserves library-only files', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(path.join(homes.agentsHome, '.claude', 'skills', 'notes'), {
      'SKILL.md': '---\nname: notes\ndescription: App copy\n---\nApp.\n',
    });
    const target = path.join(homes.asbHome, 'skills', 'notes');
    seedTree(target, {
      'SKILL.md': '---\nname: notes\ndescription: Library copy\n---\nLibrary.\n',
      'reference.md': 'library reference\n',
      '.library-note': 'keep\n',
    });

    const result = await runImport('claude-code', undefined, { types: ['skills'], force: true });

    assert.equal(result.exitCode, 0, JSON.stringify(result.entries));
    assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf-8'), /App copy/);
    assert.equal(
      fs.readFileSync(path.join(target, 'reference.md'), 'utf-8'),
      'library reference\n'
    );
    assert.equal(fs.readFileSync(path.join(target, '.library-note'), 'utf-8'), 'keep\n');
    assert.match(
      result.entries[0]?.reason ?? '',
      /SKILL\.md/,
      'the report names what it overwrote'
    );
  });
});

test('init writes a dormant commented scaffold marking the detected apps', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'cursor');
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);

    const result = runInit(project, { force: true, createAgentsMd: false });

    assert.equal(result.outcome, 'written');
    const scaffold = fs.readFileSync(path.join(project, '.asb.toml'), 'utf-8');
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

// The timeout is the assertion: a prompt on this path would hang, not fail.
test(
  'init over an existing config answers with a skipped envelope and no prompt',
  { timeout: 15000 },
  async () => {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'existing-project');
      seedTree(project, { '.asb.toml': '# existing\n' });

      const result = await inCwd(project, () => runMain(['init', '--json']));

      assert.equal(result.code, 0, result.err || result.out);
      const envelope = JSON.parse(result.out) as {
        exitCode: number;
        entries: { outcome?: string }[];
      };
      assert.equal(envelope.exitCode, 0);
      assert.ok(
        envelope.entries.some((entry) => entry.outcome === 'skipped'),
        result.out
      );
      assert.equal(fs.readFileSync(path.join(project, '.asb.toml'), 'utf-8'), '# existing\n');
      assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false);
    });
  }
);
