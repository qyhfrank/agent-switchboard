import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runSync } from '../src/engine/cli.js';
import { filterCodexHooks, preferHomeVar } from '../src/engine/dialects.js';
import {
  commandsOf,
  configFor,
  configPath,
  eventGroups,
  HOOK_DIR,
  hooksRows,
  managedDir,
  managedParent,
  readJson,
  seedHook,
  seedHookBundle,
  writeJson,
} from './helpers/hooks.js';
import {
  installApps,
  seedMarketplace,
  withScratchHomes,
  writeUserConfig,
} from './helpers/scratch.js';

/**
 * How a selected hook reaches an app: the render rules, the merge into a user
 * document, the bundle payload beside it, and what a failure contains itself
 * to. Every claim is a file assertion on settings.json / hooks.json / the
 * distributed bundle dir, with the report row asserted beside it.
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is literal
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}';

const HOME = '/home/ada';

const USER_GROUP_A = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-a' }] };
const USER_GROUP_B = { hooks: [{ type: 'command', command: 'echo user-b', timeout: 5 }] };

/** Library shape carrying every marker the render must strip: keys and comment lines. */
const LINT_LIBRARY = {
  UserPromptSubmit: [
    {
      matcher: '*',
      _asb_source: true,
      hooks: [
        {
          type: 'command',
          command: 'echo lint\n# asb-managed-by=agent-switchboard\n# asb-hook-id=lint',
          _asb_hook_id: 'lint',
        },
      ],
    },
  ],
};
const LINT_RENDERED = { matcher: '*', hooks: [{ type: 'command', command: 'echo lint' }] };

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

/**
 * The home prefix keys off os.homedir() while the app root keys off
 * ASB_AGENTS_HOME, so under scratch homes (a tmpdir tree) nothing is rewritten
 * and the command keeps its absolute path. The rule is the frozen one, not one
 * environment's answer.
 */
function homePortable(absolute: string): string {
  const home = os.homedir().replace(/\/+$/, '');
  if (home.length === 0 || !absolute.startsWith(`${home}/`)) return absolute;
  return `$HOME/${absolute.slice(home.length + 1)}`;
}

test('a home path is rewritten to $HOME only at path-token starts', () => {
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

  // A sibling home whose name extends this one, and this home appearing inside
  // another path: substituting either would point the command at a directory
  // that does not exist on the peer machine.
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

  // A group whose every handler is unsupported takes the group with it, and an
  // entry left with no group at all distributes nothing.
  assert.deepEqual(
    filterCodexHooks({ Stop: [{ hooks: [{ type: 'http', url: 'https://example.test' }] }] }),
    {}
  );
});

test('a selected hook is appended after the user groups with no ASB metadata', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, {
      theme: 'dark',
      hooks: { UserPromptSubmit: [USER_GROUP_A, USER_GROUP_B] },
    });
    writeUserConfig(homes, configFor(['claude-code'], ['lint']));

    const report = await runSync();

    // Order is the whole claim: user groups first, in their original order, the
    // managed group appended last.
    assert.deepEqual(eventGroups(settings, 'UserPromptSubmit'), [
      USER_GROUP_A,
      USER_GROUP_B,
      LINT_RENDERED,
    ]);
    assert.equal(readJson(settings).theme, 'dark', 'unrelated top-level keys survive');

    const raw = fs.readFileSync(settings, 'utf-8');
    assert.equal(raw.includes('_asb'), false, 'no ASB marker keys reach the app config');
    assert.equal(raw.includes('asb-managed'), false, 'no ASB marker comment lines either');
    assert.equal(raw, `${JSON.stringify(readJson(settings), null, 2)}\n`, '2-space JSON, newline');

    const row = hooksRows(report).find((entry) => entry.app === 'claude-code');
    assert.equal(row?.outcome, 'written');
    assert.equal(row?.detail, 'merged');
    assert.equal(row?.path, settings);
  });
});

