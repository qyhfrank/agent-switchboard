import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { APP_ROWS } from '../../src/engine/apps.js';
import {
  main,
  parseCliArgs,
  runAddSource,
  runExplain,
  runImport,
  runSync,
  selectedFor,
} from '../../src/engine/cli.js';
import { loadConfig } from '../../src/engine/config.js';
import { acquireRunLock, loadLedger } from '../../src/engine/ledger.js';
import { projectManifestPath } from '../../src/engine/peer.js';
import { type Action, groupKeyActions } from '../../src/engine/plan.js';
import { renderExplain } from '../../src/engine/report.js';
import { applyKeysEdits } from '../../src/engine/shapes.js';
import { readSourceCatalog } from '../../src/engine/sources.js';
import {
  installApps,
  readMcpHost,
  ruleFilePath,
  seedMcpLibrary,
  seedRule,
  seedSkill,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

async function runMain(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await main(argv), out, err };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test('A1 global and project ledger claims stay inside their planning scope in both orders', async () => {
  for (const order of ['project-first', 'global-first'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        '[distribution.project]\nmode = "managed"\n\n[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["shared"]\n'
      );
      installApps(homes, 'claude-code');
      seedRule(homes, 'shared.md', 'Shared rule.\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["shared"]\n'
      );

      const runs =
        order === 'project-first'
          ? [() => runSync({ project }), () => runSync()]
          : [() => runSync(), () => runSync({ project })];
      for (const run of runs) assert.equal((await run()).exitCode, 0, order);

      const globalStatus = await runSync({ dryRun: true });
      const projectStatus = await runSync({ dryRun: true, project });
      assert.equal(globalStatus.exitCode, 0, JSON.stringify(globalStatus.entries, null, 2));
      assert.equal(projectStatus.exitCode, 0, JSON.stringify(projectStatus.entries, null, 2));
      assert.equal(
        [...globalStatus.entries, ...projectStatus.entries].some(
          (entry) => entry.detail === 'path-escape'
        ),
        false
      );
    });
  }
});

test('A4 atomic rewrites preserve an existing private mode on the temp and target', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedRule(homes, 'private.md', 'First.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["private"]\n'
    );
    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const target = ruleFilePath(homes, 'codex');
    fs.chmodSync(target, 0o600);
    seedRule(homes, 'private.md', 'Second.\n');

    const previousUmask = process.umask(0o022);
    const originalRename = fs.renameSync;
    let tempMode: number | undefined;
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(newPath)) === target) {
        tempMode = fs.statSync(oldPath).mode & 0o777;
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;
    try {
      assert.equal((await runSync()).exitCode, 0);
    } finally {
      fs.renameSync = originalRename;
      process.umask(previousUmask);
    }

    assert.equal(tempMode, 0o600);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });
});

test('A2 a still-selected MCP id is not retired when its definition is missing', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { gone: { command: 'npx', args: ['gone'] } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["gone"]\n');
    assert.equal((await runSync()).exitCode, 0);

    seedMcpLibrary(homes, {});
    const dry = await runSync({ dryRun: true });
    assert.ok(dry.entries.some((entry) => entry.id === 'gone' && entry.outcome === 'missing'));
    assert.equal(
      dry.entries.some((entry) => entry.reason?.includes('retired gone')),
      false
    );

    const real = await runSync();
    assert.ok(real.entries.some((entry) => entry.id === 'gone' && entry.outcome === 'missing'));
    assert.equal(
      real.entries.some((entry) => entry.reason?.includes('retired gone')),
      false
    );
    assert.ok(readMcpHost(homes, 'codex')?.gone);
  });
});

test('A3 dry-run mirrors the real pre-write abort for an unresolved enabled source', async () => {
  await withScratchHomes(async (homes) => {
    const source = path.join(homes.asbHome, 'plugins', 'pack');
    fs.mkdirSync(path.join(source, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(source, 'rules', 'style.md'), 'Plugin rule.\n');
    installApps(homes, 'claude-code');
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
        '[plugins.sources]',
        `pack = ${JSON.stringify(source)}`,
        '',
      ].join('\n')
    );
    assert.equal((await runSync()).exitCode, 0);
    fs.mkdirSync(path.join(homes.cacheHome, 'pack'), { recursive: true });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[plugins]',
        'enabled = ["pack"]',
        '',
        '[plugins.sources]',
        `pack = { url = ${JSON.stringify(`file://${path.join(homes.root, 'missing.git')}`)}, type = "clone" }`,
        '',
      ].join('\n')
    );

    const dry = await runSync({ dryRun: true });
    const real = await runSync();
    for (const report of [dry, real]) {
      assert.equal(report.exitCode, 2, JSON.stringify(report.entries, null, 2));
      assert.ok(report.entries.some((entry) => entry.id === 'pack'));
      assert.equal(
        report.entries.some(
          (entry) => entry.type === 'rules' && ['removed', 'written'].includes(entry.outcome)
        ),
        false,
        JSON.stringify(report.entries, null, 2)
      );
    }
  });
});

