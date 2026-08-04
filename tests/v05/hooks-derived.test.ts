import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report } from '../../src/engine/report.js';
import {
  installApps,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Hook groups derive like every other slice, and they hold still while they
 * do it. Codex records its trust against a group's array position, so a group
 * that did not change may not move: the merge writes each recognized group
 * back where it already sat instead of taking every one out and appending the
 * new set behind whatever the user wrote.
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal
const HOOK_DIR = '${HOOK_DIR}';

function hooksJson(homes: ScratchHomes): string {
  return path.join(homes.agentsHome, '.codex', 'hooks.json');
}

function groups(homes: ScratchHomes, event = 'UserPromptSubmit'): Record<string, unknown>[] {
  const raw = fs.readFileSync(hooksJson(homes), 'utf-8');
  return (JSON.parse(raw) as { hooks: Record<string, Record<string, unknown>[]> }).hooks[event];
}

function seedHook(homes: ScratchHomes, id: string, command: string, matcher = '*'): void {
  const dir = path.join(homes.asbHome, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify(
      {
        name: id,
        hooks: { UserPromptSubmit: [{ matcher, hooks: [{ type: 'command', command }] }] },
      },
      null,
      2
    )
  );
}

function seedBundleHook(homes: ScratchHomes, id: string, script: string, args = ''): void {
  const dir = path.join(homes.asbHome, 'hooks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hook.json'),
    JSON.stringify(
      {
        name: id,
        hooks: {
          UserPromptSubmit: [
            { matcher: '*', hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh${args}` }] },
          ],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, 'run.sh'), script);
}

function config(homes: ScratchHomes, hooks: string[]): void {
  writeUserConfig(
    homes,
    `[applications]\nenabled = ["codex"]\n\n[hooks]\nenabled = [${hooks
      .map((id) => `"${id}"`)
      .join(', ')}]\n`
  );
}

/** The record an earlier version kept beside the library. */
function peerStatePath(homes: ScratchHomes): string {
  return path.join(homes.asbHome, 'state', 'hooks', 'codex.json');
}

function hookRows(report: Report) {
  return report.entries.filter((entry) => entry.type === 'hooks');
}

test('a hook that did not change keeps its array index when its neighbour does', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedBundleHook(homes, 'alpha', '#!/bin/sh\necho alpha\n');
    seedBundleHook(homes, 'beta', '#!/bin/sh\necho beta\n');
    config(homes, ['alpha', 'beta']);
    await runSync();

    // A group of the user's own, written after asb's: the old merge took every
    // recognized group out and appended the new set behind it, renumbering
    // both sides for a change that touched neither.
    const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine' }] };
    const before = groups(homes);
    fs.writeFileSync(
      hooksJson(homes),
      JSON.stringify({ hooks: { UserPromptSubmit: [...before, mine] } }, null, 2)
    );

    seedBundleHook(homes, 'alpha', '#!/bin/sh\necho alpha\n', ' --v2');
    const report = await runSync();

    const after = groups(homes);
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(after.length, 3, JSON.stringify(after, null, 2));
    assert.deepEqual(after[1], before[1], 'the untouched hook holds its index');
    assert.deepEqual(after[2], mine, 'and so does the group the user wrote');
    assert.match(JSON.stringify(after[0]), /run\.sh --v2/);
  });
});

test('a group whose command names a managed path is asb’s with no record anywhere', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedBundleHook(homes, 'guard', '#!/bin/sh\necho one\n');
    config(homes, ['guard']);
    await runSync();
    assert.equal(groups(homes).length, 1);

    // No record of it on this machine or any other.
    fs.rmSync(peerStatePath(homes), { force: true });
    seedBundleHook(homes, 'guard', '#!/bin/sh\necho two\n');
    const second = await runSync();

    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(groups(homes).length, 1, 'updated in place, not appended a second time');
    const bundle = path.join(homes.agentsHome, '.codex', 'hooks', 'managed', 'guard');
    assert.match(fs.readFileSync(path.join(bundle, 'run.sh'), 'utf-8'), /echo two/);

    fs.rmSync(peerStatePath(homes), { force: true });
    config(homes, []);
    const third = await runSync();

    assert.equal(third.exitCode, 0, JSON.stringify(third.entries, null, 2));
    assert.equal(fs.existsSync(hooksJson(homes)), false, 'the group and its file go');
    assert.equal(fs.existsSync(bundle), false, 'so does the bundle it pointed at');
    assert.equal(fs.existsSync(peerStatePath(homes)), false, 'and nothing is recorded');
  });
});

test('a group sharing an event and matcher with a library hook is reported, never removed', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'alpha', 'echo alpha');
    config(homes, ['alpha']);

    // An older render of the same hook: same event, same matcher, a command
    // that no longer says where it came from.
    const stale = { matcher: '*', hooks: [{ type: 'command', command: 'echo alpha --v1' }] };
    fs.mkdirSync(path.dirname(hooksJson(homes)), { recursive: true });
    fs.writeFileSync(hooksJson(homes), JSON.stringify({ hooks: { UserPromptSubmit: [stale] } }));

    const report = await runSync();

    const named = hookRows(report).filter((row) => row.outcome === 'left-behind');
    assert.equal(named.length, 1, JSON.stringify(report.entries, null, 2));
    assert.match(named[0].reason ?? '', /UserPromptSubmit/);
    assert.match(named[0].reason ?? '', /older render of alpha/, named[0].reason ?? '');
    assert.equal(named[0].path, hooksJson(homes));
    assert.deepEqual(groups(homes)[0], stale, 'the group asb cannot prove stays put');
    assert.equal(groups(homes).length, 2, 'and the selected hook lands beside it');
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
  });
});
