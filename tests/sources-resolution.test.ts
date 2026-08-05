import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/engine/config.js';
import {
  addLocalSource,
  inferSourceName,
  isGitUrl,
  managedSourceDir,
  parseGitUrl,
  pluginsDir,
  type ResolvedSource,
  resolveSources,
} from '../src/engine/sources.js';
import { withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/**
 * Source forms: URL and namespace grammar, the add-boundary guards, the
 * effective path every documented declaration form resolves to, discovery
 * under the plugins tree, and the cache-root ownership split.
 */

function sourcePaths(): Record<string, string> {
  const record: Record<string, string> = {};
  for (const source of resolveSources(loadConfig()).sources) record[source.namespace] = source.path;
  return record;
}

function sourceFor(namespace: string): ResolvedSource | undefined {
  return resolveSources(loadConfig()).sources.find((s) => s.namespace === namespace);
}

function sourceErrorOf(namespace: string): string | undefined {
  return resolveSources(loadConfig()).failed.find((f) => f.namespace === namespace)?.error;
}

test('git transport strings are recognized and normalized while local paths are not', () => {
  const remotes = [
    ['https://github.com/org/repo', { url: 'https://github.com/org/repo.git' }],
    ['https://github.com/org/repo.git', { url: 'https://github.com/org/repo.git' }],
    ['https://github.com/org/repo/', { url: 'https://github.com/org/repo.git' }],
    [
      'https://github.com/org/repo/tree/main',
      { url: 'https://github.com/org/repo.git', ref: 'main' },
    ],
    [
      'https://github.com/org/repo/tree/main/lib/asb',
      { url: 'https://github.com/org/repo.git', ref: 'main', subdir: 'lib/asb' },
    ],
    ['https://gitlab.com/org/repo.git', { url: 'https://gitlab.com/org/repo.git' }],
    ['git@github.com:org/repo.git', { url: 'git@github.com:org/repo.git' }],
    ['http://example.com/repo.git', { url: 'http://example.com/repo.git' }],
    ['ssh://git@github.com/org/repo', { url: 'ssh://git@github.com/org/repo' }],
    ['git://example.com/repo.git', { url: 'git://example.com/repo.git' }],
    ['file:///srv/git/repo.git', { url: 'file:///srv/git/repo.git' }],
  ] as const;
  for (const [value, expected] of remotes) {
    assert.equal(isGitUrl(value), true, value);
    assert.deepEqual(parseGitUrl(value), expected);
  }

  for (const localPath of ['/usr/local/lib', './relative/path', 'relative/path']) {
    assert.equal(isGitUrl(localPath), false, localPath);
  }
});

test('the inferred namespace is the repository or directory basename', () => {
  for (const [location, expected] of [
    ['https://github.com/org/my-repo', 'my-repo'],
    ['https://github.com/org/my-repo.git', 'my-repo'],
    ['https://github.com/org/repo/tree/main/sub', 'repo'],
    ['git@github.com:org/my-lib.git', 'my-lib'],
    ['/path/to/team-library', 'team-library'],
    ['./relative/my-lib', 'my-lib'],
  ]) {
    assert.equal(inferSourceName(location), expected);
  }
});

test('adding a local source refuses an occupied namespace, a bad namespace, or a non-directory', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = loadConfig().homes;
    const inPlugins = path.join(pluginsDir(homes), 'shortname');
    fs.mkdirSync(path.join(inPlugins, 'rules'), { recursive: true });

    // Presence under the plugins tree already makes it a source, with no
    // declaration at all, so the refused add must write nothing.
    assert.throws(() => addLocalSource(loadConfig(), 'shortname', inPlugins), /already exists/);
    assert.equal(sourcePaths().shortname, inPlugins);
    assert.equal(fs.existsSync(path.join(scratch.asbHome, 'config.toml')), false);

    const libDir = path.join(scratch.root, 'team-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });
    addLocalSource(loadConfig(), 'team.tools', libDir);
    assert.equal(sourcePaths()['team.tools'], libDir);

    assert.throws(() => addLocalSource(loadConfig(), 'team.tools', libDir), /already exists/);
    assert.throws(() => addLocalSource(loadConfig(), 'team..tools', libDir), /Invalid namespace/);
    assert.throws(
      () => addLocalSource(loadConfig(), 'missing', path.join(scratch.root, 'nope')),
      /Path does not exist/
    );
    const filePath = path.join(scratch.root, 'a-file');
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => addLocalSource(loadConfig(), 'file-src', filePath), /not a directory/);
  });
});