test('A5 explain masks every credential value after every builtin MCP dialect', async () => {
  await withScratchHomes(async (homes) => {
    const localSecret = 'LOCAL-SECRET-a5';
    const remoteSecret = 'REMOTE-SECRET-a5';
    for (const row of APP_ROWS) fs.mkdirSync(row.detectDir(homes), { recursive: true });
    seedMcpLibrary(homes, {
      local: { command: 'run', env: { API_TOKEN: localSecret } },
      remote: {
        type: 'http',
        url: 'https://example.invalid/mcp',
        headers: { Authorization: remoteSecret },
      },
    });
    writeUserConfig(
      homes,
      `[applications]\nenabled = [${APP_ROWS.map((row) => JSON.stringify(row.id)).join(', ')}]\n\n[mcp]\nenabled = ["local", "remote"]\n`
    );

    for (const id of ['local', 'remote']) {
      const slices = await runExplain(id);
      for (const row of APP_ROWS.filter((candidate) => candidate.mcp)) {
        const slice = slices.find((candidate) => candidate.app === row.id);
        assert.ok(slice, `${row.id}/${id}`);
        const json = JSON.stringify(slice);
        const text = renderExplain([slice], id);
        assert.equal(json.includes(localSecret) || json.includes(remoteSecret), false, row.id);
        assert.equal(text.includes(localSecret) || text.includes(remoteSecret), false, row.id);
      }
    }
  });
});

test('A6 removing the project marker span preserves every user byte around it', async () => {
  // Trailing-boundary contract: the managed region joins user content with
  // exactly one blank line and the file ends with one newline; interior and
  // leading user bytes round-trip exactly under both placements.
  for (const placement of ['prepend', 'append'] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, `project-${placement}`);
      fs.mkdirSync(project);
      const projectConfig = `[distribution.project]\nmode = "managed"\n\n[distribution.project.rules]\nplacement = "${placement}"\n\n[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared"]\n`;
      fs.writeFileSync(path.join(project, '.asb.toml'), projectConfig);
      const agents = path.join(project, 'AGENTS.md');
      const userBytes = '# First user section\n\n\n# Second user section\n';
      fs.writeFileSync(agents, userBytes);
      installApps(homes, 'codex');
      seedRule(homes, 'shared.md', 'Managed.\n');
      writeUserConfig(
        homes,
        '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared"]\n'
      );
      assert.equal((await runSync({ project })).exitCode, 0, placement);

      fs.writeFileSync(
        path.join(project, '.asb.toml'),
        projectConfig.replace('enabled = ["shared"]', 'enabled = []')
      );
      assert.equal((await runSync({ project })).exitCode, 0, placement);
      assert.equal(fs.readFileSync(agents, 'utf-8'), userBytes, placement);
    });
  }
});

test('A7 hook key edits preserve unrelated JSONC bytes and retire only the legacy key', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const hookDir = path.join(homes.asbHome, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, 'format.json'),
      JSON.stringify({
        name: 'format',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo managed' }] }] },
      })
    );
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[hooks]\nenabled = ["format"]\n'
    );
    const settings = path.join(homes.agentsHome, '.claude', 'settings.json');
    const unrelated = '  "theme"  :  "dark"\n';
    fs.writeFileSync(settings, `{\n  "_asb_managed_hooks": [],\n  "hooks": {},\n${unrelated}}\n`);

    const report = await runSync();
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const content = fs.readFileSync(settings, 'utf-8');
    assert.ok(content.includes(unrelated), content);
    assert.equal(content.includes('_asb_managed_hooks'), false);
    assert.match(content, /echo managed/);
  });
});

