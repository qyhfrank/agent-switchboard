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
 * Ported 0.4.35 acceptance: hook distribution into app configs
 * (tests/hooks-distribution.test.ts) expressed against the one 0.5
 * reconciliation (`runSync`). Every claim is a direct file assertion on
 * settings.json / hooks.json / the distributed bundle dir; the report rows
 * are asserted alongside them, never in their place.
 *
 * Frozen 0.4 anchors cover rendering, merge and empty-map deletion, shape
 * validation, count-bounded ownership splice, hooks.json deletion, publish
 * format, and $HOME portability.
 */

type HookApp = 'claude-code' | 'codex';

const APP_DIR: Record<HookApp, string> = { 'claude-code': '.claude', codex: '.codex' };

// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const HOOK_DIR = '${HOOK_DIR}';

/** claude-code writes settings.json; codex writes hooks.json. */
function configPath(homes: ScratchHomes, app: HookApp): string {
  const file = app === 'claude-code' ? 'settings.json' : 'hooks.json';
  return path.join(homes.agentsHome, APP_DIR[app], file);
}

function managedDir(homes: ScratchHomes, app: HookApp, id: string): string {
  return path.join(homes.agentsHome, APP_DIR[app], 'hooks', 'managed', id);
}

function managedParent(homes: ScratchHomes, app: HookApp): string {
  return path.join(homes.agentsHome, APP_DIR[app], 'hooks', 'managed');
}

/** Seed a single-file library hook at <asbHome>/hooks/<id>.json. */
function seedHook(homes: ScratchHomes, id: string, hooks: unknown): string {
  const dir = path.join(homes.asbHome, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ name: id, hooks }, null, 2), 'utf-8');
  return filePath;
}