test('every documented declaration form resolves to its effective path', async () => {
  await withScratchHomes(async (scratch) => {
    const localRoot = path.join(scratch.root, 'local-root');
    fs.mkdirSync(path.join(localRoot, 'nested'), { recursive: true });
    const plainDir = path.join(scratch.root, 'plain-local');
    fs.mkdirSync(plainDir, { recursive: true });
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'mono-sub = "https://github.com/org/monorepo/tree/main/plugins/my-plugin"',
        'remote-ns = { url = "https://example.com/org/repo.git", subdir = "packages/plugin" }',
        `local-sub = { url = "${localRoot}", subdir = "nested" }`,
        `plain = "${plainDir}"`,
      ].join('\n')
    );
    const homes = loadConfig().homes;

    const tree = sourceFor('mono-sub');
    assert.equal(tree?.remote?.url, 'https://github.com/org/monorepo.git');
    assert.equal(tree?.remote?.ref, 'main');
    assert.equal(tree?.remote?.subdir, 'plugins/my-plugin');

    const paths = sourcePaths();
    assert.equal(
      paths['mono-sub'],
      path.join(managedSourceDir(homes, 'mono-sub'), 'plugins/my-plugin')
    );
    assert.equal(
      paths['remote-ns'],
      path.join(managedSourceDir(homes, 'remote-ns'), 'packages/plugin')
    );
    assert.equal(paths['local-sub'], path.join(localRoot, 'nested'));

    const plain = sourceFor('plain');
    assert.equal(plain?.path, plainDir);
    assert.equal(plain?.remote, undefined);
    assert.equal(fs.existsSync(managedSourceDir(homes, 'plain')), false);
  });
});

test('directories under the plugins tree are discovered, and config declarations win', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = loadConfig().homes;
    const discovered = path.join(pluginsDir(homes), 'auto');
    fs.mkdirSync(path.join(discovered, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir(homes), 'explicit'), { recursive: true });
    fs.mkdirSync(path.join(pluginsDir(homes), '.hidden'), { recursive: true });
    const elsewhere = path.join(scratch.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    // A leftover checkout must never resurrect a source that was removed.
    fs.mkdirSync(managedSourceDir(homes, 'cached-only'), { recursive: true });
    writeUserConfig(scratch, ['[plugins.sources]', `explicit = "${elsewhere}"`].join('\n'));

    const paths = sourcePaths();

    assert.equal(paths.auto, discovered);
    assert.equal(paths.explicit, elsewhere);
    assert.equal('.hidden' in paths, false);
    assert.equal('cached-only' in paths, false);
  });
});

test('a symlinked cache root fails managed reads and leaves local and subtree sources usable', async () => {
  await withScratchHomes(async (scratch) => {
    const outside = path.join(scratch.root, 'outside-cache');
    fs.mkdirSync(path.join(outside, 'linked-ns'), { recursive: true });
    fs.symlinkSync(outside, path.join(scratch.root, 'cache'));
    const localDir = path.join(scratch.root, 'local-src');
    fs.mkdirSync(localDir, { recursive: true });
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'linked-ns = { url = "https://example.com/org/repo.git" }',
        `local-ns = "${localDir}"`,
        'subtree-ns = { url = "https://example.com/org/repo.git", type = "subtree", ref = "main" }',
      ].join('\n')
    );
    const homes = loadConfig().homes;

    assert.match(sourceErrorOf('linked-ns') ?? '', /symbolic link/);
    assert.equal(fs.existsSync(path.join(outside, 'linked-ns')), true);

    const paths = sourcePaths();
    assert.equal(paths['local-ns'], localDir);
    assert.equal(paths['subtree-ns'], path.join(pluginsDir(homes), 'subtree-ns'));
    assert.deepEqual(
      resolveSources(loadConfig()).failed.map((failure) => failure.namespace),
      ['linked-ns']
    );
  });
});
