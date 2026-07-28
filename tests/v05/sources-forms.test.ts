import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config.js';
import {
  addLocalSource,
  inferSourceName,
  isGitUrl,
  managedSourceDir,
  parseGitUrl,
  pluginsDir,
  resolveSources,
  validateSourcePath,
} from '../../src/engine/sources.js';
import { type ScratchHomes, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

/**
 * Source forms and resolution, ported from the 0.4.35 sources suite: URL and
 * name classification, the local add/validate round trip, effective path
 * resolution for every documented form, and the cache-root ownership split.
 */

function sourcePaths(): Record<string, string> {
  const resolution = resolveSources(loadConfig());
  const record: Record<string, string> = {};
  for (const source of resolution.sources) record[source.namespace] = source.path;
  return record;
}

function sourceErrors(): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const failure of resolveSources(loadConfig()).failed) {
    errors[failure.namespace] = failure.error;
  }
  return errors;
}

test('isGitUrl classifies remote URLs and local paths', () => {
  for (const [value, expected] of [
    ['https://github.com/org/repo', true],
    ['http://example.com/repo.git', true],
    ['git@github.com:org/repo.git', true],
    ['ssh://git@github.com/org/repo', true],
    ['git://example.com/repo.git', true],
    ['file:///srv/git/repo.git', true],
    ['/usr/local/lib', false],
    ['./relative/path', false],
    ['relative/path', false],
  ] as const) {
    assert.equal(isGitUrl(value), expected);
  }
});

test('parseGitUrl normalizes GitHub URLs and passes other transports through', () => {
  const cases = [
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
  ] as const;
  for (const [value, expected] of cases) assert.deepEqual(parseGitUrl(value), expected);
});

test('inferSourceName handles remote and local source locations', () => {
  for (const [value, expected] of [
    ['https://github.com/org/my-repo', 'my-repo'],
    ['https://github.com/org/my-repo.git', 'my-repo'],
    ['https://github.com/org/repo/tree/main/sub', 'repo'],
    ['git@github.com:org/my-lib.git', 'my-lib'],
    ['/path/to/team-library', 'team-library'],
    ['./relative/my-lib', 'my-lib'],
  ]) {
    assert.equal(inferSourceName(value), expected);
  }
});

test('a local source round-trips through the config and resolves to its directory', async () => {
  await withScratchHomes(async (scratch) => {
    const libDir = path.join(scratch.root, 'test-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource(loadConfig(), 'local-team', libDir);

    assert.equal(sourcePaths()['local-team'], libDir);
    const source = resolveSources(loadConfig()).sources.find((s) => s.namespace === 'local-team');
    assert.equal(source?.remote, undefined);
    assert.equal(source?.configured, true);
  });
});

test('dotted namespaces are accepted and empty segments are refused', async () => {
  await withScratchHomes(async (scratch) => {
    const libDir = path.join(scratch.root, 'dotted-lib');
    fs.mkdirSync(path.join(libDir, 'rules'), { recursive: true });

    addLocalSource(loadConfig(), 'team.tools', libDir);

    assert.equal(sourcePaths()['team.tools'], libDir);
    assert.throws(() => addLocalSource(loadConfig(), 'team..tools', libDir), /Invalid namespace/);
  });
});

test('a namespace carrying path segments fails alone instead of resolving', async () => {
  await withScratchHomes(async () => {
    writeUserConfig(
      { asbHome: process.env.ASB_HOME as string } as ScratchHomes,
      '[plugins.sources."../outside"]\nurl = "https://example.invalid/repo.git"\ntype = "clone"\n'
    );

    assert.match(sourceErrors()['../outside'] ?? '', /Invalid namespace/);
    assert.deepEqual(resolveSources(loadConfig()).sources, []);
  });
});

test('a duplicate, invalid, or missing local path is refused', async () => {
  await withScratchHomes(async (scratch) => {
    const libDir = path.join(scratch.root, 'dup-lib');
    fs.mkdirSync(libDir, { recursive: true });
    addLocalSource(loadConfig(), 'dup', libDir);

    assert.throws(() => addLocalSource(loadConfig(), 'dup', libDir), /already exists/);
    assert.throws(
      () => addLocalSource(loadConfig(), 'missing', path.join(scratch.root, 'nope')),
      /Path does not exist/
    );
    const filePath = path.join(scratch.root, 'a-file');
    fs.writeFileSync(filePath, 'x');
    assert.throws(() => addLocalSource(loadConfig(), 'file-src', filePath), /not a directory/);
  });
});

test('a directory already discovered under the plugins tree is not redeclared', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = loadConfig().homes;
    const inPlugins = path.join(pluginsDir(homes), 'shortname');
    fs.mkdirSync(path.join(inPlugins, 'rules'), { recursive: true });

    assert.throws(() => addLocalSource(loadConfig(), 'shortname', inPlugins), /already exists/);

    // Presence alone already makes it a source, with no declaration at all.
    assert.equal(sourcePaths().shortname, inPlugins);
    assert.equal(fs.existsSync(path.join(scratch.asbHome, 'config.toml')), false);
  });
});