test('A8 smoke owns the pinned 0.4 peer leg and the in-tree test names 0.5 resync', () => {
  const smoke = fs.readFileSync(
    new URL('../../scripts/smoke-baseline.mjs', import.meta.url),
    'utf-8'
  );
  assert.match(smoke, /peerDryRun/);
  assert.match(smoke, /stateIntact/);
  assert.equal(
    fs.existsSync(new URL('hooks-peer-probe.test.ts', import.meta.url)),
    false,
    'the in-tree 0.5 test must not claim to execute 0.4.35'
  );
  assert.equal(fs.existsSync(new URL('hooks-resync.test.ts', import.meta.url)), true);
});

test('A9a bare asb is a compact read-only status with one next action', async () => {
  await withScratchHomes(async (homes) => {
    const before = fs.readdirSync(homes.root, { recursive: true }).map(String).sort();
    const result = await runMain([]);
    const after = fs.readdirSync(homes.root, { recursive: true }).map(String).sort();

    assert.equal(result.code, 0, result.err || result.out);
    assert.match(result.out, /^Status:/);
    assert.equal(result.out.match(/^Next:/gm)?.length, 1, result.out);
    assert.deepEqual(after, before);

    // The routing among the real branches: pending work points at sync,
    // an all-current home points at the detailed view.
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Core.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[rules]\nenabled = ["core"]\n'
    );
    const pending = await runMain([]);
    assert.match(pending.out, /^Next: asb sync$/m, pending.out);

    assert.equal((await runSync()).exitCode, 0);
    const current = await runMain([]);
    assert.match(current.out, /^Next: asb status --all$/m, current.out);
    assert.equal(current.code, 0, current.err || current.out);
  });
});

test('A9b add --marketplace is parsed and rejects a plain library without writing', async () => {
  await withScratchHomes(async (homes) => {
    const invocation = parseCliArgs(['add', homes.root, '--marketplace']);
    assert.equal(invocation.command, 'add');
    if (invocation.command !== 'add') return;
    assert.equal(invocation.options.marketplace, true);

    fs.mkdirSync(path.join(homes.root, 'plain', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(homes.root, 'plain', 'rules', 'x.md'), 'x\n');
    await assert.rejects(
      () => runAddSource(path.join(homes.root, 'plain'), { as: 'plain', marketplace: true }),
      /marketplace manifest/i
    );
    assert.equal(fs.existsSync(path.join(homes.asbHome, 'config.toml')), false);
  });
});

test('A9c --source scopes readiness and contains an out-of-scope unresolved source', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedRule(homes, 'core.md', 'Core.\n');
    const healthy = path.join(homes.asbHome, 'plugins', 'healthy');
    seedSkill(homes, 'unused');
    fs.mkdirSync(path.join(healthy, 'skills', 'alpha'), { recursive: true });
    fs.writeFileSync(
      path.join(healthy, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: alpha\n---\n\nAlpha.\n'
    );
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["claude-code"]',
        '',
        '[rules]',
        'enabled = ["core"]',
        '',
        '[plugins]',
        'enabled = ["healthy"]',
        '',
        '[plugins.sources]',
        `healthy = ${JSON.stringify(healthy)}`,
        `"../broken" = ${JSON.stringify(path.join(homes.root, 'broken'))}`,
        '',
      ].join('\n')
    );

    const report = await runSync({ sources: ['healthy'] });
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

test('A10 status and explain expose component-free sources and plugins', async () => {
  await withScratchHomes(async (homes) => {
    const source = path.join(homes.asbHome, 'plugins', 'shop');
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'empty'));
    fs.writeFileSync(
      path.join(source, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'shop', plugins: [{ name: 'empty', source: './empty' }] })
    );
    writeUserConfig(homes, '[applications]\nenabled = []\n');

    const all = await runSync({ dryRun: true, all: true });
    assert.ok(
      all.entries.some(
        (entry) => entry.type === 'plugins' && entry.id === 'shop' && entry.path === source
      ),
      JSON.stringify(all.entries, null, 2)
    );
    assert.ok(
      all.entries.some((entry) => entry.type === 'plugins' && entry.id === 'empty@shop'),
      JSON.stringify(all.entries, null, 2)
    );

    const typed = await runSync({ dryRun: true, types: ['plugins'] });
    assert.ok(typed.entries.some((entry) => entry.id === 'shop'));
    assert.ok(typed.entries.some((entry) => entry.id === 'empty@shop'));
    assert.ok((await runExplain('shop')).length > 0);
    assert.ok((await runExplain('empty@shop')).length > 0);
  });
});

