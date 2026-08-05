import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  parseCliArgs,
  runAddSource,
  runRemoveSource,
  runSelectionCommand,
  runSync,
} from '../src/engine/cli.js';
import { loadConfig } from '../src/engine/config.js';
import { entriesRoot } from '../src/engine/entries.js';
import { readSourceCatalog } from '../src/engine/sources.js';
import {
  commitAndPush,
  createGitFixture,
  installApps,
  renderedRules,
  ruleFilePath,
  runMain,
  type ScratchHomes,
  seedRule,
  seedSource,
  seedTree,
  skillDoc,
  skillsParentDir,
  withScratchHomes,
  writeFixtureFile,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The source lifecycle at the command boundary: what `add` and `remove` write,
 * what a run says about content no source provides, how `--source` narrows a
 * plan, what a preview promises the real run will do, and the rule that
 * nothing carrying a credential reaches a stream.
 */

/** A user config plus the `[plugins.sources]` table its namespaces resolve from. */
function writeConfig(
  homes: ScratchHomes,
  body: readonly string[],
  sources: Record<string, string> = {}
): void {
  const declared = Object.entries(sources).map(([namespace, at]) => `${namespace} = ${at}`);
  writeUserConfig(
    homes,
    [...body, ...(declared.length > 0 ? ['', '[plugins.sources]', ...declared] : []), ''].join('\n')
  );
}

function userConfig(homes: ScratchHomes): string {
  return fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8');
}

const BASE = ['[applications]', 'enabled = ["claude-code"]'];

test('a selected plugin no source provides is a missing row naming what asb looked at', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Be kind.\n');
    const gone = path.join(homes.root, 'gone', 'harness');
    writeConfig(
      homes,
      [...BASE, '', '[rules]', 'enabled = ["core"]', '', '[plugins]', 'enabled = ["harness"]'],
      { harness: JSON.stringify(gone) }
    );

    const status = await runSync({ dryRun: true });
    const missing = status.entries.find((entry) => entry.outcome === 'missing');
    assert.ok(missing, JSON.stringify(status.entries, null, 2));
    assert.equal(missing.id, 'harness');
    assert.equal(missing.path, gone, 'the configured path is named, not just the id');

    // One gap row, and the rest of the run still happens.
    const report = await runSync();
    assert.ok(report.entries.some((entry) => entry.outcome === 'missing'));
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Be kind.\n')
    );
  });
});

test('--source narrows which entries a run acts on', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedSource(homes, 'pack', { 'skills/alpha/SKILL.md': skillDoc('alpha') });
    seedSource(homes, 'other', { 'skills/beta/SKILL.md': skillDoc('beta') });
    writeConfig(homes, [...BASE, '', '[plugins]', 'enabled = ["pack", "other"]']);

    await runSync({ sources: ['pack'] });

    const parent = skillsParentDir(homes, 'claude-code');
    assert.ok(fs.existsSync(path.join(parent, 'pack:alpha')), 'the named source was distributed');
    assert.ok(
      !fs.existsSync(path.join(parent, 'other:beta')),
      'nothing else deployed under the filter'
    );

    // Unfiltered, the same plan covers both.
    await runSync();
    assert.ok(fs.existsSync(path.join(parent, 'other:beta')));
  });
});

test('--source keeps an unresolved source outside its scope from stopping the run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Core.\n');
    const healthy = seedSource(homes, 'healthy', {
      'skills/alpha/SKILL.md': skillDoc('alpha'),
    });
    writeConfig(
      homes,
      [...BASE, '', '[rules]', 'enabled = ["core"]', '', '[plugins]', 'enabled = ["healthy"]'],
      {
        healthy: JSON.stringify(healthy),
        '"../broken"': JSON.stringify(path.join(homes.root, 'broken')),
      }
    );

    const report = await runSync({ sources: ['healthy'] });

    // Out of scope, the unresolved namespace is below the pre-write abort; the
    // aggregate it could have contributed to is what refuses to be rewritten.
    assert.notEqual(report.exitCode, 2, JSON.stringify(report.entries, null, 2));
    assert.ok(
      report.entries.some(
        (entry) =>
          entry.type === 'skills' && entry.id === 'healthy:alpha' && entry.outcome === 'written'
      ),
      JSON.stringify(report.entries, null, 2)
    );
    assert.ok(
      report.entries.some(
        (entry) => entry.type === 'rules' && entry.detail === 'aggregate-blocked'
      ),
      JSON.stringify(report.entries, null, 2)
    );
  });
});

