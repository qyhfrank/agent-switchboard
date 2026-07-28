import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../../src/engine/cli.js';
import type { Report, ReportEntry } from '../../src/engine/report.js';
import {
  installApps,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Ownership honesty for the hooks cell: what asb may remove, what it may
 * claim, and what it must say when it cannot do either. Every claim is a file
 * assertion on the app config, the distributed bundle, and the peer record,
 * with the report row asserted beside it.
 *
 * Frozen anchors: design lines 84-87 (removal by deselection only; convention
 * grants update, never deletion), 0.4 `src/hooks/distribution.ts:296-304`
 * (bundle-copy error aborts before the config merge),
 * `src/hooks/target-config.ts:100-112` (`deleteJsonConfig` empties a symlinked
 * config through the link).
 */

type HookApp = 'claude-code' | 'codex';

const APP_DIR: Record<HookApp, string> = { 'claude-code': '.claude', codex: '.codex' };

// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const HOOK_DIR = '${HOOK_DIR}';

const RUN_SH = '#!/bin/sh\necho bt\n';

function configPath(homes: ScratchHomes, app: HookApp): string {
  const file = app === 'claude-code' ? 'settings.json' : 'hooks.json';
  return path.join(homes.agentsHome, APP_DIR[app], file);
}

function managedParent(homes: ScratchHomes, app: HookApp): string {
  return path.join(homes.agentsHome, APP_DIR[app], 'hooks', 'managed');
}

function managedDir(homes: ScratchHomes, app: HookApp, id: string): string {
  return path.join(managedParent(homes, app), id);
}

function statePath(homes: ScratchHomes, app: HookApp): string {
  return path.join(homes.asbHome, 'state', 'hooks', `${app}.json`);
}

function seedHook(homes: ScratchHomes, id: string, hooks: unknown): string {
  const dir = path.join(homes.asbHome, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ name: id, hooks }, null, 2), 'utf-8');
  return filePath;
}

/** Seed a bundle hook whose single command runs the distributed script. */
function seedRunner(homes: ScratchHomes, id: string, script = RUN_SH): string {
  const dir = path.join(homes.asbHome, 'hooks', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'hook.json'),
    JSON.stringify(
      {
        name: id,
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }],
        },
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(dir, 'run.sh'), script, 'utf-8');
  return dir;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function eventGroups(filePath: string, event: string): Array<Record<string, unknown>> {
  const hooks = readJson(filePath).hooks as Record<string, unknown[]> | undefined;
  return (hooks?.[event] ?? []) as Array<Record<string, unknown>>;
}

function configFor(apps: readonly string[], hooks: readonly string[]): string {
  const list = (ids: readonly string[]) => ids.map((id) => `"${id}"`).join(', ');
  return `[applications]\nenabled = [${list(apps)}]\n\n[hooks]\nenabled = [${list(hooks)}]\n`;
}

function hooksRows(report: Report): ReportEntry[] {
  return report.entries.filter((entry) => entry.type === 'hooks');
}

// ---------------------------------------------------------------------------
// Removal is authorized by deselection alone (design :87)
// ---------------------------------------------------------------------------

/**
 * A library entry that breaks or vanishes while still selected must not
 * cascade into a removal: the groups stay in the config, the payload stays on
 * disk, and the record keeps claiming it. Only the library row reports.
 */