test('a bundle hook copies its files and renders the hook dir home-portably', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const home = os.homedir().replace(/\/+$/, '');
    // One command exercising all three render rules: placeholder expansion,
    // $HOME substitution at a path-token boundary, and the near-miss prefix
    // that must not be substituted.
    const command = `${HOOK_DIR}/run.sh --home ${home}/notes.txt --near ${home}2/notes.txt`;
    const source = seedHookBundle(
      homes,
      'bt',
      { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
      { 'run.sh': '#!/bin/sh\necho bt\n' }
    );
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();

    const target = managedDir(homes, 'claude-code', 'bt');
    assert.equal(fs.existsSync(target), true, 'the bundle is distributed under hooks/managed');
    // Every file in the bundle dir is copied, hook.json included.
    assert.deepEqual(fs.readdirSync(target).sort(), ['hook.json', 'run.sh']);
    assert.equal(
      fs.readFileSync(path.join(target, 'run.sh'), 'utf-8'),
      fs.readFileSync(path.join(source, 'run.sh'), 'utf-8')
    );

    const settings = configPath(homes, 'claude-code');
    assert.deepEqual(commandsOf(eventGroups(settings, 'UserPromptSubmit')), [
      `${homePortable(target)}/run.sh --home $HOME/notes.txt --near ${home}2/notes.txt`,
    ]);
    assert.equal(
      fs.readFileSync(settings, 'utf-8').includes(HOOK_DIR),
      false,
      'the placeholder never survives distribution'
    );
  });
});

test('a plugin hook bundles its scripts and resolves the plugin-root placeholder', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedMarketplace(homes, 'shop', 'shop', 'demo', {
      'hooks/myhook.json': JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `node "${PLUGIN_ROOT}/hooks/helper.js"` }],
            },
          ],
        },
      }),
      'hooks/helper.js': 'console.log("hi");\n',
    });
    const source = path.join(homes.asbHome, 'plugins', 'shop');
    writeUserConfig(
      homes,
      `${configFor(['claude-code'], ['demo@shop:myhook'])}
[plugins]
enabled = ["demo@shop"]

[plugins.sources]
shop = ${JSON.stringify(source)}
`
    );

    const report = await runSync();

    assert.equal(report.exitCode, 0, JSON.stringify(report.entries, null, 2));
    const settings = configPath(homes, 'claude-code');
    const [command] = commandsOf(eventGroups(settings, 'UserPromptSubmit'));
    assert.equal(command.includes('CLAUDE_PLUGIN_ROOT'), false, command);
    const bundled = path.join(managedDir(homes, 'claude-code', 'demo@shop:myhook'), 'helper.js');
    assert.equal(fs.existsSync(bundled), true, `expected the script at ${bundled}: ${command}`);
    assert.equal(command.includes(bundled), true, command);
  });
});

test('deselection removes the groups, the bundle dir, and the emptied hooks key', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    seedHookBundle(
      homes,
      'bt',
      { PreToolUse: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }] },
      { 'run.sh': '#!/bin/sh\necho bt\n' }
    );
    const settings = configPath(homes, 'claude-code');
    writeJson(settings, { theme: 'dark' });
    writeUserConfig(homes, configFor(['claude-code'], ['lint', 'bt']));

    await runSync();
    assert.equal(eventGroups(settings, 'UserPromptSubmit').length, 1);
    assert.equal(eventGroups(settings, 'PreToolUse').length, 1);
    assert.equal(fs.existsSync(managedDir(homes, 'claude-code', 'bt')), true);

    writeUserConfig(homes, configFor(['claude-code'], []));
    const second = await runSync();

    assert.equal(fs.existsSync(settings), true, 'settings.json itself is never deleted');
    const after = readJson(settings);
    assert.equal(Object.hasOwn(after, 'hooks'), false, 'an empty merged map deletes the hooks key');
    assert.equal(after.theme, 'dark', 'unrelated keys round-trip untouched');
    assert.equal(
      fs.existsSync(managedDir(homes, 'claude-code', 'bt')),
      false,
      'the orphan bundle dir is removed'
    );
    assert.equal(
      fs.existsSync(managedParent(homes, 'claude-code')),
      true,
      'the emptied hooks/managed parent survives'
    );
    // Clearing is reported, not silent: a config row for the emptied map and a
    // removal row for the reclaimed bundle directory.
    const rows = hooksRows(second);
    const config = rows.find((entry) => entry.id === null);
    assert.equal(config?.outcome, 'written');
    assert.equal(config?.detail, 'cleared');
    assert.equal(rows.find((entry) => entry.id === 'bt')?.outcome, 'removed');
  });
});

