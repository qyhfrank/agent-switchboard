import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../src/engine/config.js';
import { composeRules } from '../../src/engine/shapes.js';
import { seedRule, withScratchHomes, writeUserConfig } from './helpers/scratch.js';

interface ComposableRule {
  id: string;
  content: string;
  metadata: { title?: string; description?: string; tags: string[]; requires: string[] };
}

function rule(id: string, content: string, title?: string): ComposableRule {
  return { id, content, metadata: { title, description: undefined, tags: [], requires: [] } };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

test('composeRules normalizes line endings, joins sections, and hashes the result', () => {
  const result = composeRules([
    rule('alpha', 'Line 1\r\nLine 2\r\n\r\n', 'Alpha'),
    rule('beta', 'Beta body\n'),
  ]);

  const expected = ['Line 1', 'Line 2', '', 'Beta body', ''].join('\n');

  assert.equal(result.content, expected);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].id, 'alpha');
  assert.equal(result.sections[0].content, 'Line 1\nLine 2\n');
  assert.equal(result.sections[1].content, 'Beta body\n');
  assert.equal(result.hash, sha256(expected));
});

test('composeRules of an empty selection is empty with the empty hash', () => {
  const result = composeRules([]);
  assert.equal(result.content, '');
  assert.equal(result.hash, sha256(''));
  assert.deepEqual(result.sections, []);
});

test('composeRules respects the caller-given order', () => {
  const result = composeRules([rule('beta', 'Beta body\n'), rule('alpha', 'Alpha body\n')]);

  assert.equal(result.content, ['Beta body', '', 'Alpha body', ''].join('\n'));
  assert.deepEqual(
    result.sections.map((section) => section.id),
    ['beta', 'alpha']
  );
});

test('composeRules wraps each section in per-rule delimiters when asked', () => {
  const result = composeRules([rule('alpha', 'Alpha body\n')], { includeDelimiters: true });

  const expected = ['<!-- alpha:start -->', 'Alpha body', '<!-- alpha:end -->', ''].join('\n');
  assert.equal(result.content, expected);
});

test('includeDelimiters resolves from global config and the project layer overrides it', async () => {
  await withScratchHomes(async (homes) => {
    writeUserConfig(homes, '[rules]\nenabled = ["alpha"]\nincludeDelimiters = true\n');
    seedRule(homes, 'alpha.md', 'Alpha body\n');

    assert.equal(loadConfig().rules.includeDelimiters, true);

    const inheritingProject = path.join(homes.root, 'project-inherit');
    fs.mkdirSync(inheritingProject, { recursive: true });
    fs.writeFileSync(
      path.join(inheritingProject, '.asb.toml'),
      '[rules]\nenabled = ["alpha"]\n',
      'utf-8'
    );
    assert.equal(loadConfig({ project: inheritingProject }).rules.includeDelimiters, true);

    const overridingProject = path.join(homes.root, 'project-override');
    fs.mkdirSync(overridingProject, { recursive: true });
    fs.writeFileSync(
      path.join(overridingProject, '.asb.toml'),
      '[rules]\nenabled = ["alpha"]\nincludeDelimiters = false\n',
      'utf-8'
    );
    assert.equal(loadConfig({ project: overridingProject }).rules.includeDelimiters, false);
  });
});
