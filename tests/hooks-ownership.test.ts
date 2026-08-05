import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import type { Report } from '../src/engine/report.js';
import {
  APP_DIR,
  commandsOf,
  configFor,
  configPath,
  eventGroups,
  HOOK_DIR,
  hooksRows,
  managedDir,
  managedParent,
  RUN_SH,
  readJson,
  seedHook,
  seedHookBundle,
  seedRunner,
  writeJson,
} from './helpers/hooks.js';
import {
  installApps,
  type ScratchHomes,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * Ownership honesty for the hooks cell: what asb may remove, what it may claim,
 * and what it must say when it cannot do either. Removal is authorized by
 * deselection alone, convention grants adoption-for-update but never deletion,
 * and a group asb cannot prove is named rather than swept. Every claim is a
 * file assertion on the app config and the distributed bundle, with the report
 * row asserted beside it.
 */

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

/**
 * A library entry that breaks while still selected must not cascade into a
 * removal: the groups stay in the config byte for byte, the payload stays on
 * disk, and only the library row reports.
 */
test('a still-selected hook whose library entry goes malformed keeps everything it has', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedRunner(homes, 'fmt');
    writeUserConfig(homes, configFor(['claude-code'], ['fmt']));

    await runSync();
    const settings = configPath(homes, 'claude-code');
    assert.equal(eventGroups(settings, 'UserPromptSubmit').length, 1, 'precondition: distributed');
    const before = fs.readFileSync(settings, 'utf-8');
    const bundle = managedDir(homes, 'claude-code', 'fmt');
    assert.equal(fs.existsSync(path.join(bundle, 'run.sh')), true);

    // The library corrupts; the selection never changes.
    fs.writeFileSync(path.join(source, 'hook.json'), '{ "hooks": ');
    const report = await runSync();

    assert.equal(fs.readFileSync(settings, 'utf-8'), before, 'the app config is byte-identical');
    assert.equal(
      fs.readFileSync(path.join(bundle, 'run.sh'), 'utf-8'),
      RUN_SH,
      'the distributed payload is untouched'
    );
    const rows = hooksRows(report);
    assert.equal(rows.find((entry) => entry.app === null && entry.id === 'fmt')?.outcome, 'failed');
    assert.deepEqual(
      rows.filter((entry) => entry.app === 'claude-code'),
      [],
      'a library that cannot render produces no app-level row at all'
    );
    assert.equal(
      rows.some((entry) => entry.outcome === 'removed'),
      false,
      'a half-arrived library sync removes nothing'
    );
    assert.equal(report.exitCode, 1, 'the broken entry still fails the run');
  });
});

test('a bundle that fails to distribute holds back that app config and earns no deletion authority', async () => {
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
 * The gate covers every way a bundle write can fail, not just the one a repro
 * used: bundles are written through symlinked managed parents, so both link
 * shapes are preconditions a real tree already produces.
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

    assert.deepEqual(fs.readdirSync(target).sort(), ['hook.json', 'run.sh'], 'and it stays a copy');
  });
});

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

/**
 * Predecessor evidence names asb without naming which hook, so a group holding
 * it belongs to no selection: an entry that cannot render is no reason to keep
 * one, and no reason to hand it back into the config either.
 */
test('groups recognized by a marker or a hash path leave even while an entry is unresolved', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedRunner(homes, 'beta');
    writeUserConfig(homes, configFor(['claude-code'], ['beta']));
    assert.equal((await runSync()).exitCode, 0, 'the bundle is distributed');

    // The entry breaks, and the config no longer holds anything a record could
    // have recorded: the asb-looking groups left are recognized, not recorded.
    fs.writeFileSync(path.join(source, 'hook.json'), '{ not json', 'utf-8');
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      hooks: {
        PreToolUse: [
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
          {
            matcher: 'marked',
            hooks: [
              { type: 'command', command: 'echo legacy\n# asb-managed-by=agent-switchboard' },
            ],
          },
          {
            matcher: 'hash-path',
            hooks: [{ type: 'command', command: `$HOME/.claude/hooks/managed/${HEX64_A}/run.sh` }],
          },
        ],
      },
    });

    const report = await runSync();

    assert.deepEqual(
      commandsOf(eventGroups(settings, 'PreToolUse')),
      ['echo mine'],
      'both recognized groups are removed, never handed back as stranded'
    );
    assert.equal(
      hooksRows(report).find((entry) => entry.app === null && entry.id === 'beta')?.outcome,
      'failed',
      'the unresolved entry is the only thing reported'
    );
  });
});