test('A11 CLI rejects inapplicable flags and unknown apps before selection writes', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[applications]\nenabled = []\n');
    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');

    assert.throws(
      () => parseCliArgs(['enable', 'demo', '--type', 'skills', '--dry-run']),
      /dry-run/
    );
    assert.throws(() => parseCliArgs(['add', homes.root, '-P', homes.root]), /project/);

    const unknown = await runMain(['enable', 'demo', '--type', 'mcp', '--app', 'codez']);
    assert.equal(unknown.code, 2, unknown.out || unknown.err);
    assert.match(unknown.err, /Unknown app "codez"/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);

    const unresolved = await runMain(['enable', 'future', '--type', 'mcp']);
    assert.equal(unresolved.code, 0, unresolved.err);
    assert.match(unresolved.out, /cannot validate.*next sync/i);
  });
});

test('A12 scoped picker selection comes only from the target layer', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      '[commands]\nenabled = ["inherited"]\n\n[applications.cursor.commands]\nadd = ["inherited-app"]\n'
    );
    fs.writeFileSync(
      path.join(homes.asbHome, 'work.toml'),
      '[commands]\nenabled = ["profile-only"]\n\n[applications.cursor.commands]\nadd = ["profile-app"]\n'
    );
    const profile = loadConfig({ profile: 'work' });
    assert.deepEqual(selectedFor(profile, 'commands', undefined), ['profile-only']);
    assert.deepEqual(selectedFor(profile, 'commands', 'cursor'), ['profile-app']);

    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.asb.toml'), '[applications]\nenabled = []\n');
    const projectConfig = loadConfig({ profile: 'work', project });
    assert.deepEqual(selectedFor(projectConfig, 'commands', undefined), []);
    assert.deepEqual(selectedFor(projectConfig, 'commands', 'cursor'), []);
  });
});

test('B1 a failed stale bundle deletion stays claimed and reports left-behind', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    const source = seedSkill(homes, 'alpha', { files: { 'old.txt': 'old\n' } });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[skills]\nenabled = ["alpha"]\n'
    );
    const first = await runSync();
    const bundle = first.entries.find(
      (entry) => entry.app === 'codex' && entry.type === 'skills' && entry.id === 'alpha'
    )?.path;
    assert.ok(bundle);
    fs.unlinkSync(path.join(source, 'old.txt'));

    const staleTarget = path.join(bundle, 'old.txt');
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (path.resolve(String(target)) === staleTarget) throw new Error('simulated busy file');
      return originalUnlink(target);
    }) as typeof fs.unlinkSync;
    let report: Awaited<ReturnType<typeof runSync>>;
    try {
      report = await runSync();
    } finally {
      fs.unlinkSync = originalUnlink;
    }

    const entry = report.entries.find(
      (candidate) =>
        candidate.app === 'codex' && candidate.type === 'skills' && candidate.id === 'alpha'
    );
    assert.equal(entry?.outcome, 'left-behind', JSON.stringify(report.entries, null, 2));
    assert.equal(entry?.detail, 'remove-failed');
    assert.ok(fs.existsSync(staleTarget));
    const proof = loadLedger(homes.stateHome).entries.find(
      (candidate) => candidate.path === bundle
    );
    assert.ok(proof?.files?.includes('old.txt'), JSON.stringify(proof, null, 2));
  });
});

test('B2 same-host incompatible views and overlapping keys cancel every write', () => {
  const action = (id: string, baseContent: string, keyPath: string[]): Action => ({
    app: id,
    type: 'mcp',
    id,
    path: '/tmp/shared.json',
    op: 'write',
    outcome: 'written',
    content: '{}',
    root: '/tmp',
    expectedHash: null,
    keyEdits: {
      format: 'json',
      baseContent,
      edits: [{ keyPath, value: { command: id } }],
    },
  });

  for (const actions of [
    [action('one', '{}', ['mcpServers', 'same']), action('two', '{}', ['mcpServers', 'same'])],
    [action('one', '{}', ['mcpServers', 'one']), action('two', '{ }', ['mcpServers', 'two'])],
  ]) {
    const grouped = groupKeyActions(actions);
    assert.equal(
      grouped.some((candidate) => candidate.op === 'write'),
      false,
      JSON.stringify(grouped)
    );
    assert.equal(
      grouped.every(
        (candidate) => candidate.outcome === 'conflict' || candidate.outcome === 'failed'
      ),
      true
    );
  }
});