test('codex hooks.json appends after user groups and is deleted only when empty', async () => {
  const CLEAN = {
    UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo c' }] }],
  };
  const USER = { matcher: 'shell', hooks: [{ type: 'command', command: 'echo user' }] };

  // The same append discipline as claude-code; a surviving user group keeps the
  // file alive through deselection.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    const hooksJson = configPath(homes, 'codex');
    writeJson(hooksJson, { hooks: { UserPromptSubmit: [USER] } });
    writeUserConfig(homes, configFor(['codex'], ['clean']));

    await runSync();
    assert.deepEqual(eventGroups(hooksJson, 'UserPromptSubmit'), [USER, CLEAN.UserPromptSubmit[0]]);

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), true, 'a remaining user group keeps the file');
    assert.deepEqual(eventGroups(hooksJson, 'UserPromptSubmit'), [USER]);
  });

  // No groups left, nothing selected, no other top-level keys: deleted.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    writeUserConfig(homes, configFor(['codex'], ['clean']));
    await runSync();
    const hooksJson = configPath(homes, 'codex');
    assert.equal(fs.existsSync(hooksJson), true);

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), false, 'hooks.json is removed outright');
  });

  // A non-`hooks` top-level key blocks the deletion; only that key is left.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'clean', CLEAN);
    const hooksJson = configPath(homes, 'codex');
    writeJson(hooksJson, { preferredNotifChannel: 'desktop' });
    writeUserConfig(homes, configFor(['codex'], ['clean']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    await runSync();
    assert.equal(fs.existsSync(hooksJson), true, 'a foreign top-level key keeps the file');
    assert.deepEqual(readJson(hooksJson), { preferredNotifChannel: 'desktop' });
  });
});

test('an invalid hooks shape aborts that app before any config write', async () => {
  // Validation runs after the bundle copy phase, so the claim is scoped to the
  // config file; a definition hook keeps it exact.
  const cases: Array<[string, unknown]> = [
    ['hooks is not an object', { theme: 'dark', hooks: 'nope' }],
    ['hooks.<event> is not an array', { theme: 'dark', hooks: { UserPromptSubmit: {} } }],
  ];
  for (const [label, seeded] of cases) {
    await withScratchHomes(async (homes) => {
      installApps(homes, 'claude-code');
      seedHook(homes, 'lint', LINT_LIBRARY);
      const settings = configPath(homes, 'claude-code');
      writeJson(settings, seeded);
      const before = fs.readFileSync(settings, 'utf-8');
      writeUserConfig(homes, configFor(['claude-code'], ['lint']));

      const report = await runSync();

      assert.equal(fs.readFileSync(settings, 'utf-8'), before, `${label}: config is untouched`);
      const row = hooksRows(report).find((entry) => entry.app === 'claude-code');
      assert.equal(row?.outcome, 'failed', `${label}: the refusal is reported`);
      assert.equal(row?.detail, 'invalid-shape', label);
      assert.notEqual(report.exitCode, 0, `${label}: an unusable config fails the run`);
    });
  }
});

