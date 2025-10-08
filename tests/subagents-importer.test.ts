import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseLibraryMarkdown } from '../src/library/parser.js';
import { importSubagentFromFile } from '../src/subagents/importer.js';
import { withTempDir } from './helpers/tmp.js';

test('importSubagentFromFile strips existing frontmatter and preserves fields under extras (claude-code)', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'Task Checker.md');
    const source =
      `\uFEFF---\r\nname: task-checker\r\n` +
      `description: Use this agent to verify...\r\n` +
      `model: sonnet\r\n` +
      `color: yellow\r\n` +
      `---\r\n\r\n` +
      `You are a QA specialist.`;
    fs.writeFileSync(src, source);

    const result = importSubagentFromFile('claude-code', src);

    // Should produce only one frontmatter block
    const count = (result.content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/gm) || []).length;
    assert.equal(count, 1, 'should have exactly one YAML frontmatter');

    const parsed = parseLibraryMarkdown(result.content);
    assert.equal(parsed.metadata.description, 'Use this agent to verify...');
    const extrasModel = ((parsed.metadata.extras as Record<string, unknown>)['claude-code'] ??
      {}) as Record<string, unknown>;
    assert.equal(extrasModel.model as unknown as string, 'sonnet');
    assert.ok(parsed.metadata.extras && typeof parsed.metadata.extras === 'object');
    const cc = (parsed.metadata.extras as Record<string, unknown>)['claude-code'] as Record<
      string,
      unknown
    >;
    assert.ok(cc && typeof cc === 'object', 'extras.claude-code exists');
    // no tools in source → do not inject empty tools array
    assert.equal((cc as Record<string, unknown>).tools, undefined);
    assert.equal(cc.color, 'yellow');
    assert.equal(parsed.content, 'You are a QA specialist.');

    // Slug should derive from filename
    assert.equal(result.slug, 'task-checker');
  });
});
