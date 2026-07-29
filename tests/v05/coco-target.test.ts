import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { APP_ROWS } from '../../src/engine/apps.js';
import { runSync } from '../../src/engine/cli.js';
import type { Component } from '../../src/engine/library.js';
import {
  installApps,
  mcpHostPath,
  readMcpHost,
  seedMcpLibrary,
  seedRule,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

function entry(type: 'commands' | 'agents', metadata: Record<string, unknown>): Component {
  return {
    type,
    id: 'reviewer',
    source: 'library',
    path: `/library/${type}/reviewer.md`,
    content: 'Review.\n',
    metadata: { tags: [], requires: [], ...metadata },
  };
}

test('coco is one builtin data row with the snapshot paths and dialects', async () => {
  await withScratchHomes(async (homes) => {
    const row = APP_ROWS.find((candidate) => candidate.id === 'coco');
    assert.ok(row);
    assert.equal(row.detectDir(homes), path.join(homes.agentsHome, '.config', 'coco'));
    assert.equal(row.mcp?.path(homes), path.join(homes.agentsHome, '.config', 'coco', 'coco.yaml'));
    assert.equal(row.mcp?.structure, 'keyed-array');
    assert.equal(row.mcp?.keyField, 'name');
    assert.equal(row.commands?.dir(homes), path.join(homes.agentsHome, '.coco', 'commands'));
    assert.equal(row.agents?.dir(homes), path.join(homes.agentsHome, '.coco', 'agents'));
    assert.equal(row.skills?.dir(homes), path.join(homes.agentsHome, '.coco', 'skills'));
    assert.equal(row.hooks, undefined);

    assert.match(
      row.commands?.render(
        entry('commands', {
          description: 'Review',
          extras: { coco: { allowed_tools: ['read', 'write'], argument_hint: '<path>' } },
        })
      ) ?? '',
      /allowed-tools: read,write[\s\S]*argument-hint: <path>/
    );
    const agent = row.agents?.render(
      entry('agents', { extras: { coco: { allowed_tools: ['read', 'write'] } } })
    );
    assert.match(agent ?? '', /name: reviewer/);
    assert.match(agent ?? '', /tools: read,write/);
  });
});

test('coco rules resolves one capture-time target and renders for that path', async () => {
  await withScratchHomes(async (homes) => {
    const rules = APP_ROWS.find((candidate) => candidate.id === 'coco')?.rules;
    assert.ok(rules);
    const fallback = path.join(homes.agentsHome, '.coco', 'AGENTS.md');
    const cursor = path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc');

    assert.equal(rules.path(homes), fallback);
    assert.equal(rules.render('Be kind.\n', fallback), 'Be kind.\n');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(cursor, 'existing\n', 'utf-8');
    assert.equal(rules.path(homes), cursor);
    assert.match(rules.render('Be kind.\n', cursor), /alwaysApply: true/);
  });
});

test('coco rules retires the previously recorded fallback when capture moves to cursor', async () => {
  await withScratchHomes(async (homes) => {
    fs.mkdirSync(path.join(homes.agentsHome, '.config', 'coco'), { recursive: true });
    seedRule(homes, 'base.md', 'Be kind.\n');
    writeUserConfig(homes, '[applications]\nenabled = ["coco"]\n\n[rules]\nenabled = ["base"]\n');
    await runSync({});
    const fallback = path.join(homes.agentsHome, '.coco', 'AGENTS.md');
    assert.equal(fs.readFileSync(fallback, 'utf-8'), 'Be kind.\n');

    const cursor = path.join(homes.agentsHome, '.cursor', 'rules', 'asb-rules.mdc');
    fs.mkdirSync(path.dirname(cursor), { recursive: true });
    fs.writeFileSync(
      cursor,
      '---\ndescription: Agent Switchboard Rules\nalwaysApply: true\n---\n\nBe kind.\n',
      'utf-8'
    );
    const report = await runSync({});

    assert.equal(fs.existsSync(fallback), false);
    assert.equal(
      report.entries.some(
        (row) => row.app === 'coco' && row.path === fallback && row.outcome === 'removed'
      ),
      true
    );
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as { entries: { app: string; type: string; path: string }[] };
    assert.deepEqual(
      ledger.entries
        .filter((record) => record.app === 'coco' && record.type === 'rules')
        .map((record) => record.path),
      [cursor]
    );
  });
});

test('coco YAML keyed arrays preserve foreign members and record identity paths', async () => {
  await withScratchHomes(async (homes) => {
    const cocoDir = path.join(homes.agentsHome, '.config', 'coco');
    fs.mkdirSync(cocoDir, { recursive: true });
    const host = path.join(cocoDir, 'coco.yaml');
    fs.writeFileSync(
      host,
      '# coco settings\nmcp_servers:\n  - name: foreign\n    command: theirs\ntheme: "dark" # keep\n',
      'utf-8'
    );
    seedMcpLibrary(homes, {
      alpha: { command: 'npx', env: { TOKEN: 'INVENTED-PLACEHOLDER-9f3a' } },
    });
    writeUserConfig(homes, '[applications]\nenabled = ["coco"]\n\n[mcp]\nenabled = ["alpha"]\n');

    const report = await runSync({});

    assert.equal(report.exitCode, 0);
    const root = parseYaml(fs.readFileSync(host, 'utf-8')) as {
      mcp_servers: Record<string, unknown>[];
      theme: string;
    };
    assert.deepEqual(
      root.mcp_servers.map((server) => server.name),
      ['foreign', 'alpha']
    );
    assert.equal(root.theme, 'dark');
    assert.match(fs.readFileSync(host, 'utf-8'), /# coco settings/);
    assert.match(fs.readFileSync(host, 'utf-8'), /theme: "dark" # keep/);
    const ledger = JSON.parse(
      fs.readFileSync(path.join(homes.stateHome, 'ledger.json'), 'utf-8')
    ) as { entries: { app: string; keys?: string[] }[] };
    assert.deepEqual(ledger.entries.find((record) => record.app === 'coco')?.keys, [
      '@array:mcp_servers[name=alpha]',
    ]);
  });
});

test('coco MCP bootstraps absent and empty YAML hosts', async () => {
  for (const initial of [null, '', '\n', '# keep\ntheme: dark\n'] as const) {
    await withScratchHomes(async (homes) => {
      const cocoDir = path.join(homes.agentsHome, '.config', 'coco');
      fs.mkdirSync(cocoDir, { recursive: true });
      const host = path.join(cocoDir, 'coco.yaml');
      if (initial !== null) fs.writeFileSync(host, initial, 'utf-8');
      seedMcpLibrary(homes, { alpha: { command: 'run' } });
      writeUserConfig(homes, '[applications]\nenabled = ["coco"]\n\n[mcp]\nenabled = ["alpha"]\n');

      const report = await runSync({});

      assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
      const root = parseYaml(fs.readFileSync(host, 'utf-8')) as {
        mcp_servers: Record<string, unknown>[];
        theme?: string;
      };
      assert.equal(root.mcp_servers[0]?.name, 'alpha');
      if (initial?.includes('theme')) assert.equal(root.theme, 'dark');
    });
  }
});

test('a defective coco identity array fails that host while another app proceeds', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'cursor');
    const cocoDir = path.join(homes.agentsHome, '.config', 'coco');
    fs.mkdirSync(cocoDir, { recursive: true });
    const host = path.join(cocoDir, 'coco.yaml');
    const poisoned =
      'mcp_servers:\n  - name: duplicate\n    command: one\n  - name: duplicate\n    command: two\n';
    fs.writeFileSync(host, poisoned, 'utf-8');
    seedMcpLibrary(homes, { alpha: { command: 'npx' } });
    writeUserConfig(
      homes,
      '[applications]\nenabled = ["coco", "cursor"]\n\n[mcp]\nenabled = ["alpha"]\n'
    );

    const report = await runSync({});

    assert.equal(fs.readFileSync(host, 'utf-8'), poisoned);
    const failed = report.entries.find((row) => row.app === 'coco' && row.type === 'mcp');
    assert.equal(failed?.outcome, 'failed');
    assert.equal(failed?.detail, 'parse-error');
    assert.match(failed?.reason ?? '', /duplicate identity "duplicate"/);
    assert.ok(readMcpHost(homes, 'cursor')?.alpha);
    assert.equal(fs.existsSync(mcpHostPath(homes, 'cursor')), true);
  });
});