test('a configured clone reports as pending on a preview and materializes on a real run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const fixture = createGitFixture(homes.root, 'remote-pack');
    writeFixtureFile(fixture, 'rules/style.md', 'Be brief.\n');
    commitAndPush(fixture, 'seed');
    writeConfig(homes, [...BASE, '', '[plugins]', 'enabled = ["remote-pack"]'], {
      'remote-pack': `{ url = ${JSON.stringify(`file://${fixture.bareRepo}`)}, type = "clone" }`,
    });

    const preview = await runSync({ dryRun: true });
    const pending = preview.entries.find((entry) => entry.outcome === 'pending');
    assert.ok(pending, JSON.stringify(preview.entries, null, 2));
    assert.equal(pending.detail, 'clone');
    assert.ok(
      !fs.existsSync(path.join(homes.cacheHome, 'remote-pack')),
      'a preview clones nothing'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(path.join(homes.cacheHome, 'remote-pack')));
    assert.match(fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'), /Be brief\./);
  });
});

test('a selected external marketplace entry previews, fetches, and distributes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const fixture = createGitFixture(homes.root, 'external-pack');
    writeFixtureFile(fixture, 'rules/remote.md', 'Remote rule body.\n');
    commitAndPush(fixture, 'seed');
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'shop',
        plugins: [{ name: 'remote-pack', source: { source: 'git', url: fixture.bareRepo } }],
      }),
    });
    writeConfig(homes, [...BASE, '', '[plugins]', 'enabled = ["remote-pack@shop"]']);

    // Catalogued with what would fetch it, and resolved to nothing until
    // something does: reading a catalog never pays for a plugin nobody wants.
    const catalogued = readSourceCatalog(loadConfig()).plugins;
    assert.equal(catalogued.length, 1);
    assert.equal(catalogued[0]?.root, undefined);
    assert.ok(catalogued[0]?.request, JSON.stringify(catalogued, null, 2));

    const preview = await runSync({ dryRun: true });
    const pending = preview.entries.find((entry) => entry.id === 'remote-pack@shop');
    assert.ok(pending, JSON.stringify(preview.entries, null, 2));
    assert.equal(pending.outcome, 'pending');
    assert.equal(pending.detail, 'clone');
    assert.equal(
      fs.existsSync(entriesRoot(loadConfig().homes)),
      false,
      'a preview fetches nothing'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      /Remote rule body\./
    );
  });
});

test('a failure inside a ready source is a visible row and the run still writes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Be kind.\n');
    seedSource(homes, 'shop', {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'shop',
        plugins: [{ name: 'gone', source: { source: 'git', url: 'http://127.0.0.1:1/none.git' } }],
      }),
    });
    // A second source whose catalog cannot be parsed at all: a different cause,
    // the same containment.
    seedSource(homes, 'broken-shop', { '.claude-plugin/marketplace.json': '{ not json' });
    writeConfig(homes, [
      ...BASE,
      '',
      '[rules]',
      'enabled = ["core"]',
      '',
      '[plugins]',
      'enabled = ["gone@shop"]',
    ]);

    const report = await runSync();

    const unfetchable = report.entries.find((entry) => entry.id === 'gone@shop');
    assert.ok(unfetchable, JSON.stringify(report.entries, null, 2));
    assert.equal(unfetchable.outcome, 'missing');
    const unreadable = report.entries.find((entry) => entry.detail === 'source-error');
    assert.ok(unreadable, JSON.stringify(report.entries, null, 2));
    assert.equal(unreadable.id, 'broken-shop', 'the row is filed under the namespace that failed');
    assert.match(unreadable.reason ?? '', /marketplace/i);

    // Content failures inside a ready source are contained: siblings still land.
    assert.equal(report.exitCode, 1);
    assert.equal(
      fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'),
      renderedRules('claude-code', 'Be kind.\n')
    );
  });
});