test('B3 plugin enable accepts an unambiguous manifest name alias', async () => {
  await withScratchHomes(async (homes) => {
    const source = path.join(homes.asbHome, 'plugins', 'shop');
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'demo'));
    fs.writeFileSync(
      path.join(source, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'shop', plugins: [{ name: 'demo', source: './demo' }] })
    );
    writeUserConfig(homes, '[applications]\nenabled = []\n');

    const result = await runMain(['enable', 'demo']);
    assert.equal(result.code, 0, result.err);
    assert.match(fs.readFileSync(path.join(homes.asbHome, 'config.toml'), 'utf-8'), /"demo"/);
  });
});

test('B4 default app directories import immediate files without recursive mode', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'gemini');
    const row = APP_ROWS.find((candidate) => candidate.id === 'gemini');
    assert.ok(row?.commands);
    const source = row.commands.dir(homes);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'review.toml'), 'prompt = "Review this"\n');

    const result = await runImport('gemini', undefined, { force: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.entries, null, 2));
    assert.ok(result.entries.some((entry) => entry.type === 'commands' && entry.id === 'review'));
  });
});

test('B6 a stale lock fails closed with the holder identity and is never reaped', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(homes.stateHome, { recursive: true });
    const lockFile = path.join(homes.stateHome, 'run.lock');
    const stale = '999999 2000-01-01T00:00:00.000Z\n';
    fs.writeFileSync(lockFile, stale);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);

    assert.throws(() => acquireRunLock(homes.stateHome), /Another asb run.*not running/s);
    assert.equal(fs.readFileSync(lockFile, 'utf-8'), stale);
    assert.deepEqual(
      fs.readdirSync(homes.stateHome).filter((name) => name.startsWith('run.lock.')),
      []
    );
  });
});

test('B6 release only unlinks the lock generation this process wrote', async () => {
  await withScratchHomes(async (homes) => {
    const lockFile = path.join(homes.stateHome, 'run.lock');
    const lock = acquireRunLock(homes.stateHome);
    const foreign = `${process.pid} 2099-01-01T00:00:00.000Z (foreign)\n`;
    fs.writeFileSync(lockFile, foreign);
    lock.release();
    assert.equal(fs.readFileSync(lockFile, 'utf-8'), foreign);

    fs.unlinkSync(lockFile);
    const second = acquireRunLock(homes.stateHome);
    second.release();
    assert.equal(fs.existsSync(lockFile), false);
  });
});

test('B7 marketplace plugin names must encode one child path segment', async () => {
  await withScratchHomes(async (homes) => {
    const source = path.join(homes.asbHome, 'plugins', 'shop');
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'demo'));
    fs.writeFileSync(
      path.join(source, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'shop', plugins: [{ name: '../escape', source: './demo' }] })
    );
    writeUserConfig(homes, '[applications]\nenabled = []\n');

    const catalog = readSourceCatalog(loadConfig());
    assert.equal(
      catalog.plugins.some((plugin) => plugin.name === '../escape'),
      false
    );
    assert.ok(catalog.failed.some((failure) => /one path segment/i.test(failure.error)));
  });
});

test('B8 null project manifest entries are contained as corrupt state', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\n\n[applications]\nenabled = ["codex"]\n'
    );
    installApps(homes, 'codex');
    const manifest = projectManifestPath(homes.asbHome, project);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        updatedAt: '2000-01-01T00:00:00.000Z',
        projectRoot: project,
        sections: { mcp: { 'alpha::codex': null } },
      })
    );

    const report = await runSync({ project });
    assert.equal(report.exitCode, 1, JSON.stringify(report.entries, null, 2));
    assert.ok(report.entries.some((entry) => entry.detail === 'parse-error'));
  });
});

test('B11 selection and explain JSON use the standard report envelope', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[applications]\nenabled = []\n');
    for (const result of [
      await runMain(['enable', 'future', '--type', 'mcp', '--json']),
      await runMain(['explain', 'future', '--json']),
    ]) {
      const envelope = JSON.parse(result.out) as Record<string, unknown>;
      assert.equal(envelope.version, 1);
      assert.equal(typeof envelope.scope, 'object');
      assert.ok(Array.isArray(envelope.entries));
      assert.equal(typeof envelope.summary, 'object');
      assert.equal(typeof envelope.exitCode, 'number');
    }
  });
});

