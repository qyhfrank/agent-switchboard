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
 * grants update, never deletion), the 0.4 bundle-copy abort before config
 * merge, and `deleteJsonConfig` emptying a symlinked config through the link.
 */

type HookApp = 'claude-code' | 'codex';

const APP_DIR: Record<HookApp, string> = { 'claude-code': '.claude', codex: '.codex' };

// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
const HOOK_DIR = '${HOOK_DIR}';

const RUN_SH = '#!/bin/sh\necho bt\n';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

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

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
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
  test(`${label} holds back the config too`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedRunner(homes, 'bt');
      sabotage(homes);
      writeUserConfig(homes, configFor(['claude-code'], ['bt']));

      const report = await runSync();

      assert.equal(fs.existsSync(configPath(homes, 'claude-code')), false, 'config untouched');
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

test('a first sync into a name-colliding managed directory brings it to the render', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'deploy', '#!/bin/sh\necho library\n');
    const target = managedDir(homes, 'claude-code', 'deploy');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'notes.md'), 'user notes', 'utf-8');
    fs.writeFileSync(path.join(target, 'run.sh'), '#!/bin/sh\necho mine\n', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], ['deploy']));

    await runSync();

    // A distributed bundle is a copy of its library directory, so the tree is
    // brought to the render in one pass. That is what makes it provably asb's
    // for a later deselection.
    assert.deepEqual(fs.readdirSync(target).sort(), ['hook.json', 'run.sh']);
    assert.equal(
      fs.readFileSync(path.join(target, 'run.sh'), 'utf-8'),
      '#!/bin/sh\necho library\n'
    );

    fs.writeFileSync(path.join(target, 'stray.txt'), 'later', 'utf-8');
    await runSync();

    assert.deepEqual(
      fs.readdirSync(target).sort(),
      ['hook.json', 'run.sh'],
      'and it stays that copy'
    );
  });
});

// ---------------------------------------------------------------------------
// A removal that cannot delete is never reported as one
// ---------------------------------------------------------------------------

test('a bundle removal that cannot delete reports left-behind instead', async () => {
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
    assert.equal(report.exitCode, 0, 'reported, but the run itself did nothing wrong');
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
// explain covers hooks, with the owner derived from the render
// ---------------------------------------------------------------------------

test('explain resolves hooks by id, app, and path with a derived owner', async () => {
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
      'identity',
      'a distributed bundle is asb’s because it holds what the library renders'
    );
    assert.deepEqual(bundle?.components, [
      { id: 'bt', path: path.join(homes.asbHome, 'hooks', 'bt') },
    ]);

    // A definition hook owns no directory; its slice is the app config.
    const settings = configPath(homes, 'claude-code');
    const definition = (await runExplain('lint')).find((slice) => slice.path === settings);
    assert.equal(definition?.app, 'claude-code');
    assert.equal(
      definition?.provenance,
      null,
      'the app config is the user’s file whichever groups inside it derive'
    );

    // A selected id the library lacks explains to its library row, not silence.
    const ghost = await runExplain('ghost');
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0]?.app, null);
    assert.equal(ghost[0]?.outcome, 'missing');
  });
});

test('an unresolved entry keeps its groups and its bundle, and rewrites nothing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const betaDir = seedRunner(homes, 'beta');
    writeUserConfig(homes, configFor(['claude-code'], ['beta']));
    assert.equal((await runSync()).exitCode, 0, 'the bundle is distributed');

    const settings = configPath(homes, 'claude-code');
    const beforeConfig = fs.readFileSync(settings, 'utf-8');
    fs.writeFileSync(path.join(betaDir, 'hook.json'), '{ not json', 'utf-8');
    const report = await runSync();

    // The entry cannot be rendered, so nothing it put in place can be compared
    // against one: the groups and the bundle stay exactly where they are and
    // only the library row reports.
    assert.equal(fs.readFileSync(settings, 'utf-8'), beforeConfig, 'the config is retained');
    assert.equal(
      fs.existsSync(managedDir(homes, 'claude-code', 'beta')),
      true,
      'bundle is retained'
    );
    const rows = hooksRows(report);
    assert.equal(
      rows.find((entry) => entry.app === null && entry.id === 'beta')?.outcome,
      'failed'
    );
    assert.deepEqual(
      rows.filter((entry) => entry.app === 'claude-code'),
      [],
      'a library that cannot render produces no app-level row at all'
    );
    assert.equal(report.exitCode, 1);
  });
});

/**
 * Predecessor evidence names asb without naming which hook, so a group holding
 * it belongs to no selection: an entry that cannot render is no reason to keep
 * one, and no reason to hand it back into the config either.
 */
