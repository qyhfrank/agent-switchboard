import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseLibraryMarkdown } from '../src/library/parser.js';
import { runCli, stripAnsi } from './helpers/cli.js';
import { withTempHomes } from './helpers/tmp.js';

test('CLI: command load (claude-code) imports files and list shows guidance (minimal schema)', () => {
  withTempHomes(({ agentsHome, asbHome }) => {
    const ccDir = path.join(agentsHome, '.claude', 'commands');
    fs.mkdirSync(ccDir, { recursive: true });
    const src = path.join(ccDir, 'foo.md');
    fs.writeFileSync(
      src,
      `---\n` +
        `title: Foo Command\n` +
        `description: Demo\n` +
        `model: my-model\n` +
        `tools: [code_browser]\n` +
        `color: blue\n` +
        `---\n\n` +
        `Body.\n`
    );

    // load by default directory
    const { stdout: out1 } = runCli(['command', 'load', 'claude-code', '-r']);
    assert.match(stripAnsi(out1), /Imported 1 file\(s\) into command library\./);

    const libFile = path.join(asbHome, 'commands', 'foo.md');
    assert.equal(fs.existsSync(libFile), true);
    const parsed = parseLibraryMarkdown(fs.readFileSync(libFile, 'utf-8'));
    // minimal schema: no top-level title; tools remain under extras as-is
    const extras = parsed.metadata.extras as Record<string, unknown> | undefined;
    assert.ok(extras && typeof extras === 'object');
    const cc = extras['claude-code'] as Record<string, unknown>;
    const tools = cc.tools as unknown;
    assert.ok(Array.isArray(tools));
    assert.deepEqual(tools, ['code_browser']);
    assert.equal(cc.color as unknown as string, 'blue');

    const { stdout: out2 } = runCli(['command', 'list']);
    const s = stripAnsi(out2);
    assert.match(s, /Unsupported platforms \(manual steps required\): Claude Desktop/);
  });
});

test('CLI: subagent load (claude-code) imports files and list shows guidance (minimal schema)', () => {
  withTempHomes(({ agentsHome, asbHome }) => {
    const agentsDir = path.join(agentsHome, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const src = path.join(agentsDir, 'critic.md');
    fs.writeFileSync(
      src,
      `---\n` +
        `name: Strict Reviewer\n` +
        `description: Review before merge\n` +
        `model: claude-3-5-sonnet\n` +
        `tools: [code_browser, unit_tests]\n` +
        `arguments: { tone: strict }\n` +
        `---\n\n` +
        `Body.\n`
    );

    const { stdout: out1 } = runCli(['subagent', 'load', 'claude-code', '-r']);
    assert.match(stripAnsi(out1), /Imported 1 file\(s\) into subagent library\./);

    const libFile = path.join(asbHome, 'subagents', 'critic.md');
    assert.equal(fs.existsSync(libFile), true);
    const parsed = parseLibraryMarkdown(fs.readFileSync(libFile, 'utf-8'));
    // minimal schema: no top-level title required
    const extras = parsed.metadata.extras as Record<string, unknown> | undefined;
    assert.ok(extras && typeof extras === 'object');
    const cc = extras['claude-code'] as Record<string, unknown>;
    const tools = cc.tools as unknown;
    assert.ok(Array.isArray(tools));
    assert.deepEqual(tools, ['code_browser', 'unit_tests']);
    // Only one frontmatter block persisted
    const content = fs.readFileSync(libFile, 'utf-8');
    const count = (content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/gm) || []).length;
    assert.equal(count, 1);

    const { stdout: out2 } = runCli(['subagent', 'list']);
    const s = stripAnsi(out2);
    assert.match(s, /Unsupported platforms \(manual steps required\): Codex, Gemini/);
  });
});