test('B9 changelog enumerates all eight ratified migration-visible changes', () => {
  const changelog = fs.readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf-8');
  for (const phrase of [
    'rules import',
    'reconciles that source',
    'collides with a builtin',
    'no-codex-role',
    'Non-ASCII',
    'commented scaffold',
    'materializes the checkout',
    '.codex/skills',
  ]) {
    assert.ok(changelog.includes(phrase), phrase);
  }
});

test('a project sync records ownership in the manifest only, never the machine ledger', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'proj-ledger');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "managed"\n\n[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared"]\n'
    );
    installApps(homes, 'codex');
    seedRule(homes, 'shared.md', 'Managed.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\n\n[rules]\nenabled = ["shared"]\n'
    );

    const report = await runSync({ project });
    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.ok(report.entries.some((entry) => entry.outcome === 'written'));
    assert.deepEqual(loadLedger(homes.stateHome).entries, []);
  });
});

test('a canceled structured write never publishes peer ownership', () => {
  const peer = {
    asbHome: '/tmp/none',
    target: { app: 'claude-code' },
    state: { version: 1, groups: {}, bundles: [], updatedAt: '' },
  } as unknown as NonNullable<Action['peer']>;
  const base: Action = {
    app: 'claude-code',
    type: 'hooks',
    id: null,
    path: '/tmp/none/settings.json',
    op: 'write',
    outcome: 'written',
    root: '/tmp/none',
    expectedHash: null,
    content: '{}',
    peer,
    keyEdits: {
      format: 'json',
      edits: [{ keyPath: ['hooks'], value: { a: 1 } }],
      baseContent: '{}',
    },
  };
  const other: Action = {
    ...base,
    type: 'mcp',
    peer: undefined,
    keyEdits: {
      format: 'json',
      edits: [{ keyPath: ['hooks', 'x'], value: 2 }],
      baseContent: '{}',
    },
  };
  const grouped = groupKeyActions([base, other]);
  assert.equal(grouped.length, 2);
  for (const action of grouped) {
    assert.equal(action.outcome, 'conflict', JSON.stringify(action));
    assert.equal(action.peer, undefined, 'a canceled action must carry no peer publication');
  }
});

test('JSON key edits fail closed on duplicate addressed keys', () => {
  const doc = '{"hooks": {"a": 1}, "other": 2, "hooks": {"b": 2}}';
  assert.throws(
    () => applyKeysEdits(doc, 'json', [{ keyPath: ['hooks'], value: { c: 3 } }]),
    /duplicate key "hooks"/
  );
});

test(
  'init --json on an existing config answers with a skipped envelope, no prompt',
  { timeout: 15000 },
  async () => {
    await withScratchHomes(async (homes) => {
      const previous = process.cwd();
      const dir = path.join(homes.root, 'proj-init');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '.asb.toml'), '# existing\n');
      process.chdir(dir);
      try {
        const result = await runMain(['init', '--json']);
        assert.equal(result.code, 0, result.err || result.out);
        const envelope = JSON.parse(result.out) as {
          exitCode: number;
          entries: { outcome?: string }[];
        };
        assert.equal(envelope.exitCode, 0);
        assert.ok(
          envelope.entries.some((entry) => entry.outcome === 'skipped'),
          result.out
        );
        assert.equal(fs.readFileSync(path.join(dir, '.asb.toml'), 'utf-8'), '# existing\n');
        assert.equal(fs.existsSync(path.join(dir, 'AGENTS.md')), false);
      } finally {
        process.chdir(previous);
      }
    });
  }
);

test('a custom target env_transform with identical field names is rejected', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(
      homes,
      [
        '[targets.mine]',
        'detect = "~/.mine"',
        '',
        '[targets.mine.mcp]',
        'format = "yaml"',
        'config_path = "~/.mine/config.yaml"',
        'root_key = "servers"',
        'structure = "keyed-array"',
        'key_field = "name"',
        'env_transform = { key_name = "env", value_name = "env" }',
        '',
      ].join('\n')
    );
    assert.throws(() => loadConfig(), /key_name and value_name must differ/);
  });
});
