import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runExplain, runSync } from '../src/engine/cli.js';
import { ConfigError } from '../src/engine/config.js';
import { redactCredentials } from '../src/engine/report.js';
import { configFor, configPath, managedDir, seedHook, seedRunner } from './helpers/hooks.js';
import {
  inCwd,
  installApps,
  runMain,
  type ScratchHomes,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The read-only surfaces: which rows a status carries in each mode, which
 * slices an explain resolves, and what the process returns for each. Answers
 * are asserted as report rows, slice fields, JSON envelopes, and exit codes.
 */

const PLACEHOLDER_SECRET = 'INVENTED-PLACEHOLDER-9f3a';

function ruleConfig(apps: readonly string[]): string {
  return `[applications]\nenabled = [${apps.map((id) => `"${id}"`).join(', ')}]\n\n[rules]\nenabled = ["base"]\n`;
}

function commandsConfig(enabled: readonly string[], extra = ''): string {
  return `[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = [${enabled
    .map((id) => `"${id}"`)
    .join(', ')}]\n${extra}`;
}

function commandTarget(homes: ScratchHomes, id: string): string {
  return path.join(homes.agentsHome, '.claude', 'commands', `${id}.md`);
}

test('--help and --version succeed on the engine surface', async () => {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
    .version as string;

  // commander throws out of both, so the entry point has to map them to a
  // successful run rather than an error.
  const help = await runMain(['--help']);
  const reported = await runMain(['--version']);

  assert.equal(help.code, 0, help.err);
  assert.equal(help.err, '');
  assert.equal(reported.code, 0, reported.err);
  assert.equal(reported.out.trim(), version);
  assert.equal(reported.err, '');
});

test('a bare invocation is a read-only summary that routes to the pending action', async () => {
  await withScratchHomes(async (homes) => {
    const before = fs.readdirSync(homes.root, { recursive: true }).map(String).sort();
    const bare = await runMain([]);
    const after = fs.readdirSync(homes.root, { recursive: true }).map(String).sort();

    assert.equal(bare.code, 0, bare.err || bare.out);
    assert.deepEqual(after, before, 'an empty home is summarized, never scaffolded');

    // The routing among the real branches: pending work points at sync, an
    // all-current home points at the detailed view.
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Core.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["core"]\n'
    );
    const pending = await runMain([]);
    assert.match(pending.out, /asb sync/, pending.out);

    assert.equal((await runSync()).exitCode, 0);
    const current = await runMain([]);
    assert.equal(current.code, 0, current.err || current.out);
    assert.match(current.out, /asb status --all/, current.out);
  });
});

test('status defaults to relevant rows while --all seeds inventory and app probes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/active.md': 'Active.\n',
      'commands/inactive.md': 'Inactive.\n',
    });
    writeUserConfig(homes, commandsConfig(['active', 'ghost']));

    const defaults = await runSync({ dryRun: true });
    assert.ok(defaults.entries.some((row) => row.id === 'active'));
    assert.ok(defaults.entries.some((row) => row.id === 'ghost' && row.outcome === 'missing'));
    assert.equal(
      defaults.entries.some((row) => row.id === 'inactive'),
      false,
      'an unselected id is not a default row'
    );
    assert.equal(
      defaults.entries.some((row) => row.detail === 'app-lacks-type'),
      false
    );

    const all = await runSync({ dryRun: true, all: true });
    assert.ok(
      all.entries.some(
        (row) =>
          row.app === null &&
          row.type === 'commands' &&
          row.id === 'inactive' &&
          row.outcome === 'skipped' &&
          row.detail === 'not-selected'
      ),
      'the inventory row names what is available but off'
    );
    assert.ok(all.entries.some((row) => row.id === 'ghost' && row.outcome === 'missing'));
    assert.ok(
      all.entries.some(
        (row) =>
          row.app === 'claude-desktop' && row.type === 'commands' && row.detail === 'app-lacks-type'
      )
    );
    assert.ok(
      all.entries.some(
        (row) =>
          row.app === 'cursor' && row.type === 'commands' && row.detail === 'app-not-installed'
      )
    );
  });
});