for (const [label, breakLibrary, expected] of [
  [
    'malformed',
    (homes: ScratchHomes) =>
      fs.writeFileSync(path.join(homes.asbHome, 'hooks', 'fmt', 'hook.json'), '{ "hooks": '),
    'failed',
  ],
  [
    'absent',
    (homes: ScratchHomes) =>
      fs.rmSync(path.join(homes.asbHome, 'hooks', 'fmt'), { recursive: true, force: true }),
    'missing',
  ],
] as const) {
  test(`a still-selected hook whose library entry goes ${label} keeps everything it has`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedRunner(homes, 'fmt');
      writeUserConfig(homes, configFor(['claude-code'], ['fmt']));

      await runSync();
      const settings = configPath(homes, 'claude-code');
      const distributed = eventGroups(settings, 'UserPromptSubmit');
      assert.equal(distributed.length, 1, 'precondition: the hook is distributed');
      const bundle = managedDir(homes, 'claude-code', 'fmt');
      assert.equal(fs.existsSync(path.join(bundle, 'run.sh')), true);

      // The library half-arrives or corrupts; the selection never changes.
      breakLibrary(homes);
      const report = await runSync();

      assert.deepEqual(
        eventGroups(settings, 'UserPromptSubmit'),
        distributed,
        'the distributed groups stay in the app config'
      );
      assert.equal(
        fs.readFileSync(path.join(bundle, 'run.sh'), 'utf-8'),
        RUN_SH,
        'the distributed payload is untouched'
      );
      assert.deepEqual(
        readJson(statePath(homes, 'claude-code')).bundles,
        ['fmt'],
        'the record keeps claiming what is still distributed'
      );

      const rows = hooksRows(report);
      const library = rows.find((entry) => entry.app === null && entry.id === 'fmt');
      assert.equal(library?.outcome, expected, 'the library row is the only report');
      assert.equal(
        rows.some((entry) => entry.outcome === 'removed'),
        false,
        'a half-arrived library sync removes nothing'
      );
      assert.equal(report.exitCode, 1, 'the broken entry still fails the run');

      if (expected === 'missing') {
        assert.match(
          library?.reason ?? '',
          /hooks\/fmt\/hook\.json/,
          'the hint names the bundle layout the entry actually uses'
        );
      }
    });
  });
}

/**
 * A healthy sibling of a broken entry must still distribute — the retention
 * above is per-id containment, not a per-app freeze.
 */
test('a broken entry does not hold back a healthy hook selected beside it', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'good', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo good' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['good', 'ghost']));

    await runSync();

    const settings = configPath(homes, 'claude-code');
    assert.equal(eventGroups(settings, 'PreToolUse').length, 1, 'the healthy hook still lands');
  });
});

// ---------------------------------------------------------------------------
// A bundle that did not land authorizes nothing (quarry risk #8)
// ---------------------------------------------------------------------------

test('a bundle that fails to distribute blocks that app config and its record', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'bt');
    // hooks/managed is a regular file, so every write beneath it is ENOTDIR.
    const parent = managedParent(homes, 'claude-code');
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, 'not a directory', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    const report = await runSync();

    const settings = configPath(homes, 'claude-code');
    assert.equal(
      fs.existsSync(settings),
      false,
      'no config points at payload this run never distributed'
    );
    assert.equal(
      fs.existsSync(statePath(homes, 'claude-code')),
      false,
      'no peer record claims a directory asb never wrote'
    );

    const rows = hooksRows(report);
    assert.equal(rows.find((entry) => entry.id === 'bt')?.outcome, 'failed');
    const config = rows.find((entry) => entry.app === 'claude-code' && entry.id === null);
    assert.equal(config?.outcome, 'skipped', 'the config row says it was held back');
    assert.match(config?.reason ?? '', /\bbt\b/, 'and names the bundle that held it back');
    assert.equal(report.exitCode, 1);

    // The harm the gate prevents: user content later placed at that path must
    // not be deletable by a deselection asb never earned authority over.
    fs.rmSync(parent);
    const userDir = managedDir(homes, 'claude-code', 'bt');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'user-secret.txt'), 'mine', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], []));

    await runSync();

    assert.equal(
      fs.existsSync(path.join(userDir, 'user-secret.txt')),
      true,
      'asb never wrote this directory, so no later run deletes it'
    );
  });
});

/**
 * The gate covers every way a bundle write can fail, not just the one the
 * repro used: 0.4 writes bundles through symlinked managed parents, so both
 * link shapes are preconditions a real tree already produces.
 */