/** Seed a bundle library hook at <asbHome>/hooks/<id>/hook.json plus script files. */
function seedHookBundle(
  homes: ScratchHomes,
  id: string,
  hooks: unknown,
  files: Record<string, string> = {}
): string {
  const dir = path.join(homes.asbHome, 'hooks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hook.json'), JSON.stringify({ name: id, hooks }, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
  return dir;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function eventGroups(filePath: string, event: string): Array<Record<string, unknown>> {
  const hooks = readJson(filePath).hooks as Record<string, unknown[]> | undefined;
  return (hooks?.[event] ?? []) as Array<Record<string, unknown>>;
}

function commandsOf(groups: Array<Record<string, unknown>>): string[] {
  return groups.flatMap((group) =>
    (Array.isArray(group.hooks) ? group.hooks : [])
      .map((handler) => (handler as Record<string, unknown>).command)
      .filter((command): command is string => typeof command === 'string')
  );
}

function configFor(apps: readonly string[], hooks: readonly string[]): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${list(apps)}]\n\n[hooks]\nenabled = [${list(hooks)}]\n`;
}

function hooksRows(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'hooks');
}

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

/**
 * Frozen 0.4 `preferHomeVar`: the home
 * prefix keys off os.homedir() while the app root keys off ASB_AGENTS_HOME, so
 * under scratch homes (a tmpdir tree) nothing is rewritten and the command
 * keeps its absolute path. The rule is frozen, not one environment's answer.
 */
function homePortable(absolute: string): string {
  const home = os.homedir().replace(/\/+$/, '');
  if (home.length === 0 || !absolute.startsWith(`${home}/`)) return absolute;
  return `$HOME/${absolute.slice(home.length + 1)}`;
}

const USER_GROUP_A = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-a' }] };
const USER_GROUP_B = { hooks: [{ type: 'command', command: 'echo user-b', timeout: 5 }] };

/** Library shape carrying the ASB metadata that the render must strip. */
const LINT_LIBRARY = {
  UserPromptSubmit: [
    {
      matcher: '*',
      _asb_source: true,
      hooks: [{ type: 'command', command: 'echo lint', _asb_hook_id: 'lint' }],
    },
  ],
};
const LINT_RENDERED = { matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] };

test('a selected hook is appended after the user groups with no ASB metadata', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      theme: 'dark',
      hooks: { UserPromptSubmit: [USER_GROUP_A, USER_GROUP_B] },
    });
    writeUserConfig(homes, configFor(['claude-code'], ['lint']));

    const report = await runSync();

    // Order is the whole claim: user groups first, in their original order,
    // the managed group appended last (distribution.ts:412-432).
    assert.deepEqual(eventGroups(settings, 'UserPromptSubmit'), [
      USER_GROUP_A,
      USER_GROUP_B,
      LINT_RENDERED,
    ]);
    assert.equal(readJson(settings).theme, 'dark', 'unrelated top-level keys survive');

    const raw = fs.readFileSync(settings, 'utf-8');
    assert.equal(raw.includes('_asb'), false, 'no ASB marker keys reach the app config');
    assert.equal(raw.includes('asb-managed'), false, 'no ASB marker comment lines either');
    // Frozen publish format (target-config.ts:53-72): 2-space JSON + newline.
    assert.equal(raw, `${JSON.stringify(readJson(settings), null, 2)}\n`);

    // The app-config row names the merge (0.4: `written` / `1 hook(s) merged`).
    const row = hooksRows(report).find((entry) => entry.app === 'claude-code');
    assert.equal(row?.outcome, 'written');
    assert.equal(row?.detail, 'merged');
    assert.equal(row?.path, settings);
  });
});

test('a bundle hook copies its files and renders the hook dir home-portably', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const home = os.homedir().replace(/\/+$/, '');
    // One command exercising all three render rules: placeholder expansion,
    // $HOME substitution at a path-token boundary, and the near-miss prefix
    // that must not be substituted (target-config.ts:148-160).
    const command = `${HOOK_DIR}/run.sh --home ${home}/notes.txt --near ${home}2/notes.txt`;
    const source = seedHookBundle(
      homes,
      'bt',
      { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
      { 'run.sh': '#!/bin/sh\necho bt\n' }
    );
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();

    const target = managedDir(homes, 'claude-code', 'bt');
    assert.equal(fs.existsSync(target), true, 'the bundle is distributed under hooks/managed');
    // 0.4 copies EVERY file in the bundle dir, hook.json included
    // (library.ts:147-169; the "excludes hook.json" doc comment is stale).
    assert.deepEqual(fs.readdirSync(target).sort(), ['hook.json', 'run.sh']);
    assert.equal(
      fs.readFileSync(path.join(target, 'run.sh'), 'utf-8'),
      fs.readFileSync(path.join(source, 'run.sh'), 'utf-8')
    );

    const settings = configPath(homes, 'claude-code');
    assert.deepEqual(commandsOf(eventGroups(settings, 'UserPromptSubmit')), [
      `${homePortable(target)}/run.sh --home $HOME/notes.txt --near ${home}2/notes.txt`,
    ]);
    assert.equal(
      fs.readFileSync(settings, 'utf-8').includes(HOOK_DIR),
      false,
      'the placeholder never survives distribution'
    );
  });
});

test('deselection removes the groups, the bundle dir, and the emptied hooks key', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    seedHookBundle(
      homes,
      'bt',
      { PreToolUse: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }] },
      { 'run.sh': '#!/bin/sh\necho bt\n' }
    );
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, { theme: 'dark' });
    writeUserConfig(homes, configFor(['claude-code'], ['lint', 'bt']));

    await runSync();
    assert.equal(eventGroups(settings, 'UserPromptSubmit').length, 1);
    assert.equal(eventGroups(settings, 'PreToolUse').length, 1);
    assert.equal(fs.existsSync(managedDir(homes, 'claude-code', 'bt')), true);

    writeUserConfig(homes, configFor(['claude-code'], []));
    const second = await runSync();

    assert.equal(fs.existsSync(settings), true, 'settings.json itself is never deleted');
    const after = readJson(settings);
    assert.equal(Object.hasOwn(after, 'hooks'), false, 'an empty merged map deletes the hooks key');
    assert.equal(after.theme, 'dark', 'unrelated keys round-trip untouched');
    assert.equal(
      fs.existsSync(managedDir(homes, 'claude-code', 'bt')),
      false,
      'the orphan bundle dir is removed'
    );
    assert.equal(
      fs.existsSync(managedParent(homes, 'claude-code')),
      true,
      'the emptied hooks/managed parent survives'
    );
    // Clearing is reported, not silent: the config row for the emptied map
    // (0.4: `written` / `hooks cleared`) and the reclaimed bundle directory.
    const rows = hooksRows(second);
    const config = rows.find((entry) => entry.id === null);
    assert.equal(config?.outcome, 'written');
    assert.equal(config?.detail, 'cleared');
    assert.equal(rows.find((entry) => entry.id === 'bt')?.outcome, 'removed');
  });
});

test('codex hooks.json appends after user groups and is deleted only when empty', async () => {
  const CLEAN = {
    UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo c' }] }],
  };
  const USER = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo user' }] };

  // (a) same append discipline as claude-code; a surviving user group keeps
  // the file alive through deselection.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    const hooksJson = configPath(homes, 'codex');
    writeJson(hooksJson, { hooks: { UserPromptSubmit: [USER] } });
    writeUserConfig(homes, configFor(['codex'], ['clean']));

    await runSync();
    assert.deepEqual(eventGroups(hooksJson, 'UserPromptSubmit'), [USER, CLEAN.UserPromptSubmit[0]]);

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), true, 'a remaining user group keeps the file');
    assert.deepEqual(eventGroups(hooksJson, 'UserPromptSubmit'), [USER]);
  });

  // (b) no groups left, nothing selected, no other top-level keys: deleted.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    writeUserConfig(homes, configFor(['codex'], ['clean']));
    await runSync();
    const hooksJson = configPath(homes, 'codex');
    assert.equal(fs.existsSync(hooksJson), true);

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), false, 'hooks.json is removed outright');
  });

  // (c) a non-`hooks` top-level key blocks the deletion; only that key is left.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    const hooksJson = configPath(homes, 'codex');
    writeJson(hooksJson, { preferredNotifChannel: 'desktop' });
    writeUserConfig(homes, configFor(['codex'], ['clean']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), true, 'a foreign top-level key keeps the file');
    assert.deepEqual(readJson(hooksJson), { preferredNotifChannel: 'desktop' });
  });
});

test('an invalid hooks shape aborts that app before any config write', async () => {
  // 0.4 validates AFTER the bundle copy phase (distribution.ts:284-341), so the
  // claim is scoped to the config file; a definition hook keeps it exact.
  // The third column is the frozen 0.4 diagnostic: each failure names the key
  // that made the config unusable, so the two cases never blur into one.
  const cases: Array<[string, unknown, string]> = [
    ['hooks is not an object', { theme: 'dark', hooks: 'nope' }, '"hooks" must be an object'],
    [
      'hooks.<event> is not an array',
      { theme: 'dark', hooks: { UserPromptSubmit: {} } },
      '"hooks.UserPromptSubmit" must be an array',
    ],
  ];
  for (const [label, seeded, diagnostic] of cases) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedHook(homes, 'lint', LINT_LIBRARY);
      const settings = configPath(homes, 'claude-code');
      writeJson(settings, seeded);
      const before = fs.readFileSync(settings, 'utf-8');
      writeUserConfig(homes, configFor(['claude-code'], ['lint']));

      const report = await runSync();

      assert.equal(fs.readFileSync(settings, 'utf-8'), before, `${label}: config is untouched`);
      const row = hooksRows(report).find((entry) => entry.app === 'claude-code');
      assert.equal(row?.outcome, 'failed', `${label}: the refusal is reported`);
      assert.equal(row?.detail, 'invalid-shape', label);
      assert.equal(
        row?.reason?.includes(`settings.json has invalid shape: ${diagnostic}`),
        true,
        `${label}: the row names the unusable key — got ${row?.reason}`
      );
      assert.notEqual(report.exitCode, 0, `${label}: an unusable config fails the run`);
    });
  }
});

test('a user-edited group survives deselection while every copy of the render leaves', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    // Definition (non-bundle) hooks carry no managed path, so equality with
    // the render is the whole of the evidence.
    seedHook(homes, 'alpha', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo alpha' }] }],
    });
    seedHook(homes, 'beta', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo beta' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    await runSync();
    const settings = configPath(homes, 'claude-code');
    assert.equal(fs.existsSync(settings), true, 'the first sync writes settings.json');
    const groups = eventGroups(settings, 'PreToolUse');
    assert.equal(groups.length, 2);

    // The user hand-edits beta's command (deep equality broken) and duplicates
    // alpha's group verbatim: two copies of the render, one group asb cannot
    // prove anything about.
    const alpha = groups.find((group) => commandsOf([group]).includes('echo alpha'));
    assert.ok(alpha, 'expected the rendered alpha group');
    const edited = { matcher: '*', hooks: [{ type: 'command', command: 'echo beta --user' }] };
    writeJson(settings, { hooks: { PreToolUse: [alpha, edited, alpha] } });

    writeUserConfig(homes, configFor(['claude-code'], []));
    await runSync();

    // Both copies are what the library renders, so both are asb's and both
    // leave; the edited one matches nothing and is never claimed.
    assert.deepEqual(eventGroups(settings, 'PreToolUse'), [edited]);
  });
});

/**
 * Event names come from the app's vocabulary, not from asb, and `JSON.parse`
 * hands back `__proto__` as an own key. Every event-keyed map the rewrite
 * builds must therefore be a plain dictionary: a `{}` literal routes that key
 * into the prototype setter and drops the user's groups on the floor.
 */
test('a user event named __proto__ survives the rewrite', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    const protoGroup = { matcher: 'proto', hooks: [{ type: 'command', command: 'echo proto' }] };
    const settings = configPath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `{ "hooks": { "__proto__": [${JSON.stringify(protoGroup)}] } }\n`);
    writeUserConfig(homes, configFor(['claude-code'], ['lint']));

    await runSync();

    const hooks = readJson(settings).hooks as Record<string, unknown>;
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(hooks, '__proto__')?.value,
      [protoGroup],
      'the user-written event and its group are preserved'
    );
    assert.deepEqual(
      eventGroups(settings, 'UserPromptSubmit'),
      [LINT_RENDERED],
      'the selected hook still distributes beside it'
    );
  });
});

test('distributed bundle scripts follow the source executable bit', async () => {
  const HOOKS = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }],
  };
  const SCRIPT = '#!/bin/sh\necho bt\n';

  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedHookBundle(homes, 'bt', HOOKS, { 'run.sh': SCRIPT });
    fs.chmodSync(path.join(source, 'run.sh'), 0o755);
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();
    const target = path.join(managedDir(homes, 'claude-code', 'bt'), 'run.sh');
    assert.equal(fs.existsSync(target), true, 'the bundle script is distributed');
    assert.equal(modeOf(target), 0o755, 'an executable source keeps its exact mode');

    fs.chmodSync(target, 0o644);
    await runSync();
    assert.equal(modeOf(target), 0o755, 'mode drift alone counts as a write');
    assert.equal(fs.readFileSync(target, 'utf-8'), SCRIPT, 'a repair never touches content');
  });

  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHookBundle(homes, 'bt', HOOKS, { 'run.sh': SCRIPT });
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();
    const target = path.join(managedDir(homes, 'claude-code', 'bt'), 'run.sh');
    assert.equal(fs.existsSync(target), true, 'the bundle script is distributed');
    assert.equal(modeOf(target) & 0o111, 0, 'a plain source never lands executable');

    fs.chmodSync(target, 0o755);
    await runSync();
    // Frozen 0.4 repair rule: currentMode & 0o666, not the source mode.
    assert.equal(modeOf(target), 0o644);
  });
});

test('a missing library entry and a malformed hook file contain to their own rows', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'good', LINT_LIBRARY);
    fs.writeFileSync(path.join(homes.asbHome, 'hooks', 'broken.json'), '{ "hooks": ', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], ['good', 'broken', 'ghost']));

    const report = await runSync();

    // The healthy sibling still distributes: that is the containment claim.
    const settings = configPath(homes, 'claude-code');
    assert.equal(fs.existsSync(settings), true, 'the healthy hook still reaches the app config');
    assert.deepEqual(eventGroups(settings, 'UserPromptSubmit'), [LINT_RENDERED]);

    // 0.4 THREW on a malformed ~/.asb/hooks file
    // `Failed to parse hook "broken": ...`), aborting the whole load, and
    // skipped an unknown enabled id silently. Per-entry containment is the
    // 0.5 deviation, reported as the sibling rules/skills library-level rows.
    const broken = hooksRows(report).find((entry) => entry.id === 'broken');
    assert.equal(broken?.app, null, 'the malformed library hook gets its own row');
    assert.equal(broken?.outcome, 'failed');
    assert.equal(broken?.detail, 'parse-error');

    const ghost = hooksRows(report).find((entry) => entry.id === 'ghost');
    assert.equal(ghost?.app, null, 'the enabled-but-absent id gets its own row');
    assert.equal(ghost?.outcome, 'missing');

    assert.notEqual(report.exitCode, 0, 'neither failure is silent');
  });
});

test('a codex hooks write reports the trust review Codex still requires', async () => {
  const LIBRARY = {
    UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo t' }] }],
  };

  // Codex records trust against each hook's current hash and skips new or
  // changed non-managed hooks until they are reviewed, so a written hooks.json
  // is not yet a running hook. Distribution cannot establish that trust, so it
  // has to name the step instead of letting `written` imply it.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'claude-code');
    seedHook(homes, 'trust', LIBRARY);
    writeUserConfig(homes, configFor(['codex', 'claude-code'], ['trust']));

    const first = await runSync();

    const codex = hooksRows(first).find((entry) => entry.app === 'codex' && entry.id === null);
    assert.equal(codex?.outcome, 'written');
    assert.match(String(codex?.reason), /\/hooks in Codex/);
    assert.match(String(codex?.reason), /codex exec/);

    // The notice is Codex's gate, not a property of distributing hooks.
    const claude = hooksRows(first).find(
      (entry) => entry.app === 'claude-code' && entry.id === null
    );
    assert.equal(claude?.outcome, 'written');
    assert.equal(claude?.reason, undefined);

    // An unchanged config is not a new review: only a write carries it.
    const second = await runSync();
    const quiet = hooksRows(second).find((entry) => entry.app === 'codex' && entry.id === null);
    assert.equal(quiet?.outcome, 'unchanged');
    assert.equal(quiet?.reason, undefined);
  });

  // Deselecting everything empties the hook map; a foreign top-level key keeps
  // the file, and an emptied map leaves nothing to review.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'trust', LIBRARY);
    writeJson(configPath(homes, 'codex'), { preferredNotifChannel: 'desktop' });
    writeUserConfig(homes, configFor(['codex'], ['trust']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    const cleared = hooksRows(await runSync()).find((entry) => entry.id === null);

    assert.equal(cleared?.detail, 'cleared');
    assert.equal(cleared?.reason, undefined);
  });

  // A write that only removes asks for no review, even beside a foreign hook
  // that keeps the file non-empty.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'trust', LIBRARY);
    writeJson(configPath(homes, 'codex'), {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: "echo 'foreign'" }],
          },
        ],
      },
    });
    writeUserConfig(homes, configFor(['codex'], ['trust']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    const removal = hooksRows(await runSync()).find((entry) => entry.id === null);

    assert.equal(removal?.outcome, 'written');
    assert.equal(removal?.detail, 'merged', 'the foreign hook keeps the file');
    assert.equal(removal?.reason, undefined, 'nothing new needs a review');
  });
});