test('status --type filters both modes and id globs match selected, missing, and inactive ids', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/build-live.md': 'build-live\n',
      'commands/build-later.md': 'build-later\n',
      'commands/review.md': 'review\n',
      'agents/build-agent.md': 'Agent.\n',
    });
    writeUserConfig(
      homes,
      commandsConfig(['build-live', 'build-missing'], '\n[agents]\nenabled = ["build-agent"]\n')
    );

    for (const options of [
      { dryRun: true, types: ['commands'] },
      { dryRun: true, all: true, types: ['commands'] },
    ]) {
      const typed = await runSync(options);
      assert.equal(
        typed.entries.every((row) => row.type === null || row.type === 'commands'),
        true,
        JSON.stringify(typed.entries, null, 2)
      );
    }

    const defaultGlobbed = await runSync({ dryRun: true, idGlob: 'build-*' });
    assert.deepEqual(
      new Set(defaultGlobbed.entries.flatMap((row) => (row.id === null ? [] : [row.id]))),
      new Set(['build-live', 'build-missing', 'build-agent'])
    );

    const globbed = await runSync({ dryRun: true, all: true, idGlob: 'build-*' });
    assert.deepEqual(
      new Set(globbed.entries.flatMap((row) => (row.id === null ? [] : [row.id]))),
      new Set(['build-live', 'build-missing', 'build-later', 'build-agent'])
    );
    assert.equal(
      globbed.entries.some((row) => row.id === 'review'),
      false
    );
  });
});

test('status and sync reject unknown type and app filters with suggestions', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, { 'commands/build.md': 'Build.\n' });
    writeUserConfig(homes, commandsConfig(['build']));

    // The filter is the whole scope of the run, so a typo aborts before
    // planning rather than quietly selecting nothing.
    for (const [options, suggestion] of [
      [{ dryRun: true, types: ['mcpp'] }, 'mcp'],
      [{ apps: ['claud-code'] }, 'claude-code'],
    ] as const) {
      await assert.rejects(
        () => runSync(options),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.exitCode === 2 &&
          // The quoted form: the typo itself can contain the bare suggestion,
          // so only the quoted spelling proves the hint is actually offered.
          error.message.includes(`"${suggestion}"`)
      );
    }
  });
});

test('explain --json says which scope each entry was read in', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/ship.md': 'Ship it.\n',
      'commands/release.md': 'Release it.\n',
    });
    seedMcpLibrary(homes, { alpha: { command: 'run', env: { API_TOKEN: PLACEHOLDER_SECRET } } });
    writeUserConfig(homes, commandsConfig(['ship'], '\n[mcp]\nenabled = ["alpha"]\n'));
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[commands]\nenabled = ["ship", "release"]\n'
    );
    await runSync({ project });

    const explained = await runMain(['explain', 'claude-code', '--json', '-P', project]);
    assert.equal(explained.code, 0, explained.out || explained.err);
    const { entries } = JSON.parse(explained.out) as { entries: { path: string; scope: string }[] };
    const paths = (scope: string): string[] =>
      entries.filter((entry) => entry.scope === scope).map((entry) => entry.path);
    // A script tells the machine's copy from the repository's increment by the
    // row it is on, never by parsing the path.
    assert.deepEqual(paths('project'), [path.join(project, '.claude', 'commands', 'release.md')]);
    assert.ok(paths('user').includes(commandTarget(homes, 'ship')));
    assert.equal(
      paths('user').some((entry) => entry.startsWith(project)),
      false
    );

    // Explain answers the same question a status asks and answers it without
    // touching the tree or unmasking a credential.
    const before = fs.readdirSync(homes.root, { recursive: true }).sort();
    const status = await runSync({ project, dryRun: true });
    for (const target of ['ship', 'release', 'alpha']) {
      const { slices } = await runExplain(target, { project });
      assert.ok(slices.length > 0, target);
      for (const slice of slices) {
        assert.ok(
          status.entries.some(
            (entry) =>
              entry.app === slice.app &&
              entry.path === slice.path &&
              entry.outcome === slice.outcome
          ),
          `${target}: ${JSON.stringify(slice, null, 2)}`
        );
      }
      assert.equal(JSON.stringify(slices).includes(PLACEHOLDER_SECRET), false, target);
    }
    assert.deepEqual(fs.readdirSync(homes.root, { recursive: true }).sort(), before);

    // Without -P the run finds the repository it stands in, and the envelope
    // names it rather than leaving the project entries unattributed.
    const detected = await inCwd(project, () => runMain(['explain', 'claude-code', '--json']));
    assert.equal(detected.code, 0, detected.err);
    const answer = JSON.parse(detected.out) as {
      scope: { project: string | null };
      entries: { scope: string }[];
    };
    assert.equal(answer.scope.project, project);
    assert.ok(
      answer.entries.some((entry) => entry.scope === 'project'),
      detected.out
    );
  });
});