for (const [label, group] of [
  [
    'a legacy marker',
    {
      matcher: 'marked',
      hooks: [{ type: 'command', command: 'echo legacy\n# asb-managed-by=agent-switchboard' }],
    },
  ],
  [
    'a v0.4.28 managed path',
    {
      matcher: 'v0428',
      hooks: [{ type: 'command', command: `$HOME/.claude/hooks/managed/${HEX64_A}/run.sh` }],
    },
  ],
] as const) {
  test(`a group recognized by ${label} leaves even while an entry is unresolved`, async () => {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      const betaDir = seedRunner(homes, 'beta');
      writeUserConfig(homes, configFor(['claude-code'], ['beta']));
      assert.equal((await runSync()).exitCode, 0, 'the bundle is distributed');

      // The entry breaks, and the config no longer holds anything the record
      // recorded — the only asb-looking group left is recognized, not recorded.
      fs.writeFileSync(path.join(betaDir, 'hook.json'), '{ not json', 'utf-8');
      const settings = configPath(homes, 'claude-code');
      writeJson(settings, {
        hooks: {
          PreToolUse: [
            { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
            group,
          ],
        },
      });

      const report = await runSync();

      assert.deepEqual(
        commandsOf(eventGroups(settings, 'PreToolUse')),
        ['echo mine'],
        'the recognized group is removed, never handed back as stranded'
      );
      assert.equal(
        hooksRows(report).find((entry) => entry.app === null && entry.id === 'beta')?.outcome,
        'failed',
        'the unresolved entry is the only thing reported'
      );
    });
  });
}

// ---------------------------------------------------------------------------
// 0.4 ownership recognizers: shared machines and predecessor evidence
// ---------------------------------------------------------------------------

test('two machines sharing ASB_HOME do not duplicate bundles across two alternations', async () => {
  await withScratchHomes(async (homes) => {
    seedRunner(homes, 'alpha');
    seedRunner(homes, 'beta');

    const machine = async (name: string, selected: string[]): Promise<ScratchHomes> => {
      const profile: ScratchHomes = {
        ...homes,
        agentsHome: path.join(homes.root, name, 'agents-home'),
        stateHome: path.join(homes.root, name, 'state'),
      };
      process.env.ASB_AGENTS_HOME = profile.agentsHome;
      process.env.ASB_STATE_HOME = profile.stateHome;
      installApps(profile, 'claude-code');
      writeUserConfig(homes, configFor(['claude-code'], selected));
      assert.equal((await runSync()).exitCode, 0, `${name} sync succeeds`);
      return profile;
    };

    const a = await machine('machine-a', ['alpha', 'beta']);
    assert.equal(eventGroups(configPath(a, 'claude-code'), 'UserPromptSubmit').length, 2);
    const b = await machine('machine-b', ['alpha']);
    assert.equal(eventGroups(configPath(b, 'claude-code'), 'UserPromptSubmit').length, 1);

    for (let alternation = 1; alternation <= 2; alternation++) {
      await machine('machine-a', ['alpha', 'beta']);
      assert.equal(
        eventGroups(configPath(a, 'claude-code'), 'UserPromptSubmit').length,
        2,
        `machine A alternation ${alternation}`
      );
      await machine('machine-b', ['alpha']);
      assert.equal(
        eventGroups(configPath(b, 'claude-code'), 'UserPromptSubmit').length,
        1,
        `machine B alternation ${alternation}`
      );
    }
  });
});

test('a repeated sync duplicates neither a bundle nor a definition hook', async () => {
  for (const kind of ['bundle', 'definition'] as const) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      const id = kind === 'bundle' ? 'bundle-test' : 'definition-test';
      const event = kind === 'bundle' ? 'UserPromptSubmit' : 'PreToolUse';
      if (kind === 'bundle') {
        seedRunner(homes, id);
      } else {
        seedHook(homes, id, {
          PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo definition' }] }],
        });
      }
      writeUserConfig(homes, configFor(['claude-code'], [id]));

      await runSync();
      await runSync();
      // Both kinds are recognized without a record: the bundle by the managed
      // path its command names, the definition by being what the library
      // renders. Neither is appended a second time.
      assert.equal(eventGroups(configPath(homes, 'claude-code'), event).length, 1, kind);

      await runSync();
      assert.equal(
        eventGroups(configPath(homes, 'claude-code'), event).length,
        1,
        `${kind} converges`
      );
    });
  }
});