test('a repeated sync duplicates neither a bundle nor a definition hook', async () => {
  for (const kind of ['bundle', 'definition'] as const) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      const id = `${kind}-hook`;
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

    const legacyDir = path.join(homes.agentsHome, '.claude', 'hooks', 'asb', 'old-thing');
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
          { matcher: 'legacy-path', hooks: [{ type: 'command', command: `${legacyDir}/run.sh` }] },
        ],
      },
      _asb_managed_hooks: ['x'],
    });

    await runSync();

    const raw = fs.readFileSync(settings, 'utf-8');
    assert.equal(raw.includes('_asb'), false, 'the retired managed-ids key goes with them');
    assert.equal(raw.includes('asb-managed'), false);
    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')).sort(), [
      'echo mine',
      'echo rendered',
    ]);
    assert.equal(readJson(settings).theme, 'dark', 'foreign keys are untouched');
    assert.equal(fs.existsSync(legacyDir), true, 'legacy bundle directories are left alone');
  });
});

/**
 * Machines share Codex trust state but may have different local hooks. ASB's
 * common groups therefore form the same prefix everywhere; local groups trail
 * it without changing their relative order.
 */
test('codex canonicalizes managed groups before machine-local groups', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedRunner(homes, 'alpha', '#!/bin/sh\necho alpha\n');
    const betaSource = seedRunner(homes, 'beta', '#!/bin/sh\necho beta\n');
    writeUserConfig(homes, configFor(['codex'], ['beta', 'alpha']));
    await runSync();

    // Model another machine's historical order: its local group occupies the
    // shared key 0, while the two ASB groups are reversed behind it.
    const hooksJson = configPath(homes, 'codex');
    const mineA = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine-a' }] };
    const mineB = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine-b' }] };
    const before = eventGroups(hooksJson, 'UserPromptSubmit');
    writeJson(hooksJson, {
      hooks: { UserPromptSubmit: [mineA, before[1], mineB, before[0]] },
    });

    const report = await runSync();

    const after = eventGroups(hooksJson, 'UserPromptSubmit');
    const trustReview =
      'Codex skips new or changed hooks until they are trusted: run /hooks in Codex to review them, or headless codex exec runs without them';
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(after, [before[0], before[1], mineA, mineB]);
    assert.match(commandsOf([after[0] ?? {}])[0] ?? '', /\/beta\/run\.sh$/);
    assert.match(commandsOf([after[1] ?? {}])[0] ?? '', /\/alpha\/run\.sh$/);
    const canonicalized = hooksRows(report).find(
      (entry) => entry.app === 'codex' && entry.id === null
    );
    assert.equal(canonicalized?.outcome, 'written');
    assert.equal(canonicalized?.reason, trustReview);

    const stable = fs.readFileSync(hooksJson, 'utf-8');
    const betaDefinition = fs.readFileSync(path.join(betaSource, 'hook.json'), 'utf-8');
    fs.writeFileSync(path.join(betaSource, 'hook.json'), '{ "hooks": ');
    await runSync();
    assert.equal(
      fs.readFileSync(hooksJson, 'utf-8'),
      stable,
      'an unresolved selected hook cannot shift a healthy sibling to a new trust key'
    );
    fs.writeFileSync(path.join(betaSource, 'hook.json'), betaDefinition);
    await runSync();

    seedRunner(homes, 'alpha', '#!/bin/sh\necho alpha\n', ' --changed');
    const update = await runSync();
    const updated = eventGroups(hooksJson, 'UserPromptSubmit');
    assert.deepEqual(updated[0], before[0], 'the unchanged managed sibling keeps its trust key');
    assert.match(commandsOf([updated[1] ?? {}])[0] ?? '', /run\.sh --changed$/);
    assert.deepEqual(updated.slice(2), [mineA, mineB]);
    assert.equal(
      hooksRows(update).find((entry) => entry.app === 'codex' && entry.id === null)?.reason,
      trustReview
    );

    writeUserConfig(homes, configFor(['codex'], ['alpha']));
    const deselection = await runSync();
    const shifted = hooksRows(deselection).find(
      (entry) => entry.app === 'codex' && entry.id === null
    );
    assert.deepEqual(eventGroups(hooksJson, 'UserPromptSubmit'), [updated[1], mineA, mineB]);
    assert.equal(shifted?.outcome, 'written');
    assert.equal(shifted?.reason, trustReview);
  });
});