test('a user-edited group survives deselection while every copy of the render leaves', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    // Definition hooks carry no managed path, so equality with the render is
    // the whole of the evidence.
    seedHook(homes, 'alpha', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo alpha' }] }],
    });
    seedHook(homes, 'beta', {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo beta' }] }],
    });
    writeUserConfig(homes, configFor(['claude-code'], ['alpha', 'beta']));

    await runSync();
    const settings = configPath(homes, 'claude-code');
    assert.equal(fs.existsSync(settings), true, 'the first sync writes settings.json');
    const groups = eventGroups(settings, 'PreToolUse');
    assert.equal(groups.length, 2);

    // The user hand-edits beta's command (deep equality broken) and duplicates
    // alpha's group verbatim: two copies of the render, one group asb cannot
    // prove anything about.
    const alpha = groups.find((group) => commandsOf([group]).includes('echo alpha'));
    assert.ok(alpha, 'expected the rendered alpha group');
    const edited = { matcher: '*', hooks: [{ type: 'command', command: 'echo beta --user' }] };
    writeJson(settings, { hooks: { PreToolUse: [alpha, edited, alpha] } });

    writeUserConfig(homes, configFor(['claude-code'], []));
    await runSync();

    // Both copies are what the library renders, so both are asb's and both
    // leave; the edited one matches nothing and is never claimed.
    assert.deepEqual(eventGroups(settings, 'PreToolUse'), [edited]);
  });
});

/**
 * Event names come from the app's vocabulary, not from asb, and `JSON.parse`
 * hands back `__proto__` as an own key. Every event-keyed map the rewrite
 * builds must therefore be a plain dictionary: a `{}` literal routes that key
 * into the prototype setter and drops the user's groups on the floor.
 */
test('a user event named __proto__ survives the rewrite', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'lint', LINT_LIBRARY);
    const protoGroup = { matcher: 'proto', hooks: [{ type: 'command', command: 'echo proto' }] };
    const settings = configPath(homes, 'claude-code');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `{ "hooks": { "__proto__": [${JSON.stringify(protoGroup)}] } }\n`);
    writeUserConfig(homes, configFor(['claude-code'], ['lint']));

    await runSync();

    const hooks = readJson(settings).hooks as Record<string, unknown>;
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(hooks, '__proto__')?.value,
      [protoGroup],
      'the user-written event and its group are preserved'
    );
    assert.deepEqual(
      eventGroups(settings, 'UserPromptSubmit'),
      [LINT_RENDERED],
      'the selected hook still distributes beside it'
    );
  });
});