test('validateSourcePath recognizes library folders and both native manifest families', async () => {
  await withScratchHomes(async (scratch) => {
    const library = path.join(scratch.root, 'library-src');
    fs.mkdirSync(path.join(library, 'rules'), { recursive: true });
    fs.mkdirSync(path.join(library, 'skills'), { recursive: true });
    assert.deepEqual(validateSourcePath(library), {
      valid: true,
      found: ['rules', 'skills'],
      missing: ['commands', 'agents', 'hooks'],
      kind: 'plugin',
    });

    const marketplace = path.join(scratch.root, 'marketplace-src');
    fs.mkdirSync(path.join(marketplace, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'catalog', plugins: [] })
    );
    assert.equal(validateSourcePath(marketplace).kind, 'marketplace');

    const codexPlugin = path.join(scratch.root, 'codex-src');
    fs.mkdirSync(path.join(codexPlugin, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(codexPlugin, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'codex-plugin' })
    );
    assert.equal(validateSourcePath(codexPlugin).kind, 'plugin');

    const empty = path.join(scratch.root, 'empty-src');
    fs.mkdirSync(empty, { recursive: true });
    assert.equal(validateSourcePath(empty).valid, false);
  });
});

test('a remote source resolves into the managed cache and exposes its remote', async () => {
  await withScratchHomes(async (scratch) => {
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'remote-ns = { url = "https://example.com/org/repo.git", type = "clone" }',
      ].join('\n')
    );
    const config = loadConfig();

    const [source] = resolveSources(config).sources;
    assert.equal(source.path, managedSourceDir(config.homes, 'remote-ns'));
    assert.equal(source.remote?.url, 'https://example.com/org/repo.git');
  });
});

test('a subdir joins onto the resolved checkout for both remote and local forms', async () => {
  await withScratchHomes(async (scratch) => {
    const localRoot = path.join(scratch.root, 'local-root');
    fs.mkdirSync(path.join(localRoot, 'nested'), { recursive: true });
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'remote-ns = { url = "https://example.com/org/repo.git", subdir = "packages/plugin" }',
        `local-ns = { url = "${localRoot}", subdir = "nested" }`,
      ].join('\n')
    );
    const config = loadConfig();
    const paths = sourcePaths();

    assert.equal(
      paths['remote-ns'],
      path.join(managedSourceDir(config.homes, 'remote-ns'), 'packages/plugin')
    );
    assert.equal(paths['local-ns'], path.join(localRoot, 'nested'));
  });
});

