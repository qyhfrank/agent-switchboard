import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { main, parseCliArgs, runExplain, runSync } from '../../src/engine/cli.js';
import { ConfigError } from '../../src/engine/config.js';
import { renderExplain } from '../../src/engine/report.js';
import { hashContent } from '../../src/engine/shapes.js';
import {
  cocoConfigDir,
  installApps,
  seedMcpLibrary,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function write(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function seedBareCodexPlugin(asbHome: string): string {
  const root = path.join(asbHome, 'plugins', 'bare');
  write(path.join(root, '.codex-plugin', 'plugin.json'), '{"name":"demo","version":"1.0.0"}\n');
  return root;
}

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

test('--help and --version succeed on the engine surface', async () => {
  const version = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
  ).version as string;
  const help = await runMain(['--help']);
  const reported = await runMain(['--version']);

  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /Usage: asb/);
  assert.equal(help.err, '');
  assert.equal(reported.code, 0, reported.err);
  assert.equal(reported.out.trim(), version);
  assert.equal(reported.err, '');
});

test('status parses its id glob and --all position-independently', () => {
  const after = parseCliArgs(['status', 'build-*', '--all', '--type', 'commands']);
  const before = parseCliArgs(['--all', '--type', 'commands', 'status', 'build-*']);
  assert.deepEqual(before, after);
  assert.equal(after.command, 'status');
  if (after.command !== 'status') return;
  assert.equal(after.options.idGlob, 'build-*');
  assert.equal(after.options.all, true);
  assert.deepEqual(after.options.types, ['commands']);
});

test('status defaults to relevant rows while --all seeds inventory and app/type probes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    write(path.join(homes.asbHome, 'commands', 'active.md'), 'Active.\n');
    write(path.join(homes.asbHome, 'commands', 'inactive.md'), 'Inactive.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["active", "ghost"]\n'
    );

    const defaults = await runSync({ dryRun: true });
    assert.ok(defaults.entries.some((row) => row.id === 'active'));
    assert.ok(defaults.entries.some((row) => row.id === 'ghost' && row.outcome === 'missing'));
    assert.equal(
      defaults.entries.some((row) => row.id === 'inactive'),
      false
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
      )
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
    for (const id of ['build-live', 'build-later', 'review']) {
      write(path.join(homes.asbHome, 'commands', `${id}.md`), `${id}\n`);
    }
    write(path.join(homes.asbHome, 'agents', 'build-agent.md'), 'Agent.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["build-live", "build-missing"]\n\n[agents]\nenabled = ["build-agent"]\n'
    );

    const defaultTyped = await runSync({ dryRun: true, types: ['commands'] });
    assert.equal(
      defaultTyped.entries.every((row) => row.type === null || row.type === 'commands'),
      true,
      JSON.stringify(defaultTyped.entries, null, 2)
    );
    assert.equal(
      defaultTyped.entries.some((row) => row.type === 'agents'),
      false
    );

    const typed = await runSync({ dryRun: true, all: true, types: ['commands'] });
    assert.equal(
      typed.entries.every((row) => row.type === null || row.type === 'commands'),
      true,
      JSON.stringify(typed.entries, null, 2)
    );
    assert.equal(
      typed.entries.some((row) => row.type === 'agents'),
      false
    );

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
    write(path.join(homes.asbHome, 'commands', 'build.md'), 'Build.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["build"]\n'
    );

    for (const [options, suggestion] of [
      [{ dryRun: true, types: ['mcpp'] }, 'mcp'],
      [{ apps: ['claud-code'] }, 'claude-code'],
    ] as const) {
      await assert.rejects(
        () => runSync(options),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.exitCode === 2 &&
          error.message.includes(`did you mean "${suggestion}"`)
      );
    }
  });
});

test('explain completes command and agent slices with source, owner, and all hashes', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const commandSource = write(
      path.join(homes.asbHome, 'commands', 'build.md'),
      '---\ndescription: Build\n---\nBuild it.\n'
    );
    const agentSource = write(
      path.join(homes.asbHome, 'agents', 'reviewer.md'),
      '---\ndescription: Review\n---\nReview it.\n'
    );
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["build"]\n\n[agents]\nenabled = ["reviewer"]\n'
    );
    await runSync();

    for (const [id, source] of [
      ['build', commandSource],
      ['reviewer', agentSource],
    ] as const) {
      const slices = await runExplain(id);
      assert.equal(slices.length, 1, JSON.stringify(slices, null, 2));
      const [slice] = slices;
      assert.equal(slice.provenance, 'written');
      assert.equal(slice.recordedHash, slice.currentHash);
      assert.equal(slice.currentHash, slice.desiredHash);
      assert.equal(slice.desiredHash, hashContent(slice.desired as string));
      assert.deepEqual(slice.sources, [{ id, source: 'library', path: source }]);
    }
  });
});

test('explain covers native manager state and attributes its plugin source without hashes', async () => {
  await withScratchHomes(async (homes) => {
    const source = seedBareCodexPlugin(homes.asbHome);
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["codex"]\nassume_installed = ["codex"]\n\n[applications.codex.native_plugins]\nenabled = ["bare"]\n'
    );

    const slices = await runExplain('demo@bare');
    assert.equal(slices.length, 1, JSON.stringify(slices, null, 2));
    assert.equal(slices[0].app, 'codex');
    assert.equal(slices[0].provenance, 'native-manager');
    assert.equal(slices[0].recordedHash, null);
    assert.equal(slices[0].currentHash, null);
    assert.equal(slices[0].desiredHash, null);
    assert.equal(slices[0].desired, null);
    assert.deepEqual(slices[0].sources, [{ id: 'bare', source: 'bare', path: source }]);
    assert.match(renderExplain(slices, 'demo@bare'), /owner: native-manager/);
  });
});

test('explain keeps MCP credential map keys and masks every value', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
    seedMcpLibrary(homes, {
      alpha: {
        command: 'run',
        env: { API_TOKEN: placeholder },
        headers: { Authorization: placeholder },
        http_headers: { 'X-Api-Key': placeholder },
        env_http_headers: { 'X-Env-Key': placeholder },
      },
    });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );
    await runSync();

    const output = renderExplain(await runExplain('alpha'), 'alpha');

    assert.equal(output.includes(placeholder), false);
    for (const key of ['API_TOKEN', 'Authorization', 'X-Api-Key', 'X-Env-Key']) {
      assert.match(output, new RegExp(key));
    }
    assert.match(output, /\*\*\*/);
  });
});

test('explain masks env values through the kv-array dialect too', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(cocoConfigDir(homes.agentsHome), { recursive: true });
    const placeholder = 'INVENTED-PLACEHOLDER-9f3a';
    seedMcpLibrary(homes, {
      alpha: { command: 'run', env: { API_TOKEN: placeholder } },
    });
    writeUserConfig(homes, '[applications]\nenabled = ["coco"]\n\n[mcp]\nenabled = ["alpha"]\n');
    await runSync();

    const slices = await runExplain('alpha');
    const output = renderExplain(slices, 'alpha');

    assert.equal(output.includes(placeholder), false);
    assert.equal(JSON.stringify(slices).includes(placeholder), false);
    assert.match(output, /API_TOKEN/);
    assert.match(output, /\*\*\*/);
  });
});

test('explain exits 1 for failed slices and no match in text and JSON', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    write(path.join(homes.asbHome, 'commands', 'healthy.md'), 'Healthy.\n');
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["claude-code"]\n\n[commands]\nenabled = ["healthy", "missing"]\n'
    );

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
  });
});
