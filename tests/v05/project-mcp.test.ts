import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../../src/engine/cli.js';
import {
  installApps,
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
    // A project run derives what it owns from the render, so it writes no
    // machine state at all.
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'ledger.json')), false);
    assert.equal(fs.existsSync(path.join(homes.stateHome, 'last-run.json')), false);
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