for (const [label, sabotage, outcome] of [
  [
    'a symlinked bundle directory',
    (homes: ScratchHomes) => {
      fs.mkdirSync(path.join(homes.root, 'elsewhere'), { recursive: true });
      fs.mkdirSync(managedParent(homes, 'claude-code'), { recursive: true });
      fs.symlinkSync(path.join(homes.root, 'elsewhere'), managedDir(homes, 'claude-code', 'bt'));
    },
    'conflict',
  ],
  [
    'a symlinked managed parent',
    (homes: ScratchHomes) => {
      const parent = managedParent(homes, 'claude-code');
      fs.mkdirSync(path.join(homes.root, 'elsewhere'), { recursive: true });
      fs.mkdirSync(path.dirname(parent), { recursive: true });
      fs.symlinkSync(path.join(homes.root, 'elsewhere'), parent);
    },
    'blocked',
  ],
] as const) {
  test(`${label} holds back the config and the record too`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedRunner(homes, 'bt');
      sabotage(homes);
      writeUserConfig(homes, configFor(['claude-code'], ['bt']));

      const report = await runSync();

      assert.equal(fs.existsSync(configPath(homes, 'claude-code')), false, 'config untouched');
      assert.equal(fs.existsSync(statePath(homes, 'claude-code')), false, 'record untouched');
      const rows = hooksRows(report);
      assert.equal(rows.find((entry) => entry.id === 'bt')?.outcome, outcome);
      assert.equal(
        rows.find((entry) => entry.app === 'claude-code' && entry.id === null)?.outcome,
        'skipped'
      );
      assert.equal(report.exitCode, 1);
    });
  });
}

// ---------------------------------------------------------------------------
// Convention grants adoption-for-update, never deletion (design :84/:86)
// ---------------------------------------------------------------------------

test('a first sync into a name-colliding managed directory deletes nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'deploy', '#!/bin/sh\necho library\n');
    const target = managedDir(homes, 'claude-code', 'deploy');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'notes.md'), 'user notes', 'utf-8');
    fs.writeFileSync(path.join(target, 'run.sh'), '#!/bin/sh\necho mine\n', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], ['deploy']));

    await runSync();

    assert.equal(
      fs.readFileSync(path.join(target, 'notes.md'), 'utf-8'),
      'user notes',
      'an unrecorded sibling survives first contact'
    );
    assert.equal(
      fs.readFileSync(path.join(target, 'run.sh'), 'utf-8'),
      '#!/bin/sh\necho library\n',
      'the name-matched file is adopted for update'
    );

    // That write records the id, which is the proof later syncs reconcile on.
    fs.writeFileSync(path.join(target, 'stray.txt'), 'later', 'utf-8');
    await runSync();

    assert.deepEqual(
      fs.readdirSync(target).sort(),
      ['hook.json', 'run.sh'],
      'once recorded, the bundle reconciles to the library tree'
    );
  });
});

// ---------------------------------------------------------------------------
// A removal that cannot delete is never reported as one
// ---------------------------------------------------------------------------

test('a bundle removal that cannot delete reports left-behind and keeps the claim', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'bt');
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));
    await runSync();

    const bundle = managedDir(homes, 'claude-code', 'bt');
    assert.equal(fs.existsSync(path.join(bundle, 'run.sh')), true, 'precondition: distributed');

    writeUserConfig(homes, configFor(['claude-code'], []));
    fs.chmodSync(bundle, 0o555);
    let report: Report;
    try {
      report = await runSync();
    } finally {
      fs.chmodSync(bundle, 0o755);
    }

    assert.equal(
      fs.existsSync(path.join(bundle, 'run.sh')),
      true,
      'precondition: the payload could not be deleted'
    );
    const row = hooksRows(report).find((entry) => entry.id === 'bt');
    assert.equal(row?.outcome, 'left-behind', 'a failed deletion is not a removal');
    assert.match(row?.reason ?? '', new RegExp(bundle), 'the row names what is still on disk');
    assert.equal(report.exitCode, 1, 'and the run fails');

    assert.deepEqual(
      readJson(statePath(homes, 'claude-code')).bundles,
      ['bt'],
      'the record never claims less than what remains distributed'
    );
  });
});

// ---------------------------------------------------------------------------
// A symlinked config keeps its link (0.4 deleteJsonConfig)
// ---------------------------------------------------------------------------