test('a documented GitHub tree URL string carries its ref and subdir', async () => {
  await withScratchHomes(async (scratch) => {
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        'mono-sub = "https://github.com/org/monorepo/tree/main/plugins/my-plugin"',
      ].join('\n')
    );
    const config = loadConfig();

    const [source] = resolveSources(config).sources;
    assert.equal(source.remote?.url, 'https://github.com/org/monorepo.git');
    assert.equal(source.remote?.ref, 'main');
    assert.equal(source.remote?.subdir, 'plugins/my-plugin');
    assert.equal(
      source.path,
      path.join(managedSourceDir(config.homes, 'mono-sub'), 'plugins/my-plugin')
    );
  });
});

test('a local string source is never cache-resolved', async () => {
  await withScratchHomes(async (scratch) => {
    const localDir = path.join(scratch.root, 'plain-local');
    fs.mkdirSync(localDir, { recursive: true });
    writeUserConfig(scratch, ['[plugins.sources]', `plain = "${localDir}"`].join('\n'));
    const config = loadConfig();

    const [source] = resolveSources(config).sources;
    assert.equal(source.path, localDir);
    assert.equal(source.remote, undefined);
    assert.equal(fs.existsSync(managedSourceDir(config.homes, 'plain')), false);
  });
});

test('directories under the plugins tree are discovered, and config declarations win', async () => {
  await withScratchHomes(async (scratch) => {
    const homes = loadConfig().homes;
    const discovered = path.join(pluginsDir(homes), 'auto');
    fs.mkdirSync(path.join(discovered, 'rules'), { recursive: true });
    const overridden = path.join(pluginsDir(homes), 'explicit');
    fs.mkdirSync(overridden, { recursive: true });
    const elsewhere = path.join(scratch.root, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.mkdirSync(path.join(pluginsDir(homes), '.hidden'), { recursive: true });
    writeUserConfig(scratch, ['[plugins.sources]', `explicit = "${elsewhere}"`].join('\n'));

    const paths = sourcePaths();

    assert.equal(paths.auto, discovered);
    assert.equal(paths.explicit, elsewhere);
    assert.equal('.hidden' in paths, false);
  });
});

test('a cache directory never becomes an auto-discovered source', async () => {
  await withScratchHomes(async () => {
    const config = loadConfig();
    fs.mkdirSync(managedSourceDir(config.homes, 'cached-only'), { recursive: true });

    assert.deepEqual(resolveSources(loadConfig()).sources, []);
  });
});

test('managed reads reject a cache child behind a symlinked cache root', async () => {
  await withScratchHomes(async (scratch) => {
    const outside = path.join(scratch.root, 'outside-cache');
    fs.mkdirSync(path.join(outside, 'linked-ns'), { recursive: true });
    fs.symlinkSync(outside, path.join(scratch.root, 'cache'));
    writeUserConfig(
      scratch,
      ['[plugins.sources]', 'linked-ns = { url = "https://example.com/org/repo.git" }'].join('\n')
    );

    assert.match(sourceErrors()['linked-ns'] ?? '', /symbolic link/);
    assert.equal(fs.existsSync(path.join(outside, 'linked-ns')), true);
  });
});

test('local and subtree resolution stay usable behind a symlinked cache root', async () => {
  await withScratchHomes(async (scratch) => {
    const outside = path.join(scratch.root, 'outside-cache');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(scratch.root, 'cache'));
    const localDir = path.join(scratch.root, 'local-src');
    fs.mkdirSync(localDir, { recursive: true });
    writeUserConfig(
      scratch,
      [
        '[plugins.sources]',
        `local-ns = "${localDir}"`,
        'subtree-ns = { url = "https://example.com/org/repo.git", type = "subtree", ref = "main" }',
      ].join('\n')
    );
    const config = loadConfig();

    const paths = sourcePaths();
    assert.equal(paths['local-ns'], localDir);
    assert.equal(paths['subtree-ns'], path.join(pluginsDir(config.homes), 'subtree-ns'));
    assert.deepEqual(resolveSources(config).failed, []);
  });
});