test('a byte-identical hand-written definition group is adopted, not duplicated', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const group = { matcher: '*', hooks: [{ type: 'command', command: 'echo same' }] };
    seedHook(homes, 'same', { PreToolUse: [group] });
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, { hooks: { PreToolUse: [group] } });
    writeUserConfig(homes, configFor(['claude-code'], ['same']));

    await runSync();
    // Nothing distinguishes it from what asb would have written, so asb does
    // not write a second copy beside it — and deselection takes it out again.
    assert.deepEqual(eventGroups(settings, 'PreToolUse'), [group], 'no duplicate is appended');

    writeUserConfig(homes, configFor(['claude-code'], []));
    await runSync();
    assert.equal(readJson(settings).hooks, undefined, 'the group goes out with the selection');
  });
});

test('legacy markers, tags, and paths are recognition evidence', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const renderedGroup = {
      matcher: 'rendered',
      hooks: [{ type: 'command', command: 'echo rendered' }],
    };
    seedHook(homes, 'test-hook', { PreToolUse: [renderedGroup] });
    writeUserConfig(homes, configFor(['claude-code'], ['test-hook']));

    const legacyRoot = path.join(homes.agentsHome, '.claude', 'hooks', 'asb');
    const legacyDir = path.join(legacyRoot, 'old-thing');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'run.sh'), RUN_SH);
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      theme: 'dark',
      hooks: {
        PreToolUse: [
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
          {
            matcher: 'marked',
            hooks: [
              {
                type: 'command',
                command: 'echo legacy\n# asb-managed-by=agent-switchboard\n# asb-hook-id=x',
              },
            ],
          },
          {
            matcher: 'tagged',
            hooks: [{ type: 'command', command: 'echo tagged' }],
            _asb_source: true,
          },
          renderedGroup,
          {
            matcher: 'legacy-path',
            hooks: [{ type: 'command', command: `${legacyDir}/run.sh` }],
          },
        ],
      },
      _asb_managed_hooks: ['x'],
    });

    await runSync();

    const raw = fs.readFileSync(settings, 'utf-8');
    assert.equal(raw.includes('_asb'), false);
    assert.equal(raw.includes('asb-managed'), false);
    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')).sort(), [
      'echo mine',
      'echo rendered',
    ]);
    assert.equal(readJson(settings).theme, 'dark');
    assert.equal(fs.existsSync(legacyDir), true, 'M8 leaves legacy bundle directories untouched');
  });
});

test('legacy hook ids preserve multiple group positions within one event', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'alpha', {
      PreToolUse: [{ matcher: 'alpha', hooks: [{ type: 'command', command: 'echo alpha' }] }],
    });
    seedHook(homes, 'beta', {
      PreToolUse: [{ matcher: 'beta', hooks: [{ type: 'command', command: 'echo beta' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'alpha',
            hooks: [{ type: 'command', command: 'echo alpha\n# asb-hook-id=alpha' }],
          },
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
          {
            matcher: 'beta',
            hooks: [{ type: 'command', command: 'echo beta\n# asb-hook-id=beta' }],
          },
        ],
      },
    });

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(
      eventGroups(settings, 'PreToolUse').map((group) => group.matcher),
      ['alpha', 'user', 'beta']
    );
  });
});

test('v0.4.28 hash-path groups are reclaimed without deleting their directories', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, configFor(['claude-code'], []));
    const namespace = path.join(managedParent(homes, 'claude-code'), HEX64_A);
    const bundle = path.join(namespace, HEX64_B);
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'run.sh'), RUN_SH);
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      hooks: {
        PreToolUse: [
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
          { matcher: 'v0428', hooks: [{ type: 'command', command: `${bundle}/run.sh` }] },
        ],
      },
    });

    await runSync();

    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')), ['echo mine']);
    assert.equal(fs.existsSync(bundle), true, 'recognition never authorizes directory deletion');
  });
});

test('a URL containing a v0.4.28-shaped path is not ownership evidence', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, configFor(['claude-code'], []));
    const settings = configPath(homes, 'claude-code');
    const urlGroup = {
      matcher: 'url',
      hooks: [
        {
          type: 'command',
          command: `curl https://example.com/hooks/managed/${HEX64_A}/run.sh`,
        },
      ],
    };
    writeJson(settings, { hooks: { PreToolUse: [urlGroup] } });

    await runSync();

    assert.deepEqual(eventGroups(settings, 'PreToolUse'), [urlGroup]);
  });
});