test('explain exits 1 for failed slices and no match in text and JSON', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedTree(homes.asbHome, {
      'commands/healthy.md': 'Healthy.\n',
      'commands/review.md': 'Review it.\n',
    });
    writeUserConfig(
      homes,
      commandsConfig(['healthy', 'review', 'missing'], '\n[skills]\nenabled = ["ghost"]\n')
    );
    await runMain(['sync']);

    for (const json of [false, true]) {
      const flag = json ? ['--json'] : [];
      const healthy = await runMain(['explain', 'healthy', ...flag]);
      const failed = await runMain(['explain', 'missing', ...flag]);
      const absent = await runMain(['explain', 'not-selected', ...flag]);

      assert.equal(healthy.code, 0, healthy.out || healthy.err);
      assert.equal(failed.code, 1, failed.out || failed.err);
      assert.equal(absent.code, 1, absent.out || absent.err);
      assert.equal(healthy.err, '');
      assert.equal(failed.err, '');
      assert.equal(absent.err, '');
    }

    // A selected id the library lacks answers with its library row, never
    // with silence, whichever type it was selected as.
    const { slices: ghost } = await runExplain('ghost');
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0]?.app, null);
    assert.equal(ghost[0]?.outcome, 'missing');
    assert.match(ghost[0]?.reason ?? '', /skills\/ghost/);

    // Edited, then deselected: asb keeps bytes it cannot prove are its own, so
    // the run is fine with it, but `explain review` asks about this one target
    // and the answer is that it is not resolved.
    fs.appendFileSync(commandTarget(homes, 'review'), 'A line the user added.\n');
    writeUserConfig(homes, commandsConfig(['healthy']));
    const [left] = (await runExplain('review')).slices;
    assert.equal(left?.outcome, 'left-behind');
    assert.equal((await runMain(['explain', 'review'])).code, 1);
    assert.equal((await runMain(['explain', 'review', '--json'])).code, 1);
  });
});

test('explain by component id joins every slice with owner, hashes, and desired bytes', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, ruleConfig(['claude-code', 'codex']));
    installApps(homes, 'claude-code', 'codex');
    await runSync();

    const { slices } = await runExplain('base');
    assert.deepEqual(slices.map((slice) => slice.app).sort(), ['claude-code', 'codex']);
    for (const slice of slices) {
      assert.equal(slice.outcome, 'unchanged');
      assert.equal(slice.provenance, 'marker');
      assert.equal(slice.currentHash, slice.desiredHash);
      assert.equal(slice.desired, fs.readFileSync(slice.path as string, 'utf-8'));
      assert.deepEqual(slice.components, [
        { id: 'base', path: path.join(homes.asbHome, 'rules', 'base.md') },
      ]);
    }
  });
});