test('a readiness failure stops the run before it distributes anything', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Be kind.\n');
    const fixture = createGitFixture(homes.root, 'healthy-pack');
    writeFixtureFile(fixture, 'rules/tone.md', 'Be brief.\n');
    commitAndPush(fixture, 'seed');
    writeConfig(
      homes,
      [...BASE, '', '[rules]', 'enabled = ["core"]', '', '[plugins]', 'enabled = ["healthy"]'],
      {
        broken: '{ url = "http://127.0.0.1:1/missing.git", type = "clone" }',
        healthy: `{ url = ${JSON.stringify(`file://${fixture.bareRepo}`)}, type = "clone" }`,
      }
    );

    // Distributing against a partial inventory would re-render every aggregate
    // without the broken source's members.
    const report = await runSync();

    assert.equal(report.exitCode, 2, JSON.stringify(report.entries, null, 2));
    assert.ok(
      report.entries.some((entry) => entry.id === 'broken' && entry.outcome === 'failed'),
      JSON.stringify(report.entries, null, 2)
    );
    assert.equal(
      fs.existsSync(ruleFilePath(homes, 'claude-code')),
      false,
      'no app target was touched'
    );

    // A namespace with a checkout already on disk is measured against its
    // remote rather than planned as a first clone, and a preview that reaches
    // that failure refuses the run the same way the real one does.
    fs.mkdirSync(path.join(homes.cacheHome, 'broken'), { recursive: true });
    const preview = await runSync({ dryRun: true });

    assert.equal(preview.exitCode, 2, JSON.stringify(preview.entries, null, 2));
    assert.ok(
      preview.entries.some((entry) => entry.id === 'broken' && entry.outcome === 'failed'),
      JSON.stringify(preview.entries, null, 2)
    );
    assert.equal(
      preview.entries.some(
        (entry) => entry.type === 'rules' && ['removed', 'written'].includes(entry.outcome)
      ),
      false,
      JSON.stringify(preview.entries, null, 2)
    );
  });
});

test('a namespace pending its first clone previews without gap rows and surfaces them on the real run', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const fixture = createGitFixture(homes.root, 'src');
    writeFixtureFile(
      fixture,
      '.claude-plugin/marketplace.json',
      JSON.stringify({ name: 'src', plugins: [{ name: 'pack', source: './pack' }] })
    );
    writeFixtureFile(fixture, 'pack/commands/hi.md', 'Say hi.\n');
    commitAndPush(fixture, 'seed');
    writeConfig(homes, [...BASE, '', '[plugins]', 'enabled = ["pack@src", "ghost@src"]'], {
      src: `{ url = ${JSON.stringify(`file://${fixture.bareRepo}`)}, type = "clone" }`,
    });

    // Nothing is cloned yet, so no ref of this namespace can be called absent.
    // Pending work is not an attention state either: the exit vocabulary
    // reserves 1 for failing outcomes, and the pending row names the next step.
    const preview = await runSync({ dryRun: true });
    assert.equal(
      preview.entries.some((entry) => entry.outcome === 'missing'),
      false,
      JSON.stringify(preview.entries, null, 2)
    );
    assert.ok(
      preview.entries.some((entry) => entry.outcome === 'pending'),
      JSON.stringify(preview.entries, null, 2)
    );
    assert.equal(preview.exitCode, 0, JSON.stringify(preview.entries, null, 2));

    // The clone runs inside this very sync, so the catalog already proves what
    // the source provides: pack lands now, and ghost is this run's failure
    // rather than the next run's surprise.
    const first = await runSync();
    assert.ok(
      first.entries.some(
        (entry) => entry.outcome === 'written' && (entry.id ?? '').includes('pack')
      ),
      JSON.stringify(first.entries, null, 2)
    );
    assert.ok(
      first.entries.some((entry) => entry.id === 'ghost@src' && entry.outcome === 'missing'),
      JSON.stringify(first.entries, null, 2)
    );
    assert.equal(first.exitCode, 1, JSON.stringify(first.entries, null, 2));
  });
});