test('a symlinked codex hooks.json is emptied through the link, never unlinked', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', {
      UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo c1' }] }],
    });
    const store = path.join(homes.root, 'dotfiles', 'hooks.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, '{}\n', 'utf-8');
    const hooksJson = configPath(homes, 'codex');
    fs.mkdirSync(path.dirname(hooksJson), { recursive: true });
    fs.symlinkSync(store, hooksJson);
    writeUserConfig(homes, configFor(['codex'], ['clean']));

    await runSync();
    assert.equal(eventGroups(store, 'UserPromptSubmit').length, 1, 'the groups land in the store');

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();

    assert.equal(
      fs.lstatSync(hooksJson).isSymbolicLink(),
      true,
      "the user's link survives deselection"
    );
    assert.equal(
      fs.readFileSync(store, 'utf-8'),
      '{}\n',
      'the managed groups leave through the link instead of orphaning in the store'
    );
  });
});

// ---------------------------------------------------------------------------
// explain covers hooks, with the peer record as the owner
// ---------------------------------------------------------------------------

test('explain resolves hooks by id, app, and path with a peer-record owner', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'bt');
    seedHook(homes, 'lint', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['bt', 'lint', 'ghost']));
    await runSync();

    const bundleSlices = await runExplain('bt');
    const bundle = bundleSlices.find(
      (slice) => slice.path === managedDir(homes, 'claude-code', 'bt')
    );
    assert.equal(bundle?.app, 'claude-code', 'a distributed bundle explains to its app slice');
    assert.equal(
      bundle?.provenance,
      'peer-record',
      'hook ownership is the peer record, never a ledger entry'
    );
    assert.deepEqual(bundle?.components, [
      { id: 'bt', path: path.join(homes.asbHome, 'hooks', 'bt') },
    ]);

    // A definition hook owns no directory; its slice is the app config.
    const settings = configPath(homes, 'claude-code');
    const definition = (await runExplain('lint')).find((slice) => slice.path === settings);
    assert.equal(definition?.app, 'claude-code');
    assert.equal(definition?.provenance, 'peer-record');

    // A selected id the library lacks explains to its library row, not silence.
    const ghost = await runExplain('ghost');
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0]?.app, null);
    assert.equal(ghost[0]?.outcome, 'missing');
  });
});

test('a deferred removal is named, never silent, while the library is unresolved', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const alphaDir = path.join(homes.asbHome, 'hooks', 'alpha');
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.writeFileSync(
      path.join(alphaDir, 'hook.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }],
        },
      })
    );
    fs.writeFileSync(path.join(alphaDir, 'run.sh'), RUN_SH);
    fs.chmodSync(path.join(alphaDir, 'run.sh'), 0o755);
    const betaPath = seedHook(homes, 'beta', {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo beta' }] }],
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["alpha", "beta"]\n'
    );
    assert.equal((await runSync()).exitCode, 0, 'both distributed');

    fs.writeFileSync(betaPath, '{ not json', 'utf-8');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["beta"]\n'
    );
    const report = await runSync();

    // The deferral itself is by design; silence about it is not.
    const row = report.entries.find(
      (entry) => entry.app === 'claude-code' && entry.type === 'hooks' && entry.id === 'alpha'
    );
    assert.equal(row?.outcome, 'skipped');
    assert.equal(row?.detail, 'not-selected');
    assert.match(row?.reason ?? '', /beta/);
    assert.equal(fs.existsSync(managedDir(homes, 'claude-code', 'alpha')), true, 'deferred, kept');
    assert.equal(report.exitCode, 1);
  });
});

test('a device-scoped duplicate does not double the config while the entry is broken', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const d1 = seedHook(homes, 'd1', {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo d1' }] }],
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["d1"]\n'
    );
    assert.equal((await runSync()).exitCode, 0);

    // A v0.4.32 device-scoped copy holds the same group; merges concatenate
    // by design so count-bounded removal can strip N — re-merge must not.
    const deviceDir = path.join(homes.asbHome, 'state', 'hooks', '0123456789abcdef');
    fs.mkdirSync(deviceDir, { recursive: true });
    fs.copyFileSync(statePath(homes, 'claude-code'), path.join(deviceDir, 'claude-code.json'));
    fs.writeFileSync(d1, '{ not json', 'utf-8');
    const report = await runSync();

    const settings = JSON.parse(fs.readFileSync(configPath(homes, 'claude-code'), 'utf-8'));
    assert.equal(
      settings.hooks.UserPromptSubmit.length,
      1,
      'the retained group appears once, not once per device copy'
    );
    assert.equal(report.exitCode, 1, 'the broken entry still reports');
  });
});
