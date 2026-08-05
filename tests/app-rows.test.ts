import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseToml } from '@iarna/toml';
import { APP_ROWS } from '../src/engine/apps.js';
import { runSync } from '../src/engine/cli.js';
import type { Component } from '../src/engine/library.js';
import {
  installApps,
  renderedRules,
  ruleFilePath,
  runMain,
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  seedTree,
  skillDoc,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * An app target is one data row, and every cell it declares is reached by the
 * common machinery. The traecli row carries the whole shape: a detect probe
 * that shares a parent directory with another app, rules, MCP, commands and
 * agents cells, and no skills cell of its own. Detection itself is asserted
 * beside it, because an undetected app decides between writing and skipping.
 */

function entry(type: 'commands' | 'agents', metadata: Record<string, unknown>): Component {
  return {
    type,
    id: 'reviewer',
    source: 'library',
    path: `/library/${type}/reviewer.md`,
    content: 'Review.\n',
    metadata: { tags: [], requires: [], ...metadata },
  };
}

function traeDir(homes: ScratchHomes, ...segments: string[]): string {
  return path.join(homes.agentsHome, '.trae', ...segments);
}

test('traecli is one builtin data row with its own detect dir and dialects', async () => {
  await withScratchHomes(async (homes) => {
    const row = APP_ROWS.find((candidate) => candidate.id === 'traecli');
    assert.ok(row);
    assert.equal(row.detectDir(homes), traeDir(homes, 'cli'));
    assert.equal(row.rules?.render('Body.\n'), 'Body.\n', 'the shared host takes a raw body');
    assert.equal(row.mcp?.format, 'toml');
    assert.equal(row.mcp?.rootKey, 'mcp_servers');
    assert.equal(row.mcp?.create, true);
    assert.equal(row.skills, undefined, 'the trae row owns ~/.trae/skills, never traecli');
    assert.equal(row.hooks, undefined);

    // The row renames the fields its own frontmatter dialect spells
    // differently for commands and for agents.
    assert.match(
      row.commands?.render(
        entry('commands', {
          description: 'Review',
          extras: { traecli: { allowed_tools: ['read', 'write'], argument_hint: '<path>' } },
        })
      ) ?? '',
      /allowed-tools: read,write[\s\S]*argument-hint: <path>/
    );
    const agent = row.agents?.render(
      entry('agents', { extras: { traecli: { allowed_tools: ['read', 'write'] } } })
    );
    assert.match(agent ?? '', /name: reviewer/);
    assert.match(agent ?? '', /allowed_tools/);
  });
});

test('without ~/.trae/cli the traecli row is inert even when the IDE dir exists', async () => {
  await withScratchHomes(async (homes) => {
    // Two rows share ~/.trae, so the probe must not fire on the IDE's own
    // directory: a write there lands in an app that is not installed.
    fs.mkdirSync(traeDir(homes, 'user_rules'), { recursive: true });
    seedRule(homes, 'base.md', 'Baseline rules.\n');
    seedMcpLibrary(homes, { alpha: { command: 'run' } });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["traecli"]\n\n[rules]\nenabled = ["base"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );

    for (const argv of [['sync'], ['status']]) {
      const run = await runMain(argv);
      assert.equal(run.code, 0, run.err);
      assert.equal(fs.existsSync(traeDir(homes, 'AGENTS.md')), false);
      assert.equal(fs.existsSync(traeDir(homes, 'traecli.toml')), false);
    }
  });
});

test('one sync fills every declared cell of an app row and skills flow through the union', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(traeDir(homes, 'cli'), { recursive: true });
    installApps(homes, 'codex');
    seedTree(homes.asbHome, {
      'rules/base.md': 'Shared baseline rules.\n',
      'commands/reviewer.md': '---\ndescription: Review\n---\nReview it.\n',
      'agents/reviewer.md': '---\ndescription: Review\n---\nReview it.\n',
      'skills/seeded/SKILL.md': skillDoc('seeded'),
    });
    seedMcpLibrary(homes, { alpha: { command: 'run' } });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["traecli", "codex"]',
        '',
        '[rules]',
        'enabled = ["base"]',
        '',
        '[mcp]',
        'enabled = ["alpha"]',
        '',
        '[commands]',
        'enabled = ["reviewer"]',
        '',
        '[agents]',
        'enabled = ["reviewer"]',
        '',
        '[skills]',
        'enabled = ["seeded"]',
        '',
        '[distribution]',
        'use_agents_dir = true',
        '',
      ].join('\n')
    );

    const sync = await runMain(['sync']);
    assert.equal(sync.code, 0, sync.err);

    // The rules cell writes a shared host, so its bytes are the same bytes
    // another raw-body app gets: no frontmatter, no per-app variation.
    assert.equal(
      fs.readFileSync(traeDir(homes, 'AGENTS.md'), 'utf-8'),
      fs.readFileSync(ruleFilePath(homes, 'codex'), 'utf-8')
    );
    assert.match(fs.readFileSync(traeDir(homes, 'AGENTS.md'), 'utf-8'), /Shared baseline rules\./);

    const toml = parseToml(fs.readFileSync(traeDir(homes, 'traecli.toml'), 'utf-8')) as {
      mcp_servers?: Record<string, { command?: string }>;
    };
    assert.equal(toml.mcp_servers?.alpha?.command, 'run');

    assert.match(
      fs.readFileSync(traeDir(homes, 'commands', 'reviewer.md'), 'utf-8'),
      /Review it\./
    );
    assert.match(
      fs.readFileSync(traeDir(homes, 'agents', 'reviewer.md'), 'utf-8'),
      /name: reviewer/
    );

    // A row without a skills cell still drives the shared writer, and never
    // claims the directory the IDE row owns.
    assert.equal(
      fs.existsSync(path.join(homes.agentsHome, '.agents', 'skills', 'seeded', 'SKILL.md')),
      true
    );
    assert.equal(fs.existsSync(traeDir(homes, 'skills')), false);
  });
});

test('an enabled app that is not detected is skipped until assume_installed names it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'base.md', 'Baseline rules.\n');
    const config = (extra = ''): string =>
      `[applications]\nenabled = ["claude-code", "opencode"]\n${extra}\n[rules]\nenabled = ["base"]\n`;
    writeUserConfig(homes, config());

    const skippedRun = await runSync();

    assert.equal(
      skippedRun.entries.find((row) => row.app === 'claude-code' && row.type === 'rules')?.outcome,
      'written'
    );
    const skipped = skippedRun.entries.find(
      (row) => row.app === 'opencode' && row.outcome === 'skipped'
    );
    assert.ok(skipped, 'expected a skipped row for the undetected app');
    assert.equal(skipped.detail, 'app-not-installed');
    assert.match(skipped.reason ?? '', /assume_installed/, 'the row names the way out');
    assert.equal(fs.existsSync(ruleFilePath(homes, 'opencode')), false);
    assert.equal(skippedRun.exitCode, 0, 'an app that is not there is not a failure');

    // Named there, the same undetected app is distributed to anyway.
    writeUserConfig(homes, config('assume_installed = ["opencode"]\n'));
    const forced = await runSync();

    assert.equal(
      forced.entries.find((row) => row.app === 'opencode' && row.type === 'rules')?.outcome,
      'written'
    );
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'opencode'), 'utf-8'),
      renderedRules('opencode', 'Baseline rules.\n')
    );
    assert.equal(forced.exitCode, 0);
  });
});
