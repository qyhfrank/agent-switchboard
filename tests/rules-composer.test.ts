import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getConfigDir } from '../src/config/paths.js';
import { composeActiveRules, composeRules } from '../src/rules/composer.js';
import { ensureRulesDirectory, type RuleSnippet } from '../src/rules/library.js';
import { DEFAULT_RULE_STATE, saveRuleState } from '../src/rules/state.js';
import { withTempAsbHome } from './helpers/tmp.js';

test('composeRules merges active snippets without delimiters', () => {
  const rules: RuleSnippet[] = [
    {
      id: 'alpha',
      filePath: path.join(os.tmpdir(), 'alpha.md'),
      metadata: { title: 'Alpha', description: undefined, tags: [], requires: [] },
      content: 'Line 1\r\nLine 2\r\n\r\n',
    },
    {
      id: 'beta',
      filePath: path.join(os.tmpdir(), 'beta.md'),
      metadata: { title: undefined, description: undefined, tags: ['style'], requires: [] },
      content: 'Beta body\n',
    },
  ];

  const result = composeRules(['alpha', 'beta'], rules);

  const expected = ['Line 1', 'Line 2', '', 'Beta body', ''].join('\n');

  assert.equal(result.content, expected);
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[0].id, 'alpha');
  assert.equal(result.sections[0].content, 'Line 1\nLine 2\n');
  assert.equal(result.sections[1].content, 'Beta body\n');

  const expectedHash = createHash('sha256').update(expected).digest('hex');
  assert.equal(result.hash, expectedHash);
});

test('composeRules throws when an active rule is missing', () => {
  const rules: RuleSnippet[] = [
    {
      id: 'alpha',
      filePath: path.join(os.tmpdir(), 'alpha.md'),
      metadata: { title: undefined, description: undefined, tags: [], requires: [] },
      content: 'Alpha\n',
    },
  ];

  assert.throws(() => composeRules(['beta'], rules), /missing from the library/);
});

test('composeRules handles empty selection', () => {
  const rules: RuleSnippet[] = [];
  const result = composeRules([], rules);
  assert.equal(result.content, '');
  const expectedHash = createHash('sha256').update('').digest('hex');
  assert.equal(result.hash, expectedHash);
});

test('composeActiveRules reads from disk and respects state order', () => {
  withTempAsbHome(() => {
    const rulesDir = ensureRulesDirectory();

    fs.writeFileSync(
      path.join(rulesDir, 'alpha.md'),
      '---\n' + 'title: Alpha\n' + '---\n' + 'Alpha body\n'
    );
    fs.writeFileSync(path.join(rulesDir, 'beta.md'), 'Beta body\n');

    saveRuleState({
      ...DEFAULT_RULE_STATE,
      active: ['beta', 'alpha'],
      agentSync: {},
    });

    const composed = composeActiveRules();
    const expected = ['Beta body', '', 'Alpha body', ''].join('\n');

    assert.equal(composed.content, expected);
    assert.deepEqual(
      composed.sections.map((section) => section.id),
      ['beta', 'alpha']
    );
  });
});

test('composeActiveRules honours includeDelimiters flag from config', () => {
  withTempAsbHome(() => {
    const configDir = getConfigDir();
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.toml'),
      'agents = []\n[rules]\nincludeDelimiters = true\n'
    );

    const rulesDir = ensureRulesDirectory();
    fs.writeFileSync(path.join(rulesDir, 'alpha.md'), 'Alpha body\n');

    saveRuleState({
      ...DEFAULT_RULE_STATE,
      active: ['alpha'],
      agentSync: {},
    });

    const composed = composeActiveRules();
    const expected = ['<!-- alpha:start -->', 'Alpha body', '<!-- alpha:end -->', ''].join('\n');

    assert.equal(composed.content, expected);
  });
});