test('codex defers new groups until every selected hook can form the shared prefix', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedRunner(homes, 'alpha', '#!/bin/sh\necho alpha\n');
    const betaSource = seedRunner(homes, 'beta', '#!/bin/sh\necho beta\n');
    const betaDefinition = fs.readFileSync(path.join(betaSource, 'hook.json'), 'utf-8');
    fs.writeFileSync(path.join(betaSource, 'hook.json'), '{ "hooks": ');

    const hooksJson = configPath(homes, 'codex');
    const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeJson(hooksJson, { hooks: { UserPromptSubmit: [mine] } });
    writeUserConfig(homes, configFor(['codex'], ['alpha', 'beta']));

    const partial = await runSync();

    assert.notEqual(partial.exitCode, 0, 'the malformed selection remains visible');
    assert.deepEqual(
      eventGroups(hooksJson, 'UserPromptSubmit'),
      [mine],
      'a partial selection cannot assign a healthy hook a machine-local trust key'
    );

    fs.writeFileSync(path.join(betaSource, 'hook.json'), betaDefinition);
    const recovered = await runSync();
    const groups = eventGroups(hooksJson, 'UserPromptSubmit');
    assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.entries, null, 2));
    assert.match(commandsOf([groups[0] ?? {}])[0] ?? '', /\/alpha\/run\.sh$/);
    assert.match(commandsOf([groups[1] ?? {}])[0] ?? '', /\/beta\/run\.sh$/);
    assert.deepEqual(groups[2], mine, 'recovery canonicalizes once ahead of the local tail');
  });
});

test('codex defers removals until every selected hook can form the shared prefix', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedRunner(homes, 'gamma', '#!/bin/sh\necho gamma\n');
    seedRunner(homes, 'alpha', '#!/bin/sh\necho alpha\n');
    const betaSource = seedRunner(homes, 'beta', '#!/bin/sh\necho beta\n');
    const betaDefinition = fs.readFileSync(path.join(betaSource, 'hook.json'), 'utf-8');
    writeUserConfig(homes, configFor(['codex'], ['gamma', 'alpha', 'beta']));
    await runSync();

    const hooksJson = configPath(homes, 'codex');
    const mine = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo mine' }] };
    writeJson(hooksJson, {
      hooks: { UserPromptSubmit: [...eventGroups(hooksJson, 'UserPromptSubmit'), mine] },
    });
    const stable = fs.readFileSync(hooksJson, 'utf-8');
    fs.writeFileSync(path.join(betaSource, 'hook.json'), '{ "hooks": ');
    writeUserConfig(homes, configFor(['codex'], ['alpha', 'beta']));

    await runSync();

    assert.equal(
      fs.readFileSync(hooksJson, 'utf-8'),
      stable,
      'a partial selection cannot remove a group and shift the surviving trust keys'
    );

    fs.writeFileSync(path.join(betaSource, 'hook.json'), betaDefinition);
    await runSync();
    const groups = eventGroups(hooksJson, 'UserPromptSubmit');
    assert.match(commandsOf([groups[0] ?? {}])[0] ?? '', /\/alpha\/run\.sh$/);
    assert.match(commandsOf([groups[1] ?? {}])[0] ?? '', /\/beta\/run\.sh$/);
    assert.deepEqual(groups[2], mine, 'recovery applies the deferred removal once');
  });
});

/**
 * The same in-place discipline when a legacy id marker is the only evidence:
 * two managed groups with a user group between them each get rewritten at their
 * own index instead of being lifted out and re-appended behind the user's.
 */
