import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import {
  inCwd,
  installApps,
  type McpAppId,
  mcpHostPath,
  readMcpHost,
  seedMcpLibrary,
  seedTree,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * A repository carries only what it adds. The user level is visible to every
 * app in every directory, so a server both levels select is the user's alone;
 * the increment is what the overlay selects and the base file does not.
 */

function projectConfig(project: string, body: string): void {
  fs.writeFileSync(path.join(project, '.asb.toml'), body);
}

function projectMcp(project: string, ids: string[], distribution = ''): void {
  const list = ids.map((id) => `"${id}"`).join(', ');
  projectConfig(project, `${distribution}[mcp]\nenabled = [${list}]\n`);
}

/** Project-scope MCP host per app (the ratified project cells of the table). */
function projectHostPath(project: string, app: McpAppId): string {
  switch (app) {
    case 'claude-code':
      return path.join(project, '.mcp.json');
    case 'codex':
      return path.join(project, '.codex', 'config.toml');
    default:
      return path.join(project, `.${app}`, 'mcp.json');
  }
}

function projectServers(project: string, app: McpAppId): Record<string, unknown> | undefined {
  const host = projectHostPath(project, app);
  if (!fs.existsSync(host)) return undefined;
  return (JSON.parse(fs.readFileSync(host, 'utf-8')) as { mcpServers?: Record<string, unknown> })
    .mcpServers;
}

test('a server the user level already carries never reaches the repository', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectMcp(project, ['alpha', 'beta']);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['alpha']);
    assert.deepEqual(Object.keys(projectServers(project, 'cursor') ?? {}), ['beta']);
    // Each row names the phase that wrote it.
    assert.equal(
      report.entries.find((entry) => entry.path === mcpHostPath(homes, 'cursor'))?.scope,
      'user'
    );
    assert.equal(
      report.entries.find((entry) => entry.path === projectHostPath(project, 'cursor'))?.scope,
      'project'
    );
  });
});

test('an app only the project enables contributes its whole selection to the repository', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor', 'claude-code');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(
      project,
      '[applications]\nenabled = ["cursor", "claude-code"]\n\n[mcp]\nenabled = ["alpha", "beta"]\n'
    );

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    // The increment is per app: claude-code contributes an empty base side, so
    // everything the overlay selects for it is an addition.
    assert.deepEqual(Object.keys(projectServers(project, 'claude-code') ?? {}).sort(), [
      'alpha',
      'beta',
    ]);
    assert.deepEqual(Object.keys(projectServers(project, 'cursor') ?? {}), ['beta']);
    assert.equal(
      fs.existsSync(mcpHostPath(homes, 'claude-code')),
      false,
      'the user phase never learns of an app only the project layer enables'
    );
  });
});

test('a user-level server a repository still carries is removed where the render proves it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    // The repository as an earlier full-render run left it: asb's own render of
    // a server, beside a server that is not asb's.
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectMcp(project, ['alpha']);
    await runSync({ project });
    const host = projectHostPath(project, 'cursor');
    const seeded = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    seeded.mcpServers.foreign = { command: 'mine' };
    fs.writeFileSync(host, `${JSON.stringify(seeded, null, 2)}\n`);

    // The same server at user level: the increment empties, and the copy the
    // repository still holds is a duplicate of content every directory sees.
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(Object.keys(projectServers(project, 'cursor') ?? {}), ['foreign']);
    assert.deepEqual(Object.keys(readMcpHost(homes, 'cursor') ?? {}), ['alpha']);
  });
});

test('the project phase splices trust into the config the user phase just wrote', async () => {
  await withScratchHomes(async (homes) => {
    // A root spelled with dots is one key the projects header has to quote.
    const project = path.join(homes.root, 'project.with.dots');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectMcp(project, ['alpha', 'beta']);
    const globalConfig = mcpHostPath(homes, 'codex');
    fs.writeFileSync(globalConfig, 'model = "gpt-test"\n');

    const report = await runSync({ project });
    const bytes = fs.readFileSync(globalConfig, 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    // Both phases edit this one document. The second captures after the first
    // applied, so the trust key joins the user phase's servers instead of
    // being spliced into bytes that no longer exist.
    assert.match(bytes, /model = "gpt-test"/);
    assert.match(bytes, /\[mcp_servers\.alpha\]/);
    assert.match(bytes, /\[projects\."[^"]*project\.with\.dots"\]/);
    assert.match(bytes, /trust_level = "trusted"/);
    assert.match(
      fs.readFileSync(projectHostPath(project, 'codex'), 'utf-8'),
      /\[mcp_servers\.beta\]/
    );
    assert.equal(bytes.includes('beta'), false, 'the increment is the repository’s alone');

    const second = await runSync({ project });
    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), bytes, 'a second run changes no byte');
  });
});

