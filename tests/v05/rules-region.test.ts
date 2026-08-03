import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractRegion,
  hasRegionMarkers,
  isDedicatedFile,
  mergeRegion,
  removeRegion,
} from '../../src/engine/shapes.js';

const START = '<!-- rules:start -->';
const END = '<!-- rules:end -->';
const LEGACY_START = '<!-- asb:rules:start -->';
const LEGACY_END = '<!-- asb:rules:end -->';

test('mergeRegion inserts block at top (prepend) in empty file', () => {
  const result = mergeRegion('', 'Rule content here', 'prepend');
  assert.ok(result.startsWith(START));
  assert.ok(result.includes('Rule content here'));
  assert.ok(result.includes(END));
});

test('mergeRegion inserts block at top (prepend) with existing content', () => {
  const existing = 'Project-specific instructions\n';
  const result = mergeRegion(existing, 'managed rules', 'prepend');
  const startIdx = result.indexOf(START);
  const existingIdx = result.indexOf('Project-specific instructions');
  assert.ok(startIdx < existingIdx, 'ASB block should come before existing content');
});

test('mergeRegion inserts block at bottom (append) with existing content', () => {
  const existing = 'Project-specific instructions\n';
  const result = mergeRegion(existing, 'managed rules', 'append');
  const endIdx = result.indexOf(END);
  const existingIdx = result.indexOf('Project-specific instructions');
  assert.ok(existingIdx < endIdx, 'Existing content should come before ASB block');
});

test('mergeRegion replaces existing block', () => {
  const existing = `Before content\n${START}\nOld ASB content\n${END}\nAfter content\n`;
  const result = mergeRegion(existing, 'New ASB content', 'prepend');
  assert.ok(result.includes('New ASB content'));
  assert.ok(!result.includes('Old ASB content'));
  assert.ok(result.includes('Before content'));
  assert.ok(result.includes('After content'));
});

test('mergeRegion preserves surrounding content on replace', () => {
  const existing = `# My Project\n\n${START}\nold rules\n${END}\n\n## Other Section\n`;
  const result = mergeRegion(existing, 'new rules', 'prepend');
  assert.ok(result.includes('# My Project'));
  assert.ok(result.includes('## Other Section'));
  assert.ok(result.includes('new rules'));
  assert.ok(!result.includes('old rules'));
});

test('mergeRegion with empty content removes existing block', () => {
  const existing = `Before\n${START}\nASB stuff\n${END}\nAfter\n`;
  const result = mergeRegion(existing, '', 'prepend');
  assert.ok(!result.includes(START));
  assert.ok(!result.includes(END));
  assert.ok(!result.includes('ASB stuff'));
});

test('mergeRegion with empty content and no block returns unchanged', () => {
  const existing = 'Just some content\n';
  const result = mergeRegion(existing, '', 'prepend');
  assert.equal(result, existing);
});

test('removeRegion removes markers and content', () => {
  const content = `Before\n\n${START}\nASB content\n${END}\n\nAfter\n`;
  const result = removeRegion(content);
  assert.ok(!result.includes(START));
  assert.ok(!result.includes(END));
  assert.ok(!result.includes('ASB content'));
  assert.ok(result.includes('Before'));
  assert.ok(result.includes('After'));
});

test('removeRegion returns empty string when only ASB block', () => {
  const content = `${START}\nASB only content\n${END}\n`;
  const result = removeRegion(content);
  assert.equal(result, '');
});

test('removeRegion returns content unchanged when no markers', () => {
  const content = 'No markers here\n';
  const result = removeRegion(content);
  assert.equal(result, content);
});

test('removeRegion collapses excess blank lines', () => {
  const content = `Line 1\n\n\n${START}\nblock\n${END}\n\n\nLine 2\n`;
  const result = removeRegion(content);
  assert.ok(!result.includes('\n\n\n'), 'Should not have 3+ consecutive newlines');
});

test('a region an earlier version wrapped is replaced, not duplicated', () => {
  const existing = `Yours above\n${LEGACY_START}\nOld managed rules\n${LEGACY_END}\nYours below\n`;
  const result = mergeRegion(existing, 'New managed rules', 'prepend');

  assert.equal(result.split(START).length - 1, 1, 'exactly one managed region');
  assert.ok(!result.includes(LEGACY_START), 'the old wrapper is rewritten, not kept');
  assert.ok(!result.includes(LEGACY_END));
  assert.ok(!result.includes('Old managed rules'));
  assert.ok(result.includes('New managed rules'));
  assert.ok(result.includes('Yours above'));
  assert.ok(result.includes('Yours below'));
});

test('a region an earlier version wrapped is found by every locator', () => {
  const existing = `Yours\n${LEGACY_START}\nManaged\n${LEGACY_END}\n`;

  assert.equal(hasRegionMarkers(existing), true);
  assert.equal(extractRegion(existing), `${LEGACY_START}\nManaged\n${LEGACY_END}`);
  assert.equal(removeRegion(existing), 'Yours\n');
});

test('a hand-edited region is removed with every byte outside it preserved', () => {
  const existing = [
    '# My notes',
    '',
    'Something I wrote.',
    '',
    START,
    'Managed rules, then a line I added by hand.',
    END,
    '',
    'A trailing note of mine.',
    '',
  ].join('\n');

  const result = removeRegion(existing);

  assert.ok(!result.includes(START));
  assert.ok(!result.includes(END));
  assert.ok(!result.includes('Managed rules'));
  assert.ok(!result.includes('a line I added by hand'));
  assert.ok(result.includes('# My notes'));
  assert.ok(result.includes('Something I wrote.'));
  assert.ok(result.includes('A trailing note of mine.'));
});

test('the written marker pair never names asb', () => {
  const result = mergeRegion('', 'managed rules', 'prepend');
  assert.ok(!/asb/i.test(result), `written region still names asb: ${result}`);
});

test('isDedicatedFile returns true for asb-rules prefixed files', () => {
  assert.ok(isDedicatedFile('/path/to/.cursor/rules/asb-rules.mdc'));
  assert.ok(isDedicatedFile('/path/to/.trae/rules/asb-rules.md'));
});

test('isDedicatedFile returns false for shared files', () => {
  assert.ok(!isDedicatedFile('/path/to/.claude/CLAUDE.md'));
  assert.ok(!isDedicatedFile('/path/to/AGENTS.md'));
  assert.ok(!isDedicatedFile('/path/to/project/AGENTS.md'));
});

test('isDedicatedFile handles Windows paths', () => {
  assert.ok(isDedicatedFile(String.raw`C:\repo\.cursor\rules\asb-rules.mdc`));
  assert.ok(!isDedicatedFile(String.raw`C:\repo\.claude\CLAUDE.md`));
});
