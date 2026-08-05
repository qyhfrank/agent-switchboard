import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { editSelection, loadConfig } from '../src/engine/config.js';
import { scanLibrary } from '../src/engine/library.js';
import { type ComposableRule, composeRules } from '../src/engine/shapes.js';
import { seedRule, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

function rule(id: string, content: string, title?: string): ComposableRule {
  return { id, content, metadata: { title } };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

test('a library rule parses its frontmatter and body under either markdown extension', async () => {
  await withScratchHomes(async (homes) => {
    seedRule(
      homes,
      'alpha.md',
      '---\ntitle: Alpha Rule\ndescription: Test snippet\n---\nAlways lint before committing.\n'
    );
    seedRule(homes, 'beta.markdown', 'Content without frontmatter.');

    const inventory = scanLibrary();
    const rules = inventory.components.filter((component) => component.type === 'rules');

    assert.deepEqual(inventory.failed, []);
    assert.deepEqual(
      rules.map((component) => component.id),
      ['alpha', 'beta'],
      'the id is the filename without its extension'
    );
    assert.equal(rules[0].metadata.title, 'Alpha Rule');
    assert.equal(rules[0].metadata.description, 'Test snippet');
    assert.equal(rules[0].content, 'Always lint before committing.\n', 'frontmatter is not body');
    assert.equal(rules[1].content, 'Content without frontmatter.');
  });
});

test('composing rules normalizes line endings, joins sections, and hashes the result', () => {
  const composed = composeRules([
    rule('alpha', 'Line 1\r\nLine 2\r\n\r\n', 'Alpha'),
    rule('beta', 'Beta body\n'),
  ]);
  const expected = ['Line 1', 'Line 2', '', 'Beta body', ''].join('\n');

  assert.equal(composed.content, expected);
  assert.equal(composed.hash, sha256(expected));
  assert.deepEqual(
    composed.sections.map((section) => ({ id: section.id, content: section.content })),
    [
      { id: 'alpha', content: 'Line 1\nLine 2\n' },
      { id: 'beta', content: 'Beta body\n' },
    ]
  );

  const nothing = composeRules([]);
  assert.equal(nothing.content, '');
  assert.equal(nothing.hash, sha256(''));
  assert.deepEqual(nothing.sections, []);

  const delimited = composeRules([rule('alpha', 'Alpha body\n')], { includeDelimiters: true });
  assert.equal(
    delimited.content,
    ['<!-- alpha:start -->', 'Alpha body', '<!-- alpha:end -->', ''].join('\n')
  );
});

test('composing rules follows the caller order instead of sorting ids', () => {
  const composed = composeRules([rule('beta', 'Beta body\n'), rule('alpha', 'Alpha body\n')]);

  assert.equal(composed.content, ['Beta body', '', 'Alpha body', ''].join('\n'));
  assert.deepEqual(
    composed.sections.map((section) => section.id),
    ['beta', 'alpha']
  );
});

test('the id reserved for the outer region is refused on both the load and the edit path', async () => {
  await withScratchHomes(async (homes) => {
    for (const toml of [
      '[rules]\nenabled = ["rules"]\n',
      '[applications.claude-code.rules]\nenabled = ["rules"]\n',
      '[applications.claude-code.rules]\nadd = ["rules"]\n',
    ]) {
      writeUserConfig(homes, toml);
      assert.throws(
        () => loadConfig(),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return message.includes('rules') && message.includes('marker');
        },
        toml
      );
    }

    // The rejection is the bare id, not every id that ends in it.
    writeUserConfig(homes, '[rules]\nenabled = ["team:rules"]\n');
    assert.deepEqual(loadConfig().selection.rules, ['team:rules']);

    const configPath = path.join(homes.asbHome, 'config.toml');
    const before = fs.readFileSync(configPath, 'utf-8');
    assert.throws(() => editSelection({ type: 'rules', enable: ['rules'] }), /cannot be a rule id/);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before, 'a refused edit writes nothing');
  });
});