test('an empty MCP increment leaves the repository no host and the machine no trust key', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    seedTree(homes.asbHome, {
      'hooks/notify.json': `${JSON.stringify({
        name: 'notify',
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo notify' }] }] },
      })}\n`,
    });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, '[mcp]\nenabled = ["alpha"]\n\n[hooks]\nenabled = ["notify"]\n');

    const report = await runSync({ project });
    const globalConfig = mcpHostPath(homes, 'codex');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(fs.readFileSync(globalConfig, 'utf-8'), /\[mcp_servers\.alpha\]/);
    assert.equal(fs.existsSync(projectHostPath(project, 'codex')), false);
    // Trust follows the servers the repository actually receives, so an empty
    // increment writes nothing outside the repository even under explicit -P,
    // and a repository carrying hooks alone asks for no trust either.
    assert.equal(fs.existsSync(path.join(project, '.codex', 'hooks.json')), true);
    assert.equal(fs.readFileSync(globalConfig, 'utf-8').includes('[projects.'), false);
  });
});

test('managed project MCP owns its sanitized key and leaves foreign servers alone', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, {
      'managed.server': {
        command: 'managed',
        env: { TOKEN_NAME: 'INVENTED-PLACEHOLDER-9f3a' },
      },
    });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectMcp(project, ['managed.server']);
    const host = projectHostPath(project, 'cursor');
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(host, '{\n  "mcpServers": {\n    "foreign": { "command": "mine" }\n  }\n}\n');

    const report = await runSync({ project });
    const parsed = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['foreign', 'managed-server']);
    assert.equal(parsed.mcpServers['managed-server']?.env?.TOKEN_NAME, 'INVENTED-PLACEHOLDER-9f3a');

    // Deselected, the key still holds the render, so it goes and the foreign
    // sibling stays.
    projectMcp(project, []);
    const removed = await runSync({ project });

    assert.equal(removed.exitCode, 0, JSON.stringify(removed.entries, null, 2));
    assert.deepEqual(Object.keys(projectServers(project, 'cursor') ?? {}), ['foreign']);
  });
});

test('custom keyed-array project MCP keeps @array grammar out of the host document', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(
      homes,
      [
        '[applications]',
        'enabled = ["custom"]',
        'assume_installed = ["custom"]',
        '',
        '[targets.custom.mcp]',
        'format = "yaml"',
        'config_path = "~/global.yaml"',
        'project_config_path = ".custom/mcp.yaml"',
        'root_key = "servers"',
        'structure = "keyed-array"',
        'key_field = "name"',
        '',
      ].join('\n')
    );
    projectMcp(project, ['alpha']);

    const report = await runSync({ project });
    const hostText = fs.readFileSync(path.join(project, '.custom', 'mcp.yaml'), 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    // `@array:name[...]` is the key path planning addresses an array element
    // with; the document keeps the plain keyed-array shape the app reads.
    assert.equal(hostText.includes('@array:'), false);
    assert.match(hostText, /name: alpha/);
    // The project phase derives what it owns from the render and writes nothing
    // machine-local; the user phase every run carries stamps the one marker.
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'ledger.json')), false);
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'last-run.json')), true);
  });
});