test('groups recognized by an id marker keep their places around a user group', async () => {
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
    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')), [
      'echo alpha',
      'echo mine',
      'echo beta',
    ]);
  });
});

test('hash-path groups are reclaimed without deleting their directories', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, configFor(['claude-code'], []));
    const bundle = path.join(managedParent(homes, 'claude-code'), HEX64_A, HEX64_B);
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'run.sh'), RUN_SH);
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      hooks: {
        PreToolUse: [
          { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
          { matcher: 'hash-path', hooks: [{ type: 'command', command: `${bundle}/run.sh` }] },
        ],
      },
    });

    await runSync();

    assert.deepEqual(commandsOf(eventGroups(settings, 'PreToolUse')), ['echo mine']);
    assert.equal(fs.existsSync(bundle), true, 'recognition never authorizes directory deletion');
  });
});

test('a URL that merely contains a managed-looking hash path is not ownership evidence', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    writeUserConfig(homes, configFor(['claude-code'], []));
    const settings = configPath(homes, 'claude-code');
    const urlGroup = {
      matcher: 'url',
      hooks: [
        { type: 'command', command: `curl https://example.com/hooks/managed/${HEX64_A}/run.sh` },
      ],
    };
    writeJson(settings, { hooks: { PreToolUse: [urlGroup] } });

    await runSync();

    assert.deepEqual(eventGroups(settings, 'PreToolUse'), [urlGroup]);
  });
});

test('known foreign-home bundle ids are reclaimed while unknown ids stay user-owned', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code', 'codex');
    seedRunner(homes, 'bundle-hook');
    writeUserConfig(homes, configFor(['claude-code', 'codex'], ['bundle-hook']));

    const foreignPath = (app: 'claude-code' | 'codex', id: string) =>
      `/foreign/home/${APP_DIR[app]}/hooks/managed/${id}/run.sh`;

    for (const app of ['claude-code', 'codex'] as const) {
      writeJson(configPath(homes, app), {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: foreignPath(app, 'bundle-hook') }] },
            {
              hooks: [
                {
                  type: 'command',
                  command: path.join(managedDir(homes, app, 'bundle-hook'), 'run.sh'),
                },
              ],
            },
            { hooks: [{ type: 'command', command: foreignPath(app, 'not-an-asb-hook') }] },
            { hooks: [{ type: 'command', command: 'echo mine' }] },
          ],
        },
      });
    }

    await runSync();

    for (const app of ['claude-code', 'codex'] as const) {
      const local = path.join(managedDir(homes, app, 'bundle-hook'), 'run.sh');
      const commands = commandsOf(eventGroups(configPath(homes, app), 'UserPromptSubmit'));
      assert.equal(
        commands.includes(foreignPath(app, 'bundle-hook')),
        false,
        `${app}: a known id under another home is reclaimed`
      );
      assert.equal(
        commands.filter((command) => command === local).length,
        1,
        `${app}: one live group`
      );
      assert.equal(
        commands.includes(foreignPath(app, 'not-an-asb-hook')),
        true,
        `${app}: unknown id preserved`
      );
      assert.equal(commands.includes('echo mine'), true, `${app}: user command preserved`);
    }
  });
});