test('explain matches app ids and path basenames to single slices', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, ruleConfig(['claude-code', 'codex']));
    installApps(homes, 'claude-code', 'codex');

    const { slices: byApp } = await runExplain('codex');
    assert.equal(byApp.length, 1);
    assert.equal(byApp[0].path, path.join(homes.agentsHome, '.codex', 'AGENTS.md'));

    const { slices: byPath } = await runExplain('CLAUDE.md');
    assert.equal(byPath.length, 1);
    assert.equal(byPath[0].app, 'claude-code');
    assert.equal(byPath[0].provenance, null, 'nothing synced yet: nothing proves the slice');
    assert.equal(byPath[0].currentHash, null, 'target file absent');
    assert.notEqual(byPath[0].desiredHash, null);

    // The matcher is type-agnostic: a bundle answers to its directory suffix
    // the same way a file answers to its basename, once per app carrying it.
    seedSkill(homes, 'review-pr');
    writeUserConfig(
      homes,
      `${ruleConfig(['claude-code', 'codex'])}\n[skills]\nenabled = ["review-pr"]\n`
    );
    const { slices: byBundle } = await runExplain('skills/review-pr');
    assert.deepEqual(byBundle.map((slice) => slice.app).sort(), ['claude-code', 'codex']);
    for (const slice of byBundle) {
      assert.equal(path.basename(slice.path as string), 'review-pr');
    }
  });
});

test('explain shows an enabled-but-undetected app as skipped, never invents a plan', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(homes, 'base.md', 'Always be kind.\n');
    writeUserConfig(homes, ruleConfig(['cursor']));

    const { slices } = await runExplain('cursor');
    assert.equal(slices.length, 1);
    assert.equal(slices[0].outcome, 'skipped');
    assert.equal(slices[0].detail, 'app-not-installed');
    assert.equal(slices[0].path, null);
    assert.equal(slices[0].provenance, null);
    assert.equal(slices[0].desired, null);

    assert.deepEqual((await runExplain('nope')).slices, []);
  });
});

test('explain resolves hooks by id, app, and path with a derived owner', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRunner(homes, 'bt');
    seedHook(homes, 'lint', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['bt', 'lint', 'ghost']));
    await runSync();

    const { slices: bundleSlices } = await runExplain('bt');
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

    // A definition hook owns no directory; its slice is the app config, which
    // stays the user's file whichever groups inside it derive.
    const settings = configPath(homes, 'claude-code');
    const definition = (await runExplain('lint')).slices.find((slice) => slice.path === settings);
    assert.equal(definition?.app, 'claude-code');
    assert.equal(definition?.provenance, null);

    const { slices: ghost } = await runExplain('ghost');
    assert.equal(ghost.length, 1);
    assert.equal(ghost[0]?.app, null);
    assert.equal(ghost[0]?.outcome, 'missing');
  });
});

test('the credential redactor also masks bare token userinfo', () => {
  assert.equal(
    redactCredentials('clone https://ghp_abc123@github.com/x failed'),
    'clone https://***@github.com/x failed'
  );
  assert.equal(redactCredentials('https://user:secret@host/path'), 'https://user:***@host/path');
  assert.equal(redactCredentials('https://secret-token@host/path'), 'https://***@host/path');
  assert.equal(redactCredentials('no credentials here'), 'no credentials here');
});

test('a leftover extensions directory yields one non-failing advisory row and is never read', async () => {
  await withScratchHomes(async (homes) => {
    const extensions = path.join(homes.asbHome, 'extensions');
    const loaded = 'throw new Error("must not import");\n';
    seedTree(extensions, {
      'first.mjs': loaded,
      'second.js': loaded,
      // An extension the retired loader matched case-insensitively still
      // counts, on its own and not only beside a lowercase sibling.
      'Tool.MJS': loaded,
      'notes.txt': 'not executable\n',
    });
    const files = fs
      .readdirSync(extensions)
      .sort()
      .map((name) => path.join(extensions, name));
    const before = files.map((file) => fs.readFileSync(file));

    for (const options of [{ dryRun: true }, { dryRun: true, idGlob: 'does-not-match' }]) {
      const report = await runSync(options);
      const warnings = report.entries.filter((entry) => entry.detail === 'extensions-removed');

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.equal(warnings.length, 1, 'many files earn one row, and a filter never hides it');
      assert.equal(warnings[0].outcome, 'skipped');
    }
    assert.deepEqual(
      files.map((file) => fs.readFileSync(file)),
      before
    );
  });
});
