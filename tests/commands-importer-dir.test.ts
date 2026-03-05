import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { importCommandFromFile } from '../src/commands/importer.js';
import { parseLibraryMarkdown } from '../src/library/parser.js';
import { withTempDir } from './helpers/tmp.js';

test('directory-like import: multiple files with frontmatter variants', () => {
  withTempDir((tmp) => {
    const a = path.join(tmp, 'Alpha.md');
    const b = path.join(tmp, 'Beta.md');

    // Alpha: with frontmatter + tools + color; CRLF endings
    const alpha =
      `---\r\n` +
      `title: Alpha\r\n` +
      `description: Alpha desc\r\n` +
      `model: my-alpha\r\n` +
      `tools: [tool_a]\r\n` +
      `color: red\r\n` +
      `---\r\n\r\n` +
      `Do alpha.`;
    fs.writeFileSync(a, alpha);

    // Beta: plain body only
    fs.writeFileSync(b, 'Explain beta.');

    const ra = importCommandFromFile('claude-code', a);
    const rb = importCommandFromFile('claude-code', b);

    // Alpha expectations
    const pa = parseLibraryMarkdown(ra.content);
    assert.equal(pa.metadata.description, 'Alpha desc');
    const ea = (pa.metadata.extras as Record<string, unknown>)['claude-code'] as Record<
      string,
      unknown
    >;
    assert.ok(ea && typeof ea === 'object');
    assert.equal(ea.model, 'my-alpha');
    assert.deepEqual(ea.tools, ['tool_a']);
    assert.equal(ea.color, 'red');
    assert.equal(pa.content, 'Do alpha.');

    // Beta expectations
    const pb = parseLibraryMarkdown(rb.content);
    assert.equal(pb.metadata.description, '');
    const eb = (pb.metadata.extras as Record<string, unknown>)['claude-code'] as
      | Record<string, unknown>
      | undefined;
    assert.ok(eb && typeof eb === 'object');
    // plain body only → no defaults injected
    assert.equal(eb.tools, undefined);
    assert.equal(eb.model, undefined);
    assert.equal(pb.content, 'Explain beta.');
  });
});