test('legacy marker lines in library definitions are stripped before distribution', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'marked', {
      PreToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command:
                'echo run\n# asb-managed-by=agent-switchboard\n# asb-hook-id=x\n# asb-bundle-sha256=y',
            },
          ],
        },
      ],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['marked']));

    await runSync();

    const settings = configPath(homes, 'claude-code');
    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')), ['echo run']);
    assert.equal(fs.readFileSync(settings, 'utf-8').includes('asb-managed'), false);
  });
});

test('known foreign-home bundle ids are reclaimed while unknown ids stay user-owned', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    seedRunner(homes, 'bundle-test');
    writeUserConfig(homes, configFor(['claude-code', 'codex'], ['bundle-test']));

    for (const app of ['claude-code', 'codex'] as const) {
      const local = path.join(managedDir(homes, app, 'bundle-test'), 'run.sh');
      const foreign = `/foreign/home/${APP_DIR[app]}/hooks/managed/bundle-test/run.sh`;
      const unknown = `/foreign/home/${APP_DIR[app]}/hooks/managed/not-an-asb-hook/run.sh`;
      writeJson(configPath(homes, app), {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: foreign }] },
            { hooks: [{ type: 'command', command: local }] },
            { hooks: [{ type: 'command', command: unknown }] },
            { hooks: [{ type: 'command', command: 'echo mine' }] },
          ],
        },
      });
    }

    await runSync();

    for (const app of ['claude-code', 'codex'] as const) {
      const local = path.join(managedDir(homes, app, 'bundle-test'), 'run.sh');
      const foreign = `/foreign/home/${APP_DIR[app]}/hooks/managed/bundle-test/run.sh`;
      const unknown = `/foreign/home/${APP_DIR[app]}/hooks/managed/not-an-asb-hook/run.sh`;
      const commands = commandsOf(eventGroups(configPath(homes, app), 'UserPromptSubmit'));
      assert.equal(commands.includes(foreign), false, `${app}: known foreign path reclaimed`);
      assert.equal(
        commands.filter((command) => command === local).length,
        1,
        `${app}: one live group`
      );
      assert.equal(commands.includes(unknown), true, `${app}: unknown id preserved`);
      assert.equal(commands.includes('echo mine'), true, `${app}: user command preserved`);
    }
  });
});

// ---------------------------------------------------------------------------
// A predecessor's group keeps its place and stays named
// ---------------------------------------------------------------------------

test('a predecessor group is named even after its hook leaves the selection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'alpha', {
      UserPromptSubmit: [{ matcher: 'go', hooks: [{ type: 'command', command: 'echo v2' }] }],
    });
    const settings = configPath(homes, 'claude-code');
    // What an earlier render of `alpha` left: same event and matcher, older
    // command. Nothing on disk says which hook wrote it, and the library's
    // current render no longer matches it.
    writeJson(settings, {
      hooks: {
        UserPromptSubmit: [{ matcher: 'go', hooks: [{ type: 'command', command: 'echo v1' }] }],
      },
    });

    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    const selected = await runSync();
    assert.ok(
      hooksRows(selected).some((row) => row.outcome === 'left-behind' && row.detail === 'unproven'),
      JSON.stringify(selected.entries, null, 2)
    );

    // Deselecting takes the render away. The predecessor group is still not
    // asb's to remove and still kin to a hook the library defines, so the run
    // still says where it is.
    writeUserConfig(homes, configFor(['claude-code'], []));
    const deselected = await runSync();

    assert.deepEqual(commandsOf(eventGroups(settings, 'UserPromptSubmit')), ['echo v1']);
    assert.ok(
      hooksRows(deselected).some(
        (row) => row.outcome === 'left-behind' && row.detail === 'unproven'
      ),
      `the group is still there, so the run still names it: ${JSON.stringify(deselected.entries, null, 2)}`
    );
  });
});

test('a marked group an earlier version wrote is rewritten where it sits', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'alpha', {
      UserPromptSubmit: [{ matcher: 'go', hooks: [{ type: 'command', command: 'echo alpha' }] }],
    });
    writeUserConfig(homes, configFor(['codex'], ['alpha']));

    // Codex keys its trust by array position, so the group below the marked
    // one must not move when the marked one is rewritten.
    const settings = configPath(homes, 'codex');
    writeJson(settings, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: 'go',
            hooks: [{ type: 'command', command: 'echo alpha\n# asb-managed-by=agent-switchboard' }],
          },
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
        ],
      },
    });

    assert.equal((await runSync()).exitCode, 0);

    assert.deepEqual(
      commandsOf(eventGroups(settings, 'UserPromptSubmit')),
      ['echo alpha', 'echo mine'],
      'the marked group loses its marker in place, and the user group keeps index 1'
    );
  });
});
