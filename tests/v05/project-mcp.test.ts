import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import {
  installApps,
  type McpAppId,
  mcpHostPath,
  readMcpHost,
  seedMcpLibrary,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function projectConfig(project: string, mcp: string[]): void {
  fs.writeFileSync(
    path.join(project, '.asb.toml'),
    `[mcp]\nenabled = [${mcp.map((id) => `"${id}"`).join(', ')}]\n`
  );
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

/**
 * A repository carries only what it adds. The user level is visible to every
 * app in every directory, so a server both levels select is the user's alone;
 * the increment is what the overlay selects and the base file does not.
 */
test('a server the user level already carries never reaches the repository', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, ['alpha', 'beta']);

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
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
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
    projectConfig(project, ['alpha']);
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
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' }, beta: { command: 'beta' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, ['alpha', 'beta']);

    const report = await runSync({ project });
    const globalConfig = fs.readFileSync(mcpHostPath(homes, 'codex'), 'utf-8');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    // Both phases edit this one document. The second captures after the first
    // applied, so the trust key joins the user phase's servers instead of
    // being spliced into bytes that no longer exist.
    assert.match(globalConfig, /\[mcp_servers\.alpha\]/);
    assert.match(globalConfig, /\[projects\."[^"]*project"\]/);
    assert.match(globalConfig, /trust_level = "trusted"/);
    assert.match(
      fs.readFileSync(projectHostPath(project, 'codex'), 'utf-8'),
      /\[mcp_servers\.beta\]/
    );
    assert.equal(globalConfig.includes('beta'), false, 'the increment is the repository’s alone');
  });
});

test('an empty MCP increment leaves the repository no host and the machine no trust key', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n\n[mcp]\nenabled = ["alpha"]\n');
    projectConfig(project, ['alpha']);

    const report = await runSync({ project });
    const globalConfig = mcpHostPath(homes, 'codex');

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.match(fs.readFileSync(globalConfig, 'utf-8'), /\[mcp_servers\.alpha\]/);
    assert.equal(fs.existsSync(projectHostPath(project, 'codex')), false);
    // Trust follows the servers the repository actually receives, so an empty
    // increment writes nothing outside the repository even under explicit -P.
    assert.equal(fs.readFileSync(globalConfig, 'utf-8').includes('[projects.'), false);
  });
});

test('managed project MCP preserves foreign servers and sanitizes the managed key', async () => {
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
    projectConfig(project, ['managed.server']);
    const host = path.join(project, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(host, '{\n  "mcpServers": {\n    "foreign": { "command": "mine" }\n  }\n}\n');

    const report = await runSync({ project });
    const parsed = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ['foreign', 'managed-server']);
    assert.equal(parsed.mcpServers['managed-server']?.env?.TOKEN_NAME, 'INVENTED-PLACEHOLDER-9f3a');
  });
});

test('managed project MCP removes a clean disabled key and preserves foreign siblings', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, ['alpha']);
    await runSync({ project });
    const host = path.join(project, '.cursor', 'mcp.json');
    const document = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    document.mcpServers.foreign = { command: 'mine' };
    fs.writeFileSync(host, `${JSON.stringify(document, null, 2)}\n`);
    projectConfig(project, []);

    const report = await runSync({ project });
    const after = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    assert.deepEqual(Object.keys(after.mcpServers), ['foreign']);
  });
});

test('a deselected project key running a different command is kept and not spoken of', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, ['alpha']);
    await runSync({ project });
    const host = path.join(project, '.cursor', 'mcp.json');
    const document = JSON.parse(fs.readFileSync(host, 'utf-8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    document.mcpServers.alpha.command = 'user-edited';
    fs.writeFileSync(host, `${JSON.stringify(document, null, 2)}\n`);
    projectConfig(project, []);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 0, 'preserving a customized server is not a failure');
    assert.equal(
      (JSON.parse(fs.readFileSync(host, 'utf-8')) as { mcpServers: { alpha: { command: string } } })
        .mcpServers.alpha.command,
      'user-edited'
    );
    // The value is the whole proof, and `user-edited` is a different server
    // wearing a library name: asb keeps it and says nothing about it.
    assert.deepEqual(
      report.entries.filter((entry) => entry.type === 'mcp'),
      [],
      JSON.stringify(report.entries, null, 2)
    );
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
    projectConfig(project, ['alpha']);

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

test('Codex project MCP adds one quoted-root trust key and is byte-idempotent', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project.with.dots');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, ['alpha']);
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');
    fs.writeFileSync(globalConfig, 'model = "gpt-test"\n');

    const first = await runSync({ project });
    const bytes = fs.readFileSync(globalConfig, 'utf-8');
    const second = await runSync({ project });

    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));
    assert.match(bytes, /model = "gpt-test"/);
    assert.match(bytes, /\[projects\."[^"]*project\.with\.dots"\]/);
    assert.match(bytes, /trust_level = "trusted"/);
    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), bytes);
  });
});

