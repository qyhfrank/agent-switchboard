import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  installApps,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The hook ownership state file is a peer contract, not private engine state:
 * a 0.4.35 asb on another machine reads and writes the same
 * `<ASB_HOME>/state/hooks/<target>.json`. Every byte, key order and file
 * lifecycle below is what 0.4.35 does, so either peer can reconcile the
 * hooks the other one wrote. The machine-local 0.5 ledger lives elsewhere
 * (`<ASB_STATE_HOME>/ledger.json`) and never substitutes for this file.
 */

function hooksStateDir(homes: ScratchHomes): string {
  return path.join(homes.asbHome, 'state', 'hooks');
}

function hookStatePath(homes: ScratchHomes, target = 'claude-code'): string {
  return path.join(hooksStateDir(homes), `${target}.json`);
}

function claudeSettingsPath(homes: ScratchHomes): string {
  return path.join(homes.agentsHome, '.claude', 'settings.json');
}

function managedBundleDir(homes: ScratchHomes, id: string): string {
  return path.join(homes.agentsHome, '.claude', 'hooks', 'managed', id);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function readHooks(homes: ScratchHomes): Record<string, unknown[]> | undefined {
  return (readJson(claudeSettingsPath(homes)) as { hooks?: Record<string, unknown[]> }).hooks;
}

/** 0.4's `preferHomeVar`: a path under the real home is recorded as `$HOME/...`. */
function portableCommand(absPath: string): string {
  const home = os.homedir().replace(/\/+$/, '');
  return home.length > 0 && absPath.startsWith(`${home}/`)
    ? `$HOME/${absPath.slice(home.length + 1)}`
    : absPath;
}

/** The exact bytes 0.4 writes: four keys in this order, 2-space, trailing newline. */
function stateBytes(
  events: Record<string, unknown[]>,
  bundles: string[] = [],
  legacyBundles: string[] = []
): string {
  return `${JSON.stringify({ version: 1, events, bundles, legacyBundles }, null, 2)}\n`;
}

function config(hooks: readonly string[]): string {
  const list = hooks.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = [${list}]\n`;
}

/** Single-file library entry: `<ASB_HOME>/hooks/<id>.json`, never a bundle. */
function seedDefinitionHook(homes: ScratchHomes, id: string, command: string): void {
  const hooksDir = path.join(homes.asbHome, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    path.join(hooksDir, `${id}.json`),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command }] }] },
    })
  );
}

/** Bundle library entry: `<ASB_HOME>/hooks/<id>/hook.json` plus its scripts. */
function seedBundleHook(homes: ScratchHomes, id: string): void {
  const bundleDir = path.join(homes.asbHome, 'hooks', id);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'hook.json'),
    JSON.stringify({
      hooks: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '${HOOK_DIR}/run.sh' }] }],
      },
    })
  );
  fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\necho test\n');
}

/** The app-config row of a hooks target; per-bundle rows carry an id. */
function hooksRow(report: Report, app = 'claude-code'): ReportEntry | undefined {
  return report.entries.find(
    (entry) => entry.app === app && entry.type === 'hooks' && entry.id === null
  );
}

const DEFINITION_GROUP = {
  matcher: '*',
  hooks: [{ type: 'command', command: 'echo test' }],
};

test('a sync records the appended groups as the four-key 0.4 state file', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));

    const report = await runSync();

    // The run names the merge on the app's own config (0.4: `written` with
    // reason `1 hook(s) merged`).
    const row = hooksRow(report);
    assert.equal(row?.outcome, 'written');
    assert.equal(row?.detail, 'merged');
    assert.equal(row?.path, claudeSettingsPath(homes));

    assert.equal(
      fs.readFileSync(hookStatePath(homes), 'utf-8'),
      stateBytes({ UserPromptSubmit: [DEFINITION_GROUP] })
    );
    // What is recorded is exactly what was appended to the app config.
    assert.deepEqual(readHooks(homes)?.UserPromptSubmit, [DEFINITION_GROUP]);
    // One shared file per target: no device directories, no temp leftovers.
    assert.deepEqual(fs.readdirSync(hooksStateDir(homes)), ['claude-code.json']);
  });
});

test('recorded commands are the $HOME-portable form written into the app config', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedBundleHook(homes, 'bt');
    writeUserConfig(homes, config(['bt']));

    await runSync();

    // `${HOOK_DIR}` resolves to the distributed bundle dir, then the real home
    // prefix collapses to `$HOME/` so a peer on another machine reads the same
    // value it would write. A raw library shape here silently loses groups.
    const command = portableCommand(path.join(managedBundleDir(homes, 'bt'), 'run.sh'));
    const group = { hooks: [{ type: 'command', command }] };
    assert.equal(
      fs.readFileSync(hookStatePath(homes), 'utf-8'),
      stateBytes({ UserPromptSubmit: [group] }, ['bt'])
    );
    assert.deepEqual(readHooks(homes)?.UserPromptSubmit, [group]);
  });
});

test('unknown top-level keys and empty event arrays are dropped on the next write', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();

    // A peer (or a future version) left extra keys and a drained event behind.
    fs.writeFileSync(
      hookStatePath(homes),
      `${JSON.stringify({
        version: 1,
        events: { UserPromptSubmit: [DEFINITION_GROUP], PreToolUse: [] },
        bundles: [],
        legacyBundles: [],
        owner: 'someone-else',
        extra: { nested: true },
      })}\n`
    );

    await runSync();

    // Load is a strict field-by-field reconstruction and write is a full
    // replace: unknown keys do not survive, and an empty event array is not
    // a recorded event.
    assert.equal(
      fs.readFileSync(hookStatePath(homes), 'utf-8'),
      stateBytes({ UserPromptSubmit: [DEFINITION_GROUP] })
    );
  });
});

test('a state file whose version is not 1 grants no deletion authority', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();

    // Same content, unreadable schema version: the whole file loads as empty.
    const foreign = `${JSON.stringify({
      version: 2,
      events: { UserPromptSubmit: [DEFINITION_GROUP] },
      bundles: [],
      legacyBundles: [],
    })}\n`;
    fs.writeFileSync(hookStatePath(homes), foreign);
    writeUserConfig(homes, config([]));

    await runSync();

    // No evidence, no removal: the group stays and becomes user-owned. The
    // definition hook carries no managed path, so state is the only authority
    // that could have removed it.
    assert.deepEqual(readHooks(homes)?.UserPromptSubmit, [DEFINITION_GROUP]);
    // Nothing selected, nothing removed, no recognized state: the run does no
    // work and leaves the unrecognized peer file exactly as it found it.
    assert.equal(fs.readFileSync(hookStatePath(homes), 'utf-8'), foreign);
  });
});

test('an empty resulting state deletes the file instead of writing it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();
    assert.equal(fs.existsSync(hookStatePath(homes)), true);

    writeUserConfig(homes, config([]));
    const report = await runSync();

    // Deselection is a write like any other (0.4: `written` / `hooks cleared`).
    const row = hooksRow(report);
    assert.equal(row?.outcome, 'written');
    assert.equal(row?.detail, 'cleared');
    // The recorded groups are spliced out and the `hooks` key disappears.
    assert.equal(readHooks(homes), undefined);
    // Full de-selection closes out by deleting the file, never by writing an
    // empty one: an empty `{version:1,...}` shell would claim ownership of
    // nothing while still looking like live evidence to a peer.
    assert.equal(fs.existsSync(hookStatePath(homes)), false);
  });
});

test('device-scoped copies merge on read, are deleted on save, and are never created', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();

    // v0.4.32 wrote ownership under `<state dir>/<16-hex device id>/`. Move the
    // shared file there: the group's only removal evidence now sits in the
    // device copy, exactly as it does after upgrading a second machine.
    const deviceDir = path.join(hooksStateDir(homes), '0123456789abcdef');
    fs.mkdirSync(deviceDir, { recursive: true });
    const deviceCopy = path.join(deviceDir, 'claude-code.json');
    fs.renameSync(hookStatePath(homes), deviceCopy);

    writeUserConfig(homes, config([]));
    await runSync();

    assert.equal(readHooks(homes), undefined, 'device-scoped evidence authorizes the removal');
    assert.equal(fs.existsSync(deviceCopy), false, 'the copy is consumed, not left behind');
    assert.equal(fs.existsSync(deviceDir), false, 'the emptied device dir is removed');
    assert.equal(fs.existsSync(hookStatePath(homes)), false);

    // A fresh selection writes the shared file only; device dirs are an inbound
    // legacy form, never an output.
    writeUserConfig(homes, config(['solo']));
    await runSync();
    assert.deepEqual(fs.readdirSync(hooksStateDir(homes)), ['claude-code.json']);
  });
});

test('device-scoped group counts add so count-bounded removal stays correct', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();

    // Two machines each appended the same group before either upgraded: the
    // config holds two copies and the evidence for both is split across files.
    const settings = readJson(claudeSettingsPath(homes)) as { hooks: Record<string, unknown[]> };
    settings.hooks.UserPromptSubmit = [DEFINITION_GROUP, DEFINITION_GROUP];
    fs.writeFileSync(claudeSettingsPath(homes), `${JSON.stringify(settings, null, 2)}\n`);
    const deviceDir = path.join(hooksStateDir(homes), 'fedcba9876543210');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.copyFileSync(hookStatePath(homes), path.join(deviceDir, 'claude-code.json'));

    writeUserConfig(homes, config([]));
    await runSync();

    // Merged counts add rather than de-duplicate, so both copies are reclaimed.
    assert.equal(readHooks(homes), undefined);
    assert.equal(fs.existsSync(deviceDir), false);
  });
});

test('a corrupt state file loads as empty without aborting the run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    fs.mkdirSync(hooksStateDir(homes), { recursive: true });
    fs.writeFileSync(hookStatePath(homes), '{not json');

    const report = await runSync();

    // Unreadable ownership evidence grants zero deletion authority, but it is
    // not a fatal condition: the run still distributes and rewrites the file.
    assert.notEqual(report.exitCode, 2, 'an unreadable peer state file is not a hard failure');
    assert.equal(hooksRow(report)?.outcome, 'written', 'the run still distributes');
    assert.deepEqual(readHooks(homes)?.UserPromptSubmit, [DEFINITION_GROUP]);
    assert.equal(
      fs.readFileSync(hookStatePath(homes), 'utf-8'),
      stateBytes({ UserPromptSubmit: [DEFINITION_GROUP] })
    );
  });
});

test('v0.4.28 legacy state files are read-only recognition evidence', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));

    // `(claude-code|codex)-<64 hex>.json` plus the sibling artifacts a v0.4.28
    // transaction left next to them.
    const stateDir = hooksStateDir(homes);
    fs.mkdirSync(path.join(stateDir, 'locks'), { recursive: true });
    const legacyName = `claude-code-${'a'.repeat(64)}.json`;
    const legacy: Record<string, string> = {
      [legacyName]: `${JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'echo old' }] }],
        },
      })}\n`,
      [`${legacyName}.legacy-bundles`]: 'old-thing\n',
      [`${legacyName}.lock`]: 'pid 1\n',
      [`codex-${'b'.repeat(64)}.json`]: `${JSON.stringify({ hooks: {} })}\n`,
    };
    for (const [name, body] of Object.entries(legacy)) {
      fs.writeFileSync(path.join(stateDir, name), body);
    }

    await runSync();

    // Recognition evidence only: nothing here is rewritten, renamed or deleted,
    // because a peer still running v0.4.28 needs these files intact.
    for (const [name, body] of Object.entries(legacy)) {
      assert.equal(fs.readFileSync(path.join(stateDir, name), 'utf-8'), body, name);
    }
    assert.equal(fs.existsSync(path.join(stateDir, 'locks')), true);
    assert.equal(fs.existsSync(hookStatePath(homes)), true, 'current ownership is recorded');
  });
});

test('the state write leaves no temp files behind on either the write or delete path', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    seedBundleHook(homes, 'bt');
    writeUserConfig(homes, config(['solo', 'bt']));

    await runSync();
    const afterWrite = fs.readdirSync(hooksStateDir(homes));
    // The write goes through a sibling temp file and a rename, so the file a
    // peer opens is never a partial one; the temp never outlives the rename.
    assert.deepEqual(afterWrite, ['claude-code.json']);
    assert.equal(
      typeof (readJson(hookStatePath(homes)) as { version?: unknown }).version,
      'number',
      'the published file is a complete document'
    );

    writeUserConfig(homes, config([]));
    await runSync();
    assert.deepEqual(fs.readdirSync(hooksStateDir(homes)), []);
  });
});

test('a recorded bundle id that is not a plain directory name is ignored', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedDefinitionHook(homes, 'solo', 'echo test');
    writeUserConfig(homes, config(['solo']));
    await runSync();

    // Every peer on the synced tree writes this file, so a bundle name is
    // untrusted input. `../../skills` resolves back INSIDE the app root, so
    // containment alone would let the deselection cleanup delete the user's
    // skills; only a plain child name of hooks/managed/ may be reclaimed.
    const bystander = path.join(homes.agentsHome, '.claude', 'skills', 'keep');
    fs.mkdirSync(bystander, { recursive: true });
    fs.writeFileSync(path.join(bystander, 'SKILL.md'), 'the user owns this\n');
    fs.writeFileSync(
      hookStatePath(homes),
      stateBytes({ UserPromptSubmit: [DEFINITION_GROUP] }, ['../../skills'])
    );

    writeUserConfig(homes, config([]));
    await runSync();

    assert.equal(
      fs.readFileSync(path.join(bystander, 'SKILL.md'), 'utf-8'),
      'the user owns this\n',
      'a traversing bundle name never becomes a delete target'
    );
    // The rest of the record still works: the recorded group is reclaimed.
    assert.equal(readHooks(homes), undefined);
  });
});