test('add declares a local directory and a remote, and persists no credential', async () => {
  await withScratchHomes(async (homes) => {
    const local = seedTree(path.join(homes.root, 'local-lib'), { 'rules/style.md': '# Style\n' });
    writeConfig(homes, BASE);

    const localReport = await runAddSource(local, { as: 'lib' });
    assert.equal(localReport.exitCode, 0);
    assert.match(userConfig(homes), /lib = /);

    const fixture = createGitFixture(homes.root, 'secret-pack');
    writeFixtureFile(fixture, 'rules/tone.md', '# Tone\n');
    commitAndPush(fixture, 'seed');
    // A file:// URL carrying userinfo: the clone reaches the same repository,
    // and what lands in config.toml must not carry the credential.
    await runAddSource(`file://user:ghp_secret123@${fixture.bareRepo}`, { as: 'remote' });

    assert.doesNotMatch(userConfig(homes), /ghp_secret123/);
    // Read back through the catalog every other command resolves from.
    const catalog = readSourceCatalog(loadConfig());
    assert.deepEqual(catalog.sources.map((source) => source.namespace).sort(), ['lib', 'remote']);
    const declared = catalog.sources.find((source) => source.namespace === 'lib');
    assert.equal(declared?.path, local);
    assert.equal(declared?.remote, undefined);
    assert.equal(declared?.configured, true);
  });
});

test('add --marketplace refuses a directory carrying no marketplace manifest and writes nothing', async () => {
  await withScratchHomes(async (homes) => {
    const invocation = parseCliArgs(['add', homes.root, '--marketplace']);
    assert.equal(invocation.command, 'add');
    if (invocation.command !== 'add') return;
    assert.equal(invocation.options.marketplace, true);

    const plain = seedTree(path.join(homes.root, 'plain'), { 'rules/x.md': 'x\n' });
    await assert.rejects(
      () => runAddSource(plain, { as: 'plain', marketplace: true }),
      /marketplace manifest/i
    );
    assert.equal(fs.existsSync(path.join(homes.asbHome, 'config.toml')), false);
  });
});

test('add and remove edit config.toml whichever selection file the run reads', async () => {
  await withScratchHomes(async (homes) => {
    const local = seedTree(path.join(homes.root, 'local-lib'), { 'rules/style.md': '# Style\n' });
    writeConfig(homes, BASE);
    const profilePath = path.join(homes.asbHome, 'work.toml');
    fs.writeFileSync(profilePath, '[applications]\nenabled = ["claude-code"]\n', 'utf-8');
    const profile = (): string => fs.readFileSync(profilePath, 'utf-8');
    const untouched = profile();

    // `-p` names the selection a run reads. Sources are the machine's in every
    // run, so both edits land in the file that owns them.
    assert.equal((await runAddSource(local, { as: 'lib', profile: 'work' })).exitCode, 0);
    assert.match(userConfig(homes), /lib = /);
    assert.equal(profile(), untouched);

    assert.equal((await runRemoveSource('lib', { profile: 'work' })).exitCode, 0);
    assert.doesNotMatch(userConfig(homes), /lib = /);
    assert.equal(profile(), untouched);

    // An active profile in the environment is the same rule reached the other way.
    process.env.ASB_PROFILE = 'work';
    try {
      assert.equal((await runAddSource(local, { as: 'ambient-lib' })).exitCode, 0);
    } finally {
      delete process.env.ASB_PROFILE;
    }
    assert.match(userConfig(homes), /ambient-lib = /);
    assert.equal(profile(), untouched);
  });
});