test('Codex project trust refuses a global config it cannot claim and rewrites no byte', async () => {
  for (const [detail, before] of [
    ['foreign', 'trust_level = "untrusted"'],
    ['parse-error', null],
  ] as const) {
    await withScratchHomes(async (homes) => {
      const project = path.join(homes.root, 'project');
      fs.mkdirSync(project);
      installApps(homes, 'codex');
      seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
      writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
      projectMcp(project, ['alpha']);
      const globalConfig = mcpHostPath(homes, 'codex');
      // Either asb's own decision is already made the other way, or the
      // document cannot be read at all.
      const bytes =
        before === null ? '[projects."broken"\n' : `[projects."${project}"]\n${before}\n`;
      fs.writeFileSync(globalConfig, bytes);

      const report = await runSync({ project });
      const row = report.entries.find((entry) => entry.path === globalConfig);

      assert.equal(report.exitCode, 1, detail);
      assert.equal(fs.readFileSync(globalConfig, 'utf-8'), bytes, detail);
      assert.equal(row?.detail, detail, JSON.stringify(report.entries, null, 2));
      if (before !== null) assert.match(row?.reason ?? '', /untrusted/i);
    });
  }
});

test('a Codex trust refusal does not cancel the project writes under collision error', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectMcp(project, ['alpha'], '[distribution.project]\ncollision = "error"\n\n');
    const globalConfig = mcpHostPath(homes, 'codex');
    const before = `[projects."${project}"]\ntrust_level = "untrusted"\n`;
    fs.writeFileSync(globalConfig, before);

    const report = await runSync({ project });
    const projectHost = projectHostPath(project, 'codex');

    // Both rows carry detail `foreign`, so a preflight filtering on that alone
    // would cancel project writes the refusal has nothing to do with.
    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), before);
    assert.match(fs.readFileSync(projectHost, 'utf-8'), /alpha/);
    assert.equal(report.entries.find((entry) => entry.path === projectHost)?.detail, 'created');
    assert.equal(report.entries.find((entry) => entry.path === globalConfig)?.detail, 'foreign');
  });
});

test('an ambient run reaches project MCP without touching the machine Codex trust', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'repo');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectMcp(project, ['alpha']);
    const globalConfig = mcpHostPath(homes, 'codex');

    await inCwd(project, async () => {
      const report = await runSync();

      // Trust is a write outside the repository, so only a run that named the
      // root asks for it: syncing inside a clone creates no side effect there.
      // The write that did not happen is still a fact of the run, so one row
      // stands where it would have been and names the flag that asks for it.
      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      assert.match(fs.readFileSync(projectHostPath(project, 'codex'), 'utf-8'), /alpha/);
      assert.equal(fs.existsSync(globalConfig), false);
      const suppressed = report.entries.filter((entry) => entry.path === globalConfig);
      assert.equal(suppressed.length, 1, JSON.stringify(report.entries, null, 2));
      assert.equal(suppressed[0]?.outcome, 'skipped');
      assert.equal(suppressed[0]?.detail, 'ambient-project');
      assert.equal(suppressed[0]?.scope, 'project');
      assert.ok(suppressed[0]?.reason?.includes(`-P ${project}`), suppressed[0]?.reason);
    });

    const named = await runSync({ project });

    assert.equal(named.exitCode, 0, JSON.stringify(named.entries, null, 2));
    assert.match(fs.readFileSync(globalConfig, 'utf-8'), /trust_level = "trusted"/);
  });
});

test('exclusive project MCP removes every server but keeps unrelated host keys', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectMcp(project, ['alpha']);
    const host = projectHostPath(project, 'cursor');
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(
      host,
      '{\n  "theme": "dark",\n  "mcpServers": {\n    "foreign": { "command": "mine" }\n  }\n}\n'
    );
    await runSync({ project });
    projectMcp(project, [], '[distribution.project]\nmode = "exclusive"\n\n');

    const report = await runSync({ project });
    const after = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      theme: string;
      mcpServers: Record<string, unknown>;
    };

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.mcpServers, {});
  });
});

test('a key two Trae apps share outlives the first of them and goes with the last', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'trae', 'trae-cn');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["trae", "trae-cn"]\n');
    projectMcp(project, ['alpha']);
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));

    writeUserConfig(homes, '[applications]\nenabled = ["trae"]\n');
    const second = await runSync({ project });

    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.ok(
      projectServers(project, 'trae')?.alpha,
      'trae still wants the key trae-cn shares with it'
    );

    writeUserConfig(homes, '[applications]\nenabled = []\n');
    const third = await runSync({ project });

    assert.equal(third.exitCode, 0, JSON.stringify(third.entries, null, 2));
    assert.deepEqual(projectServers(project, 'trae'), {});
  });
});