test('Codex project trust refuses an existing untrusted value without rewriting it', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, ['alpha']);
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');
    const before = `[projects."${project}"]\ntrust_level = "untrusted"\n`;
    fs.writeFileSync(globalConfig, before);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), before);
    assert.match(
      report.entries.find((entry) => entry.path === globalConfig)?.reason ?? '',
      /untrusted/i
    );
  });
});

test('Codex trust refusal is not a collision=error input', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\ncollision = "error"\n\n[mcp]\nenabled = ["alpha"]\n'
    );
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');
    const before = `[projects."${project}"]\ntrust_level = "untrusted"\n`;
    fs.writeFileSync(globalConfig, before);

    const report = await runSync({ project });
    const projectHost = path.join(project, '.codex', 'config.toml');

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), before);
    assert.equal(fs.existsSync(projectHost), true);
    assert.match(fs.readFileSync(projectHost, 'utf-8'), /alpha/);
    assert.equal(report.entries.find((entry) => entry.path === projectHost)?.detail, 'created');
    assert.equal(report.entries.find((entry) => entry.path === globalConfig)?.detail, 'foreign');
  });
});

test('Codex project trust preserves malformed global TOML and reports the refusal', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'codex');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["codex"]\n');
    projectConfig(project, ['alpha']);
    const globalConfig = path.join(homes.agentsHome, '.codex', 'config.toml');
    const before = '[projects."broken"\n';
    fs.writeFileSync(globalConfig, before);

    const report = await runSync({ project });

    assert.equal(report.exitCode, 1);
    assert.equal(fs.readFileSync(globalConfig, 'utf-8'), before);
    assert.equal(
      report.entries.find((entry) => entry.path === globalConfig)?.detail,
      'parse-error'
    );
  });
});

test('exclusive project MCP removes every server but keeps unrelated host keys', async () => {
  await withScratchHomes(async (homes) => {
    const project = path.join(homes.root, 'project');
    fs.mkdirSync(project);
    installApps(homes, 'cursor');
    seedMcpLibrary(homes, { alpha: { command: 'alpha' } });
    writeUserConfig(homes, '[applications]\nenabled = ["cursor"]\n');
    projectConfig(project, ['alpha']);
    const host = path.join(project, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(
      host,
      '{\n  "theme": "dark",\n  "mcpServers": {\n    "foreign": { "command": "mine" }\n  }\n}\n'
    );
    await runSync({ project });
    fs.writeFileSync(
      path.join(project, '.asb.toml'),
      '[distribution.project]\nmode = "exclusive"\n\n[mcp]\nenabled = []\n'
    );

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
    projectConfig(project, ['alpha']);
    const first = await runSync({ project });
    assert.equal(first.exitCode, 0, JSON.stringify(first.entries, null, 2));

    writeUserConfig(homes, '[applications]\nenabled = ["trae"]\n');
    const second = await runSync({ project });
    const shared = path.join(project, '.trae', 'mcp.json');
    assert.equal(second.exitCode, 0, JSON.stringify(second.entries, null, 2));
    assert.ok(
      (JSON.parse(fs.readFileSync(shared, 'utf-8')) as { mcpServers: Record<string, unknown> })
        .mcpServers.alpha,
      'trae still wants the key trae-cn shares with it'
    );

    writeUserConfig(homes, '[applications]\nenabled = []\n');
    const third = await runSync({ project });
    const host = path.join(project, '.trae', 'mcp.json');
    const root = JSON.parse(fs.readFileSync(host, 'utf-8')) as { mcpServers: unknown };
    assert.equal(third.exitCode, 0, JSON.stringify(third.entries, null, 2));
    assert.deepEqual(root.mcpServers, {});
  });
});