test('distributed bundle scripts follow the source executable bit', async () => {
  const HOOKS = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${HOOK_DIR}/run.sh` }] }],
  };
  const SCRIPT = '#!/bin/sh\necho bt\n';

  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    const source = seedHookBundle(homes, 'bt', HOOKS, { 'run.sh': SCRIPT });
    fs.chmodSync(path.join(source, 'run.sh'), 0o755);
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();
    const target = path.join(managedDir(homes, 'claude-code', 'bt'), 'run.sh');
    assert.equal(fs.existsSync(target), true, 'the bundle script is distributed');
    assert.equal(modeOf(target), 0o755, 'an executable source keeps its exact mode');

    fs.chmodSync(target, 0o644);
    await runSync();
    assert.equal(modeOf(target), 0o755, 'mode drift alone counts as a write');
    assert.equal(fs.readFileSync(target, 'utf-8'), SCRIPT, 'a repair never touches content');
  });

  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHookBundle(homes, 'bt', HOOKS, { 'run.sh': SCRIPT });
    writeUserConfig(homes, configFor(['claude-code'], ['bt']));

    await runSync();
    const target = path.join(managedDir(homes, 'claude-code', 'bt'), 'run.sh');
    assert.equal(fs.existsSync(target), true, 'the bundle script is distributed');
    assert.equal(modeOf(target) & 0o111, 0, 'a plain source never lands executable');

    fs.chmodSync(target, 0o755);
    await runSync();
    // The repair rule reads currentMode & 0o666, not the source mode.
    assert.equal(modeOf(target), 0o644);
  });
});

test('a missing library entry and a malformed hook file contain to their own rows', async () => {
  await withScratchHomes(async (homes) => {
    installApps(homes, 'claude-code');
    seedHook(homes, 'good', LINT_LIBRARY);
    fs.writeFileSync(path.join(homes.asbHome, 'hooks', 'broken.json'), '{ "hooks": ', 'utf-8');
    writeUserConfig(homes, configFor(['claude-code'], ['good', 'broken', 'ghost']));

    const report = await runSync();

    // The healthy sibling still distributes: that is the containment claim.
    const settings = configPath(homes, 'claude-code');
    assert.equal(fs.existsSync(settings), true, 'the healthy hook still reaches the app config');
    assert.deepEqual(eventGroups(settings, 'UserPromptSubmit'), [LINT_RENDERED]);

    const broken = hooksRows(report).find((entry) => entry.id === 'broken');
    assert.equal(broken?.app, null, 'the malformed library hook gets its own row');
    assert.equal(broken?.outcome, 'failed');
    assert.equal(broken?.detail, 'parse-error');

    const ghost = hooksRows(report).find((entry) => entry.id === 'ghost');
    assert.equal(ghost?.app, null, 'the enabled-but-absent id gets its own row');
    assert.equal(ghost?.outcome, 'missing');

    assert.notEqual(report.exitCode, 0, 'neither failure is silent');
  });
});

test('a codex hooks write reports the trust review Codex still requires', async () => {
  const LIBRARY = {
    UserPromptSubmit: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo t' }] }],
  };

  // Codex records trust against each hook's current hash and skips new or
  // changed non-managed hooks until they are reviewed, so a written hooks.json
  // is not yet a running hook. Distribution cannot establish that trust, so it
  // has to name the step instead of letting `written` imply it.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex', 'claude-code');
    seedHook(homes, 'trust', LIBRARY);
    writeUserConfig(homes, configFor(['codex', 'claude-code'], ['trust']));

    const first = await runSync();

    const codex = hooksRows(first).find((entry) => entry.app === 'codex' && entry.id === null);
    assert.equal(codex?.outcome, 'written');
    assert.equal(typeof codex?.reason, 'string', 'the write names the review Codex still wants');
    assert.notEqual(codex?.reason, '');

    // The notice is Codex's gate, not a property of distributing hooks.
    const claude = hooksRows(first).find(
      (entry) => entry.app === 'claude-code' && entry.id === null
    );
    assert.equal(claude?.outcome, 'written');
    assert.equal(claude?.reason, undefined);

    // An unchanged config is not a new review: only a write carries it.
    const second = await runSync();
    const quiet = hooksRows(second).find((entry) => entry.app === 'codex' && entry.id === null);
    assert.equal(quiet?.outcome, 'unchanged');
    assert.equal(quiet?.reason, undefined);
  });

  // Deselecting everything empties the hook map; a foreign top-level key keeps
  // the file, and an emptied map leaves nothing to review.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'trust', LIBRARY);
    writeJson(configPath(homes, 'codex'), { preferredNotifChannel: 'desktop' });
    writeUserConfig(homes, configFor(['codex'], ['trust']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    const cleared = hooksRows(await runSync()).find((entry) => entry.id === null);

    assert.equal(cleared?.detail, 'cleared');
    assert.equal(cleared?.reason, undefined);
  });

  // A write that only removes asks for no review, even beside a foreign hook
  // that keeps the file non-empty.
  await withScratchHomes(async (homes) => {
    installApps(homes, 'codex');
    seedHook(homes, 'trust', LIBRARY);
    writeJson(configPath(homes, 'codex'), {
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: "echo 'foreign'" }] },
        ],
      },
    });
    writeUserConfig(homes, configFor(['codex'], ['trust']));
    await runSync();

    writeUserConfig(homes, configFor(['codex'], []));
    const removal = hooksRows(await runSync()).find((entry) => entry.id === null);

    assert.equal(removal?.outcome, 'written');
    assert.equal(removal?.detail, 'merged', 'the foreign hook keeps the file');
    assert.equal(removal?.reason, undefined, 'nothing new needs a review');
  });
});
