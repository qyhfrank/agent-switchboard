import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main, runAddSource, runRemoveSource, runSync } from '../../src/engine/cli.js';
import { loadConfig } from '../../src/engine/config.js';
import { readSourceCatalog } from '../../src/engine/sources.js';
import {
  commitAndPush,
  createGitFixture,
  installApps,
  ruleFilePath,
  type ScratchHomes,
  seedRule,
  skillsParentDir,
  withScratchHomes,
  writeFixtureFile,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * The source lifecycle at the command boundary: what `add` and `remove` report,
 * what a run says about a source that is not there, how `--source` narrows a
 * plan, and the promise that nothing carrying a credential reaches a stream.
 */

function seedSource(scratch: ScratchHomes, namespace: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(scratch.asbHome, 'plugins', namespace, relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function skillDoc(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} does a thing\n---\n\nBody of ${name}.\n`;
}

function userConfig(scratch: ScratchHomes): string {
  return fs.readFileSync(path.join(scratch.asbHome, 'config.toml'), 'utf-8');
}

/** Run the CLI entry point, capturing what it wrote. */
async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('removing a source retires every entry it enabled, one reported row each', async () => {
  await withScratchHomes(async (scratch) => {
    seedSource(scratch, 'team', {
      'rules/style.md': '# Style\n',
      'skills/deploy/SKILL.md': skillDoc('deploy'),
    });
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["core", "team:style"]  # keep core',
        '',
        '[skills]',
        'enabled = ["team:deploy"]',
        '',
        '[plugins]',
        'enabled = ["team"]',
        '',
        '[plugins.sources]',
        `team = ${JSON.stringify(path.join(scratch.asbHome, 'plugins', 'team'))}`,
        '',
      ].join('\n')
    );

    const report = await runRemoveSource('team');
    const retired = report.entries.filter((entry) => entry.detail === 'retired');
    assert.deepEqual(
      retired.map((entry) => `${entry.type}/${entry.id}`).sort(),
      ['plugins/team', 'rules/team:style', 'skills/team:deploy'],
      JSON.stringify(report.entries, null, 2)
    );

    const after = userConfig(scratch);
    assert.doesNotMatch(after, /team:style/);
    assert.doesNotMatch(after, /team:deploy/);
    assert.match(after, /"core"/, 'an unrelated selection is untouched');
    assert.match(after, /# keep core/, 'comments survive the edit');
    assert.doesNotMatch(after, /\[plugins\.sources\][\s\S]*team =/);
  });
});

test('an enabled plugin whose source is not there is reported with the path asb looked at', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedRule(scratch, 'core.md', 'Be kind.\n');
    const gone = path.join(scratch.root, 'gone', 'rl-harness');
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["core"]',
        '',
        '[plugins]',
        'enabled = ["rl-harness"]',
        '',
        '[plugins.sources]',
        `rl-harness = ${JSON.stringify(gone)}`,
        '',
      ].join('\n')
    );

    const status = await runSync({ dryRun: true });
    const missing = status.entries.find((entry) => entry.outcome === 'missing');
    assert.ok(missing, JSON.stringify(status.entries, null, 2));
    assert.equal(missing.id, 'rl-harness');
    assert.equal(missing.path, gone, 'the configured path is named, not just the id');

    // One warning, and the rest of the run still happens.
    const report = await runSync();
    assert.ok(report.entries.some((entry) => entry.outcome === 'missing'));
    assert.equal(fs.readFileSync(ruleFilePath(scratch, 'claude-code'), 'utf-8'), 'Be kind.\n');
  });
});

test('--source narrows which entries a run acts on', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    seedSource(scratch, 'pack', { 'skills/alpha/SKILL.md': skillDoc('alpha') });
    seedSource(scratch, 'other', { 'skills/beta/SKILL.md': skillDoc('beta') });
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack", "other"]',
        '',
      ].join('\n')
    );

    await runSync({ sources: ['pack'] });

    const parent = skillsParentDir(scratch, 'claude-code');
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

test('a configured clone reports as pending on a preview and materializes on a real run', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    const fixture = createGitFixture(scratch.root, 'remote-pack');
    writeFixtureFile(fixture, 'rules/style.md', 'Be brief.\n');
    commitAndPush(fixture, 'seed');
    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["remote-pack"]',
        '',
        '[plugins.sources]',
        `remote-pack = { url = ${JSON.stringify(`file://${fixture.bareRepo}`)}, type = "clone" }`,
        '',
      ].join('\n')
    );

    const preview = await runSync({ dryRun: true });
    const pending = preview.entries.find((entry) => entry.outcome === 'pending');
    assert.ok(pending, JSON.stringify(preview.entries, null, 2));
    assert.equal(pending.detail, 'clone');
    assert.ok(
      !fs.existsSync(path.join(scratch.cacheHome, 'remote-pack')),
      'a preview clones nothing'
    );

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(fs.existsSync(path.join(scratch.cacheHome, 'remote-pack')));
    assert.match(fs.readFileSync(ruleFilePath(scratch, 'claude-code'), 'utf-8'), /Be brief\./);
  });
});

test('add declares a local directory and a remote, and persists no credential', async () => {
  await withScratchHomes(async (scratch) => {
    const local = path.join(scratch.root, 'local-lib');
    fs.mkdirSync(path.join(local, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(local, 'rules', 'style.md'), '# Style\n', 'utf-8');
    writeUserConfig(scratch, '[applications]\nenabled = ["claude-code"]\n');

    const localReport = await runAddSource(local, { as: 'lib' });
    assert.equal(localReport.exitCode, 0);
    assert.match(userConfig(scratch), /lib = /);

    const fixture = createGitFixture(scratch.root, 'secret-pack');
    writeFixtureFile(fixture, 'rules/tone.md', '# Tone\n');
    commitAndPush(fixture, 'seed');
    // A file:// URL carrying userinfo: the clone reaches the same repository,
    // and what lands in config.toml must not carry the credential.
    await runAddSource(`file://user:ghp_secret123@${fixture.bareRepo}`, { as: 'remote' });

    const written = userConfig(scratch);
    assert.doesNotMatch(written, /ghp_secret123/);
    const catalog = readSourceCatalog(loadConfig());
    assert.deepEqual(catalog.sources.map((source) => source.namespace).sort(), ['lib', 'remote']);
  });
});