test('a source declared in a profile is reported, never cloned, and never resolved', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const lib = seedSource(homes, 'lib', { 'rules/style.md': 'Be brief.\n' });
    writeConfig(homes, BASE, { lib: JSON.stringify(lib) });
    const profilePath = path.join(homes.asbHome, 'work.toml');
    fs.writeFileSync(
      profilePath,
      [
        ...BASE,
        '',
        '[rules]',
        'enabled = ["lib:style"]',
        '',
        '[plugins]',
        'enabled = ["lib"]',
        '',
        '[plugins.sources]',
        'ghost = { url = "http://127.0.0.1:1/none.git", type = "clone" }',
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await runSync({ profile: 'work' });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(
      report.entries
        .filter((entry) => entry.detail === 'profile-source')
        .map((entry) => ({
          id: entry.id,
          outcome: entry.outcome,
          scope: entry.scope,
          path: entry.path,
        })),
      [{ id: 'ghost', outcome: 'skipped', scope: 'user', path: profilePath }],
      JSON.stringify(report.entries, null, 2)
    );
    assert.equal(fs.existsSync(path.join(homes.cacheHome, 'ghost')), false, 'nothing was cloned');
    // What the profile selects resolves against the library config.toml built.
    assert.match(fs.readFileSync(ruleFilePath(homes, 'claude-code'), 'utf-8'), /Be brief\./);
  });
});

test('a repository declaring [plugins.sources] is reported and nothing else', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const vendored = seedTree(path.join(homes.root, 'vendored'), {
      'rules/leak.md': 'Repository-authored body\n',
    });
    installApps(homes, 'claude-code');
    writeConfig(homes, [...BASE, '', '[rules]', 'enabled = ["evil:leak"]']);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      [
        '[plugins.sources]',
        `evil = ${JSON.stringify(vendored)}`,
        `remote = { url = "file://${path.join(homes.root, 'absent.git')}", type = "clone" }`,
        '',
      ].join('\n')
    );

    const report = await runSync({ project });

    // The machine cache and the network are config.toml's alone: nothing was
    // cloned, and no namespace the repository named resolves.
    assert.equal(fs.existsSync(path.join(homes.cacheHome, 'remote')), false);
    assert.notEqual(report.exitCode, 2, JSON.stringify(report.entries, null, 2));
    const host = ruleFilePath(homes, 'claude-code');
    assert.equal(
      fs.existsSync(host) && fs.readFileSync(host, 'utf-8').includes('Repository-authored body'),
      false,
      'no repository-authored body reaches a user-scope target'
    );
    const declarations = report.entries.filter((entry) => entry.detail === 'project-source');
    assert.deepEqual(
      declarations.map((entry) => entry.id).sort(),
      ['evil', 'remote'],
      JSON.stringify(report.entries, null, 2)
    );
    assert.deepEqual(
      declarations.map((entry) => `${entry.scope}/${entry.outcome}`),
      ['project/skipped', 'project/skipped']
    );
    assert.ok(
      report.entries.some((entry) => entry.id === 'evil:leak' && entry.outcome === 'missing'),
      'the selection resolves against the machine library, which has no such id'
    );
  });
});

test('a repository-declared source contributes nothing an enable -P can resolve', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    const vendored = seedTree(path.join(homes.root, 'vendored'), {
      'commands/leak.md': 'repository body\n',
    });
    writeConfig(homes, BASE);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      `[plugins.sources]\nevil = ${JSON.stringify(vendored)}\n`,
      'utf-8'
    );

    // Sources are config.toml's in every scope, so the id the repository would
    // supply resolves against the machine's library and is not there.
    await assert.rejects(
      runSelectionCommand('enable', ['evil:leak'], { project }),
      /Unknown component "evil:leak"/
    );
  });
});