test('a predecessor group is named even after its hook leaves the selection', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const render = { matcher: 'go', hooks: [{ type: 'command', command: 'echo v2' }] };
    seedHook(homes, 'alpha', { UserPromptSubmit: [render] });
    const settings = configPath(homes, 'claude-code');
    // What an earlier render of `alpha` left: same event and matcher, older
    // command. Nothing on disk says which hook wrote it, and the library's
    // current render no longer matches it.
    const stale = { matcher: 'go', hooks: [{ type: 'command', command: 'echo v1' }] };
    writeJson(settings, { hooks: { UserPromptSubmit: [stale] } });

    writeUserConfig(homes, configFor(['claude-code'], ['alpha']));
    const selected = await runSync();

    const named = hooksRows(selected).find(
      (row) => row.outcome === 'left-behind' && row.detail === 'unproven'
    );
    assert.ok(named, JSON.stringify(selected.entries, null, 2));
    assert.equal(named.reason?.includes('alpha'), true, named.reason);
    assert.equal(named.path, settings, 'the row names the file the group is still in');
    assert.deepEqual(
      eventGroups(settings, 'UserPromptSubmit'),
      [stale, render],
      'the group asb cannot prove stays put, and the selected hook lands beside it'
    );
    assert.equal(selected.exitCode, 0, JSON.stringify(selected.entries, null, 2));

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

test('a foreign group without a concrete matcher is never reported as left-behind', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    // A selected hook with no matcher at all, a selected hook whose matcher is
    // the empty string, and a library hook nobody selected: none of the three
    // makes a matcherless foreign group on their event noisy.
    seedHook(homes, 'tracker', {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo tracker' }] }],
    });
    seedHook(homes, 'blank', {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo blank' }] }],
    });
    seedHook(homes, 'idle', {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo idle' }] }],
    });
    const settings = configPath(homes, 'codex');
    writeJson(settings, {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo foreign-installer' }] },
          { hooks: [{ type: 'command', command: 'echo tracker' }] },
        ],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo foreign-stop' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo foreign-start' }] }],
      },
    });
    writeUserConfig(homes, configFor(['codex'], ['tracker', 'blank']));

    const report = await runSync();

    assert.equal(
      hooksRows(report).filter((row) => row.outcome === 'left-behind').length,
      0,
      JSON.stringify(report.entries, null, 2)
    );
    assert.equal(
      commandsOf(eventGroups(settings, 'UserPromptSubmit')).includes('echo foreign-installer'),
      true,
      'the foreign group stays'
    );
    assert.deepEqual(commandsOf(eventGroups(settings, 'Stop')), [
      'echo blank',
      'echo foreign-stop',
    ]);
    assert.deepEqual(commandsOf(eventGroups(settings, 'SessionStart')), ['echo foreign-start']);
  });
});

test('a concrete matcher that does not equal any library matcher is not left-behind', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'alpha', {
      UserPromptSubmit: [{ matcher: 'go', hooks: [{ type: 'command', command: 'echo alpha' }] }],
    });
    const settings = configPath(homes, 'codex');
    const foreign = { matcher: 'other', hooks: [{ type: 'command', command: 'echo foreign' }] };
    writeJson(settings, { hooks: { UserPromptSubmit: [foreign] } });
    writeUserConfig(homes, configFor(['codex'], ['alpha']));

    const report = await runSync();

    assert.equal(
      hooksRows(report).filter((row) => row.outcome === 'left-behind').length,
      0,
      JSON.stringify(report.entries, null, 2)
    );
    assert.deepEqual(commandsOf(eventGroups(settings, 'UserPromptSubmit')), [
      'echo alpha',
      'echo foreign',
    ]);
  });
});

test('an edited project hook bundle is preserved and reported, never swept', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'claude-code');
    seedHookBundle(
      homes,
      'tool',
      { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }] },
      { 'run.sh': '#!/bin/sh\necho managed\n' }
    );
    writeUserConfig(homes, '[applications]\nenabled = ["claude-code"]\n');
    const projectToml = path.join(project, '.asb.toml');
    fs.writeFileSync(projectToml, '[hooks]\nenabled = ["tool"]\n');
    await runSync({ project });

    const target = path.join(project, '.claude', 'hooks', 'managed', 'tool', 'run.sh');
    fs.writeFileSync(target, '#!/bin/sh\necho edited\n');
    fs.writeFileSync(projectToml, '[hooks]\nenabled = []\n');

    const report = await runSync({ project });

    // The group in the config names the managed path, so it is asb's and goes;
    // the tree no longer matches the render, so in a repository it stays and is
    // named instead.
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(fs.readFileSync(target, 'utf-8'), '#!/bin/sh\necho edited\n');
    const row = hooksRows(report).find((entry) => entry.id === 'tool');
    assert.equal(row?.outcome, 'left-behind');
    assert.equal(row?.detail, 'unproven');
    const local = readJson(path.join(project, '.claude', 'settings.local.json'));
    assert.equal(Object.hasOwn(local, 'hooks'), false, 'the emptied hooks key still goes');
  });
});
