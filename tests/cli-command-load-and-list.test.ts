import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { parseLibraryMarkdown } from '../src/library/parser.js';
import { runCli, stripAnsi } from './helpers/cli.js';
import { withTempHomes } from './helpers/tmp.js';

test('CLI: command load (claude-code) imports with minimal schema (description + extras passthrough)', () => {
  withTempHomes(({ agentsHome, asbHome }) => {
    const srcDir = path.join(agentsHome, '.claude', 'commands');
    fs.mkdirSync(srcDir, { recursive: true });

    // Alpha: has frontmatter + tools + explicit model
    const alpha = path.join(srcDir, 'Alpha.md');
    fs.writeFileSync(
      alpha,
      `---\n` +
        `title: Alpha\n` +
        `description: Alpha desc\n` +
        `model: my-alpha\n` +
        `tools: [code_browser]\n` +
        `---\n\n` +
        `Do alpha.\n`
    );

    // Beta: plain body only
    const beta = path.join(srcDir, 'Beta.md');
    fs.writeFileSync(beta, 'Explain beta.');

    // load by default directory
    const { stdout } = runCli(['command', 'load', 'claude-code', '-r']);
    assert.match(stripAnsi(stdout), /Imported 2 file\(s\) into command library\./);

    // Validate alpha in library
    const libAlpha = path.join(asbHome, 'commands', 'alpha.md');
    assert.equal(fs.existsSync(libAlpha), true);
    const pa = parseLibraryMarkdown(fs.readFileSync(libAlpha, 'utf-8'));
    // Minimal schema: no required top-level title/model
    const ccA = ((pa.metadata.extras as Record<string, unknown>)['claude-code'] ?? {}) as Record<
      string,
      unknown
    >;
    assert.equal(ccA.model, 'my-alpha');
    // tools are preserved as-is (no renaming to allowed-tools)
    assert.deepEqual(ccA.tools, ['code_browser']);
    // Single frontmatter
    const aTxt = fs.readFileSync(libAlpha, 'utf-8');
    const aCount = (aTxt.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/gm) || []).length;
    assert.equal(aCount, 1);

    // Validate beta in library
    const libBeta = path.join(asbHome, 'commands', 'beta.md');
    assert.equal(fs.existsSync(libBeta), true);
    const pb = parseLibraryMarkdown(fs.readFileSync(libBeta, 'utf-8'));
    const ccB = ((pb.metadata.extras as Record<string, unknown>)['claude-code'] ?? {}) as Record<
      string,
      unknown
    >;
    // No defaults injected; absent fields remain absent
    assert.equal(ccB.model, undefined);
    assert.equal(ccB.tools, undefined);
    // Single frontmatter
    const bTxt = fs.readFileSync(libBeta, 'utf-8');
    const bCount = (bTxt.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/gm) || []).length;
    assert.equal(bCount, 1);
  });
});
