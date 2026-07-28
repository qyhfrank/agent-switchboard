import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCodexHooks, preferHomeVar } from '../../src/engine/dialects.js';

/**
 * The two hook render rules that scratch homes cannot reach: `preferHomeVar`
 * keys off the real `os.homedir()` while the app root keys off
 * ASB_AGENTS_HOME, so an end-to-end run under a tmpdir never takes its
 * substitution branch; the Codex filter only shows itself on a hook Codex
 * cannot run. Both are asserted directly here.
 */

const HOME = '/home/ada';

test('preferHomeVar substitutes only at path-token starts', () => {
  assert.equal(preferHomeVar(`${HOME}/bin/lint`, HOME), '$HOME/bin/lint');
  assert.equal(preferHomeVar(`sh ${HOME}/bin/lint`, HOME), 'sh $HOME/bin/lint');
  for (const boundary of ['"', "'", '`', '=', '(', ':', ';', '&', '|', '<', '>']) {
    assert.equal(
      preferHomeVar(`x${boundary}${HOME}/bin`, HOME),
      `x${boundary}$HOME/bin`,
      `boundary ${boundary}`
    );
  }
  assert.equal(
    preferHomeVar(`${HOME}/a --to ${HOME}/b`, HOME),
    '$HOME/a --to $HOME/b',
    'every occurrence is rewritten, not just the first'
  );
});

test('preferHomeVar leaves near-miss and embedded home paths alone', () => {
  // A sibling home whose name extends this one, and this home appearing
  // inside another path: substituting either would point the command at a
  // directory that does not exist on the peer machine.
  assert.equal(preferHomeVar(`${HOME}2/notes.txt`, HOME), `${HOME}2/notes.txt`);
  assert.equal(preferHomeVar(`/backup${HOME}/notes.txt`, HOME), `/backup${HOME}/notes.txt`);
  assert.equal(preferHomeVar(HOME, HOME), HOME, 'the bare home is not a path prefix');
  assert.equal(preferHomeVar(`${HOME}/x`, `${HOME}/`), '$HOME/x', 'a trailing slash is normalized');
  assert.equal(preferHomeVar(`${HOME}/x`, ''), `${HOME}/x`, 'no home, no rewrite');
  assert.equal(
    preferHomeVar('/home/a+b/x', '/home/a+b'),
    '$HOME/x',
    'regex metacharacters in the home path are literal'
  );
});

test('the Codex filter drops what Codex cannot run and rebuilds the rest', () => {
  const filtered = filterCodexHooks({
    UserPromptSubmit: [
      {
        matcher: '*',
        _asb_source: true,
        hooks: [
          { type: 'command', command: 'echo keep', timeout: 5 },
          { type: 'command', command: 'echo drop', _asb_hook_id: 'x' },
          { type: 'prompt', prompt: 'never on codex' },
        ],
      },
    ],
    Notification: [{ hooks: [{ type: 'command', command: 'echo unsupported-event' }] }],
  });

  assert.deepEqual(Object.keys(filtered), ['UserPromptSubmit'], 'unsupported events are dropped');
  assert.deepEqual(filtered.UserPromptSubmit, [
    { matcher: '*', hooks: [{ type: 'command', command: 'echo keep', timeout: 5 }] },
  ]);

  // A group whose every handler is unsupported takes the group with it, and
  // an entry left with no group at all distributes nothing.
  assert.deepEqual(
    filterCodexHooks({ Stop: [{ hooks: [{ type: 'http', url: 'https://example.test' }] }] }),
    {}
  );
});
