import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { importCommandFromFile } from '../src/commands/importer.js';
import { parseLibraryMarkdown } from '../src/library/parser.js';
import { withTempDir } from './helpers/tmp.js';

test('importCommandFromFile strips existing frontmatter and preserves platform keys verbatim (claude-code)', () => {
  withTempDir((tmp) => {
    const src = path.join(tmp, 'Explain.md');
    const source =
      `---\n` +
      `title: Explain\n` +
      `description: Say what the code does\n` +
      `model: my-model\n` +
      `tools: [code_browser]\n` +
      `color: blue\n` +
      `---\n\n` +
      `Please explain.`;
    fs.writeFileSync(src, source);

    const result = importCommandFromFile('claude-code', src);

    // One frontmatter only
    const count = (result.content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/gm) || []).length;
    assert.equal(count, 1);

    const parsed = parseLibraryMarkdown(result.content);
    assert.equal(parsed.metadata.description, 'Say what the code does');
    const extras = parsed.metadata.extras as Record<string, unknown>;
    const cc = extras['claude-code'] as Record<string, unknown>;
    // Keys are preserved as-is
    assert.equal(cc.model, 'my-model');
    assert.deepEqual(cc.tools, ['code_browser']);
    assert.equal(cc.color, 'blue');
    assert.equal(parsed.content, 'Please explain.');

    assert.equal(result.slug, 'explain');
  });
});