test('nothing leaving the command boundary carries a credential', async () => {
  await withScratchHomes(async (homes) => {
    // A malformed declaration: the TOML parser echoes the offending line, which
    // is the one place a raw credential can reach a stream unredacted.
    writeUserConfig(
      homes,
      '[plugins.sources]\nmain = "https://user:ghp_secret123@github.com/o/r.git\n'
    );

    const result = await runMain(['status']);
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.err, /ghp_secret123/, result.err);
    assert.match(result.err, /user:\*\*\*@github\.com/);

    // A token carried as a query parameter is the same secret in another
    // spelling, echoed by the same parse error.
    writeUserConfig(
      homes,
      [
        '[plugins.sources]',
        'tools = { url = "https://example.com/org/repo.git?private_token=SECRETVALUE123" }',
        'this line is malformed',
        '',
      ].join('\n')
    );

    const query = await runMain(['status']);
    assert.equal(query.code, 2);
    assert.doesNotMatch(query.err, /SECRETVALUE123/, query.err);

    // A resolution failure carries the configured location into the report, so
    // the machine-readable and explanatory streams mask it too.
    writeUserConfig(
      homes,
      [
        '[plugins.sources]',
        '"bad ns" = { url = "https://gituser:ghp_SUPERSECRET123@example.com/org/repo.git" }',
        '',
      ].join('\n')
    );

    const json = await runMain(['status', '--json']);
    assert.doesNotMatch(json.out, /ghp_SUPERSECRET123/, json.out);
    assert.match(json.out, /gituser:\*\*\*@example\.com/);

    const explained = await runMain(['explain', 'bad ns']);
    assert.doesNotMatch(explained.out, /ghp_SUPERSECRET123/, explained.out);
  });
});

test('--update refreshes the named source only, and --no-update suppresses auto_update', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const first = createGitFixture(homes.root, 'first');
    writeFixtureFile(first, 'rules/one.md', 'One.\n');
    commitAndPush(first, 'seed');
    const second = createGitFixture(homes.root, 'second');
    writeFixtureFile(second, 'rules/two.md', 'Two.\n');
    commitAndPush(second, 'seed');
    writeConfig(
      homes,
      [...BASE, '', '[plugins]', 'enabled = ["first", "second"]', 'auto_update = true'],
      {
        first: `{ url = ${JSON.stringify(`file://${first.bareRepo}`)}, type = "clone" }`,
        second: `{ url = ${JSON.stringify(`file://${second.bareRepo}`)}, type = "clone" }`,
      }
    );

    // Materialize both, then move each remote forward.
    await runSync({ noUpdate: true });
    writeFixtureFile(first, 'rules/one.md', 'One, revised.\n');
    commitAndPush(first, 'revise');
    writeFixtureFile(second, 'rules/two.md', 'Two, revised.\n');
    commitAndPush(second, 'revise');

    const cachedRule = (namespace: string, file: string): string =>
      fs.readFileSync(path.join(homes.cacheHome, namespace, 'rules', file), 'utf-8');

    // Suppression beats the configured auto_update.
    await runSync({ noUpdate: true });
    assert.equal(cachedRule('first', 'one.md'), 'One.\n');

    // A refresh reaches exactly the source it was pointed at.
    await runSync({ update: true, sources: ['first'] });
    assert.equal(cachedRule('first', 'one.md'), 'One, revised.\n');
    assert.equal(cachedRule('second', 'two.md'), 'Two.\n');

    // A preview says what it would fetch and fetches nothing.
    const preview = await runSync({ dryRun: true, update: true, sources: ['second'] });
    const pending = preview.entries.find((entry) => entry.detail === 'refresh');
    assert.ok(pending, JSON.stringify(preview.entries, null, 2));
    assert.equal(pending.id, 'second');
    assert.equal(cachedRule('second', 'two.md'), 'Two.\n');
  });
});

test('--update reports one invalid namespace exactly once', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[plugins.sources]\n"bad ns" = "https://example.invalid/org/repo.git"\n'
    );

    const report = await runSync({ update: true });
    const failures = report.entries.filter((entry) => entry.id === 'bad ns');

    assert.equal(report.exitCode, 2);
    assert.equal(failures.length, 1, JSON.stringify(report.entries, null, 2));
    assert.equal(failures[0]?.outcome, 'failed');
  });
});