test('nothing leaving the command boundary carries a credential', async () => {
  await withScratchHomes(async (scratch) => {
    // A malformed declaration: the TOML parser echoes the offending line, which
    // is the one place a raw credential can reach a stream unredacted.
    writeUserConfig(
      scratch,
      '[plugins.sources]\nmain = "https://user:ghp_secret123@github.com/o/r.git\n'
    );

    const result = await runCli(['status']);
    assert.equal(result.code, 2);
    assert.doesNotMatch(result.err, /ghp_secret123/, result.err);
    assert.match(result.err, /user:\*\*\*@github\.com/);
  });
});

test('--update refreshes the named source only, and --no-update suppresses auto_update', async () => {
  await withScratchHomes(async (scratch) => {
    installApps(scratch, 'claude-code');
    const first = createGitFixture(scratch.root, 'first');
    writeFixtureFile(first, 'rules/one.md', 'One.\n');
    commitAndPush(first, 'seed');
    const second = createGitFixture(scratch.root, 'second');
    writeFixtureFile(second, 'rules/two.md', 'Two.\n');
    commitAndPush(second, 'seed');

    writeUserConfig(
      scratch,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["first", "second"]',
        'auto_update = true',
        '',
        '[plugins.sources]',
        `first = { url = ${JSON.stringify(`file://${first.bareRepo}`)}, type = "clone" }`,
        `second = { url = ${JSON.stringify(`file://${second.bareRepo}`)}, type = "clone" }`,
        '',
      ].join('\n')
    );

    // Materialize both, then move each remote forward.
    await runSync({ noUpdate: true });
    writeFixtureFile(first, 'rules/one.md', 'One, revised.\n');
    commitAndPush(first, 'revise');
    writeFixtureFile(second, 'rules/two.md', 'Two, revised.\n');
    commitAndPush(second, 'revise');

    const cachedRule = (namespace: string, file: string): string =>
      fs.readFileSync(path.join(scratch.cacheHome, namespace, 'rules', file), 'utf-8');

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
