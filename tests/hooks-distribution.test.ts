/**
 * Tests: distributeHooks respects isInstalled, merges without ASB metadata,
 * tracks ownership in ~/.asb/state/hooks/, migrates legacy layouts, and
 * cleans up bundle directories it can prove it owns.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getClaudeDir,
  getCodexConfigPath,
  getCodexDir,
  getCodexHooksJsonPath,
  getProjectCodexHooksJsonPath,
} from '../src/config/paths.js';
import { distributeHooks } from '../src/hooks/distribution.js';
import { ensureHooksDirectory } from '../src/hooks/library.js';
import { consumeLegacyManagedState, resolveHookStatePath } from '../src/hooks/state.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { getTargetById } from '../src/targets/registry.js';
import { simulateAppsInstalled, withTempHomes } from './helpers/tmp.js';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);
const HEX64_C = 'c'.repeat(64);
const HEX64_D = 'd'.repeat(64);

function createHookEntry(id: string, command = 'echo test'): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Test hook ${id}`,
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createBundleHook(id: string, event = 'UserPromptSubmit'): void {
  const hooksDir = ensureHooksDirectory();
  const bundleDir = path.join(hooksDir, id);
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, 'hook.json'),
    JSON.stringify({
      name: id,
      description: `Bundle hook ${id}`,
      hooks: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
        [event]: [{ hooks: [{ type: 'command', command: '${HOOK_DIR}/run.sh' }] }],
      },
    })
  );
  fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\necho test\n');
}

function enableHooks(ids: string[], apps?: string[]): void {
  updateLibraryStateSection('hooks', () => ({
    enabled: ids,
    agentSync: Object.fromEntries((apps ?? []).map((app) => [app, { enabled: ids }])),
  }));
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function claudeSettingsPath(): string {
  return path.join(getClaudeDir(), 'settings.json');
}

function groupCommands(groups: Array<Record<string, unknown>>): string[] {
  return groups.flatMap((group) =>
    Array.isArray(group.hooks)
      ? group.hooks
          .map((hook) => (hook as Record<string, unknown>).command)
          .filter((command): command is string => typeof command === 'string')
      : []
  );
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prev;
    }
  }
}

function createPluginHookSource(asbHome: string): { pluginDir: string; hookId: string } {
  const marketplaceDir = path.join(asbHome, 'marketplaces', 'superpowers');
  const pluginDir = path.join(marketplaceDir, 'plugins', 'superpowers');
  const hooksDir = path.join(pluginDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.mkdirSync(path.join(marketplaceDir, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });

  fs.writeFileSync(
    path.join(hooksDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
                command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
              },
            ],
          },
        ],
      },
    })
  );
  fs.writeFileSync(path.join(hooksDir, 'run-hook.cmd'), '@echo off\n');
  fs.writeFileSync(
    path.join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'superpowers',
      owner: { name: 'test-owner' },
      plugins: [{ name: 'superpowers', source: './plugins/superpowers' }],
    })
  );
  fs.writeFileSync(
    path.join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'superpowers' })
  );
  fs.writeFileSync(
    path.join(asbHome, 'config.toml'),
    `[plugins.sources]\nsuperpowers = "${marketplaceDir}"\n`
  );

  return { pluginDir, hookId: 'superpowers@superpowers:hooks' };
}

// ---------------------------------------------------------------------------
// Claude Code: install gating and basic distribution
// ---------------------------------------------------------------------------

test('distributeHooks: skips when claude-code not installed and not in assumeInstalled', () => {
  withTempHomes(() => {
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(outcome.results.length, 0, 'should produce no results when not installed');
  });
});

test('distributeHooks: distributes when claude-code is in assumeInstalled', () => {
  withTempHomes(() => {
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    const outcome = distributeHooks(undefined, ['claude-code'], new Set(['claude-code']));

    assert.ok(outcome.results.length > 0, 'should produce results when assumed installed');
  });
});

test('distributeHooks: distributes when claude-code is actually installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.length > 0, 'should produce results when installed');
    assert.ok(fs.existsSync(claudeSettingsPath()), 'settings.json should be written');
  });
});

test('distributeHooks: rewrites plugin hook CLAUDE_PLUGIN_ROOT references to distributed hook paths', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    enableHooks([hookId]);

    const outcome = distributeHooks(undefined, ['claude-code']);
    assert.ok(outcome.results.length > 0, 'should produce distribution results');

    const settings = readJson(claudeSettingsPath()) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command?: string }> }> };
    };

    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command;
    const expectedPath = path.join(getClaudeDir(), 'hooks', 'managed', hookId, 'run-hook.cmd');
    const portablePath = expectedPath.replace(`${os.homedir()}/`, '$HOME/');

    assert.equal(command, `"${portablePath}" session-start`);
  });
});

test('distributeHooks: skips malformed standalone plugin hook files', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const pluginDir = path.join(asbHome, 'external', 'standalone-hook-plugin');
    const hooksDir = path.join(pluginDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'copilot-hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ type: 'command', bash: 'node "hooks/start.js"', timeoutSec: 5 }],
        },
      })
    );
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo ok' }] }],
        },
      })
    );
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\nstandalone = "${pluginDir}"\n`
    );
    enableHooks(['standalone:hooks']);

    const outcome = distributeHooks(undefined, ['claude-code'], new Set(['claude-code']), {
      dryRun: true,
    });

    assert.ok(outcome.results.length > 0, 'should continue distribution');
    assert.ok(outcome.results.every((r) => r.status !== 'error'));
  });
});

// ---------------------------------------------------------------------------
// Claude Code: clean output, ownership state, idempotency
// ---------------------------------------------------------------------------

test('distributeHooks: writes no ASB metadata and no absolute home paths', () => {
  withTempHomes(({ asbHome }) => {
    const fakeHome = path.dirname(asbHome);
    withHome(fakeHome, () => {
      simulateAppsInstalled('claude-code');
      createBundleHook('bundle-test');
      enableHooks(['bundle-test']);

      distributeHooks(undefined, ['claude-code']);

      const raw = fs.readFileSync(claudeSettingsPath(), 'utf-8');
      assert.ok(!raw.includes('_asb'), 'no _asb keys or tags in settings.json');
      assert.ok(!raw.includes('asb-managed'), 'no ASB command markers in settings.json');
      assert.ok(!raw.includes(fakeHome), 'no absolute home paths in settings.json');
      const settings = readJson(claudeSettingsPath()) as {
        hooks: Record<string, Array<Record<string, unknown>>>;
      };
      const command = groupCommands(settings.hooks.UserPromptSubmit)[0];
      assert.equal(command, '$HOME/agents-home/.claude/hooks/managed/bundle-test/run.sh');

      const statePath = resolveHookStatePath('claude-code');
      assert.ok(fs.existsSync(statePath), 'ownership state file should exist');
      const stateRaw = fs.readFileSync(statePath, 'utf-8');
      assert.ok(!stateRaw.includes(fakeHome), 'state file stays machine-portable');
      const state = readJson(statePath) as { bundles: string[] };
      assert.deepEqual(state.bundles, ['bundle-test']);
    });
  });
});

test('distributeHooks: re-sync is idempotent and reports up-to-date', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    distributeHooks(undefined, ['claude-code']);
    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'claude-code' && r.status === 'skipped' && r.reason === 'up-to-date'
      )
    );
    const settings = readJson(claudeSettingsPath()) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1, 'no duplicate groups after re-sync');
  });
});

test('distributeHooks: user reordering does not duplicate or remove groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);
    distributeHooks(undefined, ['claude-code']);

    // User prepends their own group in front of the ASB-written one
    const settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    const userGroup = { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] };
    settings.hooks.PreToolUse.unshift(userGroup);
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify(settings));

    distributeHooks(undefined, ['claude-code']);

    const after = readJson(claudeSettingsPath()) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    const commands = groupCommands(after.hooks.PreToolUse);
    assert.deepEqual(commands.sort(), ['echo mine', 'echo test']);
  });
});

test('distributeHooks: bundle state loss duplicates once then converges', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('bundle-test');
    enableHooks(['bundle-test']);
    distributeHooks(undefined, ['claude-code']);

    fs.rmSync(resolveHookStatePath('claude-code'), { force: true });

    distributeHooks(undefined, ['claude-code']);
    let settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.UserPromptSubmit.length, 2, 'state loss duplicates safely');
    assert.ok(fs.existsSync(resolveHookStatePath('claude-code')), 'state file is re-created');

    distributeHooks(undefined, ['claude-code']);
    settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.UserPromptSubmit.length, 1, 're-created state converges safely');
  });
});

test('distributeHooks: one device cannot clean another device ownership', () => {
  withTempHomes(() => {
    const previous = process.env.ASB_DEVICE_ID;
    try {
      simulateAppsInstalled('claude-code');
      createBundleHook('device-bundle');
      enableHooks(['device-bundle']);
      process.env.ASB_DEVICE_ID = 'server-a';
      distributeHooks(undefined, ['claude-code']);
      const bundleDir = path.join(getClaudeDir(), 'hooks', 'managed', 'device-bundle');

      process.env.ASB_DEVICE_ID = 'server-b';
      enableHooks([]);
      distributeHooks(undefined, ['claude-code']);
      const settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
      assert.equal(settings.hooks.UserPromptSubmit.length, 1);
      assert.equal(fs.existsSync(bundleDir), true);

      process.env.ASB_DEVICE_ID = 'server-a';
      distributeHooks(undefined, ['claude-code']);
      assert.equal(fs.existsSync(bundleDir), false, 'owning device can clean its output');
    } finally {
      if (previous === undefined) delete process.env.ASB_DEVICE_ID;
      else process.env.ASB_DEVICE_ID = previous;
    }
  });
});

test('distributeHooks: definition-only hook duplicates once after state loss, then stays stable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);
    distributeHooks(undefined, ['claude-code']);

    fs.rmSync(resolveHookStatePath('claude-code'), { force: true });

    // Without state or path evidence the surviving copy reads as user-owned;
    // duplication is the safe failure mode (never claim what we cannot prove).
    distributeHooks(undefined, ['claude-code']);
    let settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.PreToolUse.length, 2, 'state loss duplicates once');
    assert.ok(fs.existsSync(resolveHookStatePath('claude-code')), 'ownership is re-recorded');

    distributeHooks(undefined, ['claude-code']);
    settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.PreToolUse.length, 2, 'stable after state is re-recorded');
  });
});

test('distributeHooks: user group identical to a managed hook is never claimed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);
    const userGroup = { matcher: '*', hooks: [{ type: 'command', command: 'echo test' }] };
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));

    distributeHooks(undefined, ['claude-code']);
    let settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.PreToolUse.length, 2, 'managed copy is appended, not adopted');

    enableHooks([]);
    distributeHooks(undefined, ['claude-code']);
    settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.PreToolUse.length, 1, 'only the managed copy is removed');
  });
});

test('distributeHooks: disabling hooks clears the config and ownership state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ theme: 'dark' }));
    createBundleHook('bundle-test');
    enableHooks(['bundle-test']);
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = path.join(getClaudeDir(), 'hooks', 'managed', 'bundle-test');
    assert.ok(fs.existsSync(bundleDir));

    enableHooks([]);
    const outcome = distributeHooks(undefined, ['claude-code']);

    const settings = readJson(claudeSettingsPath());
    assert.equal(settings.theme, 'dark', 'unrelated settings keys survive');
    assert.equal(settings.hooks, undefined, 'empty hooks key is removed');
    assert.equal(fs.existsSync(resolveHookStatePath('claude-code')), false);
    assert.equal(fs.existsSync(bundleDir), false, 'orphan bundle dir is removed');
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' && r.status === 'written' && r.reason === 'hooks cleared'
      )
    );
  });
});

test('distributeHooks: executable mode drift is repaired for claude-code bundles', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { pluginDir, hookId } = createPluginHookSource(asbHome);
    const sourceScript = path.join(pluginDir, 'hooks', 'run-hook.cmd');
    fs.chmodSync(sourceScript, 0o755);
    enableHooks([hookId]);

    distributeHooks(undefined, ['claude-code']);
    const targetDir = path.join(getClaudeDir(), 'hooks', 'managed', hookId);
    const targetScript = path.join(targetDir, 'run-hook.cmd');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

// ---------------------------------------------------------------------------
// Claude Code: migration from legacy and v0.4.28 layouts
// ---------------------------------------------------------------------------

test('distributeHooks: migrates legacy markers, tags, state files, and bundle dirs', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    const legacyAsbDir = path.join(getClaudeDir(), 'hooks', 'asb');
    fs.mkdirSync(path.join(legacyAsbDir, 'test-hook'), { recursive: true });
    fs.writeFileSync(path.join(legacyAsbDir, 'test-hook', 'run.sh'), '#!/bin/sh\n');
    fs.mkdirSync(path.join(legacyAsbDir, 'old-thing'), { recursive: true });
    fs.writeFileSync(path.join(legacyAsbDir, 'old-thing', 'run.sh'), '#!/bin/sh\n');

    const stateFromLegacyFile = {
      matcher: 'legacy-state',
      hooks: [{ type: 'command', command: 'echo from-state' }],
    };
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({
        theme: 'dark',
        hooks: {
          PreToolUse: [
            { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
            {
              matcher: 'marked',
              hooks: [
                {
                  type: 'command',
                  command: 'echo legacy\n# asb-managed-by=agent-switchboard\n# asb-hook-id=x',
                },
              ],
            },
            {
              matcher: 'tagged',
              hooks: [{ type: 'command', command: 'echo tagged' }],
              _asb_source: true,
            },
            stateFromLegacyFile,
            {
              matcher: 'legacy-path',
              hooks: [{ type: 'command', command: `${legacyAsbDir}/old-thing/run.sh` }],
            },
          ],
        },
        _asb_managed_hooks: ['x'],
      })
    );

    const stateDir = path.join(asbHome, 'state', 'hooks');
    fs.mkdirSync(stateDir, { recursive: true });
    const hexName = `claude-code-${HEX64_A}`;
    fs.writeFileSync(
      path.join(stateDir, `${hexName}.json`),
      JSON.stringify({ version: 1, hooks: { PreToolUse: [stateFromLegacyFile] } })
    );
    fs.writeFileSync(path.join(stateDir, `${hexName}.json.legacy-bundles`), '{}');
    fs.mkdirSync(path.join(stateDir, `${hexName}.json.lock`), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'locks'), { recursive: true });

    distributeHooks(undefined, ['claude-code']);

    const raw = fs.readFileSync(claudeSettingsPath(), 'utf-8');
    assert.ok(!raw.includes('_asb'), 'legacy tags and keys are gone');
    assert.ok(!raw.includes('asb-managed'), 'legacy command markers are gone');
    const settings = readJson(claudeSettingsPath()) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    const commands = groupCommands(settings.hooks.PreToolUse);
    assert.deepEqual(commands.sort(), ['echo mine', 'echo test']);
    assert.equal(settings.theme, 'dark');

    assert.equal(fs.existsSync(legacyAsbDir), false, 'legacy hooks/asb dir is fully removed');
    const newStatePath = resolveHookStatePath('claude-code');
    assert.ok(fs.existsSync(newStatePath), 'device-scoped state replaces legacy state');
    assert.deepEqual(fs.readdirSync(stateDir), [path.basename(path.dirname(newStatePath))]);

    const second = distributeHooks(undefined, ['claude-code']);
    assert.ok(
      second.results.some(
        (r) => r.platform === 'claude-code' && r.status === 'skipped' && r.reason === 'up-to-date'
      ),
      'migration converges to a stable state'
    );
  });
});

test('distributeHooks: removes v0.4.28 hash groups and bundle dirs, keeps foreign dirs', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    enableHooks([]);

    const managedDir = path.join(getClaudeDir(), 'hooks', 'managed');
    const referencedNs = path.join(managedDir, HEX64_A);
    fs.mkdirSync(path.join(referencedNs, HEX64_B), { recursive: true });
    fs.writeFileSync(path.join(referencedNs, HEX64_B, 'run.sh'), '#!/bin/sh\n');
    const unreferencedNs = path.join(managedDir, HEX64_C);
    fs.mkdirSync(path.join(unreferencedNs, HEX64_D), { recursive: true });
    const foreignDir = path.join(managedDir, 'my-own-dir');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'keep.txt'), 'keep me\n');

    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'user', hooks: [{ type: 'command', command: 'echo mine' }] },
            {
              matcher: 'v0428',
              hooks: [{ type: 'command', command: `${referencedNs}/${HEX64_B}/run.sh` }],
            },
          ],
        },
      })
    );

    const outcome = distributeHooks(undefined, ['claude-code']);

    const settings = readJson(claudeSettingsPath()) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    assert.deepEqual(groupCommands(settings.hooks.PreToolUse), ['echo mine']);
    assert.equal(fs.existsSync(referencedNs), false, 'referenced hash dir deleted');
    assert.equal(fs.existsSync(unreferencedNs), false, 'v0.4.28-shaped orphan deleted');
    assert.equal(fs.readFileSync(path.join(foreignDir, 'keep.txt'), 'utf-8'), 'keep me\n');
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'skipped' &&
          r.reason === 'unmanaged directory' &&
          r.entryId === 'my-own-dir'
      ),
      'foreign dir under managed root is reported, not deleted'
    );
  });
});

test('distributeHooks: URL containing hooks/managed/<hex> is not v0.4.28 evidence', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    enableHooks([]);

    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: 'url',
              hooks: [
                {
                  type: 'command',
                  command: `curl https://example.com/hooks/managed/${HEX64_A}/run.sh`,
                },
              ],
            },
          ],
        },
      })
    );

    distributeHooks(undefined, ['claude-code']);

    const settings = readJson(claudeSettingsPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(settings.hooks.PreToolUse.length, 1, 'URL-only group is kept');
  });
});

test('distributeHooks: v0.4.28 dir outside managed roots is reported, not deleted', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    enableHooks([]);

    const outside = path.join(agentsHome, 'elsewhere', 'hooks', 'managed', HEX64_A);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'v0428', hooks: [{ type: 'command', command: `${outside}/run.sh` }] },
          ],
        },
      })
    );

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(fs.existsSync(path.join(outside, 'run.sh')), 'dir outside managed roots untouched');
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'skipped' &&
          r.reason === 'outside managed roots'
      ),
      'skip is reported'
    );
  });
});

test('distributeHooks: refuses to distribute over v0.4.28 transaction artifacts', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ theme: 'dark' }));
    const artifact = `${claudeSettingsPath()}.previous.1234567890`;
    fs.writeFileSync(artifact, JSON.stringify({ theme: 'dark', hooks: {} }));
    const before = fs.readFileSync(claudeSettingsPath(), 'utf-8');

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'error' &&
          r.error?.includes('transaction artifacts')
      )
    );
    assert.equal(fs.readFileSync(claudeSettingsPath(), 'utf-8'), before, 'config untouched');
    assert.ok(fs.existsSync(artifact), 'artifact untouched');
  });
});

test('distributeHooks: detects transaction artifacts beside a symlinked settings target', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    enableHooks(['test-hook']);

    const mackupDir = path.join(asbHome, 'mackup');
    fs.mkdirSync(mackupDir, { recursive: true });
    const realSettings = path.join(mackupDir, 'settings.json');
    fs.writeFileSync(realSettings, JSON.stringify({ theme: 'dark' }));
    fs.symlinkSync(realSettings, claudeSettingsPath());
    fs.writeFileSync(`${realSettings}.previous.123`, '{}');

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'error' &&
          r.error?.includes('transaction artifacts')
      ),
      'artifacts beside the resolved target block distribution'
    );
    assert.deepEqual(readJson(realSettings), { theme: 'dark' }, 'config untouched');
  });
});

test('distributeHooks: publishes through a symlinked settings.json without breaking the link', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mackupDir = path.join(asbHome, 'mackup');
    fs.mkdirSync(mackupDir, { recursive: true });
    const realSettings = path.join(mackupDir, 'settings.json');
    fs.writeFileSync(realSettings, JSON.stringify({ theme: 'dark' }));
    fs.symlinkSync(realSettings, claudeSettingsPath());

    createHookEntry('test-hook');
    enableHooks(['test-hook']);
    distributeHooks(undefined, ['claude-code']);

    assert.ok(fs.lstatSync(claudeSettingsPath()).isSymbolicLink(), 'symlink survives publish');
    const real = readJson(realSettings) as { theme: string; hooks: Record<string, unknown[]> };
    assert.equal(real.theme, 'dark');
    assert.equal(real.hooks.PreToolUse.length, 1);
    const leftovers = fs.readdirSync(mackupDir).filter((name) => name.includes('.asb-write.'));
    assert.deepEqual(leftovers, [], 'no temp files left next to the real config');
  });
});

test('distributeHooks: dangling settings symlink publishes at its target, keeping the link', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const mackupDir = path.join(asbHome, 'mackup');
    fs.mkdirSync(mackupDir, { recursive: true });
    const realSettings = path.join(mackupDir, 'settings.json');
    fs.symlinkSync(realSettings, claudeSettingsPath());

    createHookEntry('test-hook');
    enableHooks(['test-hook']);
    distributeHooks(undefined, ['claude-code']);

    assert.ok(fs.lstatSync(claudeSettingsPath()).isSymbolicLink(), 'link survives publish');
    const real = readJson(realSettings) as { hooks: Record<string, unknown[]> };
    assert.equal(real.hooks.PreToolUse.length, 1, 'content lands at the link target');
  });
});

test('distributeHooks: marker lines in library hook definitions are stripped on distribute', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('marked-hook', 'echo run\n# asb-managed-by=agent-switchboard');
    enableHooks(['marked-hook']);

    distributeHooks(undefined, ['claude-code']);

    const raw = fs.readFileSync(claudeSettingsPath(), 'utf-8');
    assert.ok(!raw.includes('asb-managed'), 'marker line never reaches the app config');
    const settings = readJson(claudeSettingsPath()) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    assert.deepEqual(groupCommands(settings.hooks.PreToolUse), ['echo run']);

    const second = distributeHooks(undefined, ['claude-code']);
    assert.ok(
      second.results.some(
        (r) => r.platform === 'claude-code' && r.status === 'skipped' && r.reason === 'up-to-date'
      ),
      'stripped form is stable across syncs'
    );
  });
});

test('consumeLegacyManagedState: project scope never consumes global legacy state', () => {
  withTempHomes(({ asbHome }) => {
    const stateDir = path.join(asbHome, 'state', 'hooks');
    fs.mkdirSync(stateDir, { recursive: true });
    const globalLegacy = path.join(stateDir, `claude-code-${HEX64_A}.json`);
    fs.writeFileSync(
      globalLegacy,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }] } })
    );

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-proj-'));
    try {
      const legacy = consumeLegacyManagedState('claude-code', { project: projectRoot }, false);
      assert.equal(legacy.found, false, 'project scope sees no global legacy state');
      assert.deepEqual(legacy.groups, []);
      legacy.cleanup();
      assert.ok(fs.existsSync(globalLegacy), 'global legacy state untouched by project scope');

      const globalScope = consumeLegacyManagedState('claude-code', undefined, false);
      assert.equal(globalScope.found, true, 'global scope still consumes it');
      assert.equal(globalScope.groups.length, 1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

test('distributeHooks: claude-code waits for readable settings before touching anything', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');

    const staleDir = path.join(getClaudeDir(), 'hooks', 'managed', 'stale-hook');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'run.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(claudeSettingsPath(), '{not json');
    enableHooks([]);

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'error' &&
          r.error?.includes('Cannot read settings.json')
      )
    );
    assert.equal(fs.existsSync(staleDir), true, 'cleanup does not run on unreadable config');
  });
});

// ---------------------------------------------------------------------------
// Claude Code: symlinked layouts (dotfile-managed directories)
// ---------------------------------------------------------------------------

test('distributeHooks: claude-code writes bundles through a symlinked bundle parent', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    enableHooks([hookId]);

    const hooksLink = path.join(getClaudeDir(), 'hooks', 'managed');
    const outsideDir = path.join(agentsHome, 'outside-claude-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const targetDir = path.join(hooksLink, hookId);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(result?.status, 'written');
    assert.equal(fs.existsSync(path.join(outsideDir, hookId)), true);
    assert.equal(fs.lstatSync(hooksLink).isSymbolicLink(), true);
    assert.equal(fs.existsSync(claudeSettingsPath()), true);
  });
});

test('distributeHooks: claude-code writes bundles through a symlinked hooks ancestor', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    enableHooks([hookId]);

    const hooksLink = path.join(getClaudeDir(), 'hooks');
    const outsideHooksDir = path.join(agentsHome, 'outside-claude-hooks-ancestor');
    fs.mkdirSync(path.join(outsideHooksDir, 'managed'), { recursive: true });
    fs.symlinkSync(outsideHooksDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const targetDir = path.join(hooksLink, 'managed', hookId);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === targetDir
    );

    assert.equal(result?.status, 'written');
    assert.equal(fs.existsSync(path.join(outsideHooksDir, 'managed', hookId)), true);
    assert.equal(fs.lstatSync(hooksLink).isSymbolicLink(), true);
    assert.equal(fs.existsSync(claudeSettingsPath()), true);
  });
});

test('distributeHooks: claude-code cleanup scans a symlinked bundle parent, keeping unmanaged dirs', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    enableHooks([]);

    const hooksLink = path.join(getClaudeDir(), 'hooks', 'managed');
    const outsideDir = path.join(agentsHome, 'outside-claude-hook-cleanup');
    const outsideStaleDir = path.join(outsideDir, 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.entryId === 'stale-hook'
    );

    assert.equal(result?.status, 'skipped');
    assert.equal(result?.reason, 'unmanaged directory');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(fs.lstatSync(hooksLink).isSymbolicLink(), true);
    assert.ok(!outcome.results.some((r) => r.platform === 'claude-code' && r.status === 'error'));
  });
});

test('distributeHooks: claude-code cleanup scans a symlinked app root, keeping unmanaged dirs', () => {
  withTempHomes(({ agentsHome }) => {
    const claudeRoot = getClaudeDir();
    const outsideRoot = path.join(agentsHome, 'outside-claude-root');
    const outsideStaleDir = path.join(outsideRoot, 'hooks', 'managed', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideRoot, claudeRoot);

    enableHooks([]);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.entryId === 'stale-hook'
    );

    assert.equal(result?.status, 'skipped');
    assert.equal(result?.reason, 'unmanaged directory');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.ok(!outcome.results.some((r) => r.platform === 'claude-code' && r.status === 'error'));
  });
});

// ---------------------------------------------------------------------------
// Codex hook distribution
// ---------------------------------------------------------------------------

function createCodexCompatibleHook(id: string, event = 'UserPromptSubmit'): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Test hook ${id}`,
    hooks: {
      [event]: [{ matcher: '', hooks: [{ type: 'command', command: 'echo test-codex' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createUnsupportedEventHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  fs.writeFileSync(
    path.join(hooksDir, `${id}.json`),
    JSON.stringify({
      name: id,
      hooks: {
        Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
      },
    })
  );
}

function createHttpHandlerHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  fs.writeFileSync(
    path.join(hooksDir, `${id}.json`),
    JSON.stringify({
      name: id,
      hooks: {
        SessionStart: [{ hooks: [{ type: 'http', url: 'http://example.com' }] }],
      },
    })
  );
}

function createMixedHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  fs.writeFileSync(
    path.join(hooksDir, `${id}.json`),
    JSON.stringify({
      name: id,
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'echo start' },
              { type: 'http', url: 'http://example.com' },
            ],
          },
        ],
      },
    })
  );
}

test('distributeHooks: writes clean hooks.json for codex when installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('codex-hook');
    enableHooks(['codex-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(codexResults.length > 0, 'should produce codex results');

    const hooksJsonPath = getCodexHooksJsonPath();
    const raw = fs.readFileSync(hooksJsonPath, 'utf-8');
    assert.ok(!raw.includes('_asb'), 'no ASB keys or tags in hooks.json');
    assert.ok(!raw.includes('asb-managed'), 'no ASB command markers in hooks.json');
    const content = readJson(hooksJsonPath) as { hooks: Record<string, unknown[]> };
    const commands = groupCommands(
      content.hooks.UserPromptSubmit as Array<Record<string, unknown>>
    );
    assert.deepEqual(commands, ['echo test-codex']);
    assert.ok(fs.existsSync(resolveHookStatePath('codex')), 'codex state file should exist');
  });
});

test('distributeHooks: skips codex when not installed', () => {
  withTempHomes(() => {
    createCodexCompatibleHook('codex-hook');
    enableHooks(['codex-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex']);

    assert.equal(outcome.results.filter((r) => r.platform === 'codex').length, 0);
  });
});

test('distributeHooks: filters unsupported events for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createUnsupportedEventHook('compact-hook');
    enableHooks(['compact-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'compact-hook' &&
          r.reason?.includes('unsupported events') &&
          r.reason.includes('Notification')
      ),
      'unsupported-only hook should produce a visible Codex diagnostic'
    );
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
  });
});

test('distributeHooks: preserves current Codex supported events', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('permission-hook', 'PermissionRequest');
    createCodexCompatibleHook('pre-compact-hook', 'PreCompact');
    createCodexCompatibleHook('subagent-hook', 'SubagentStart');
    enableHooks(['permission-hook', 'pre-compact-hook', 'subagent-hook'], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = readJson(getCodexHooksJsonPath()) as { hooks: Record<string, unknown[]> };
    assert.ok(content.hooks.PermissionRequest, 'PermissionRequest should be preserved');
    assert.ok(content.hooks.PreCompact, 'PreCompact should be preserved');
    assert.ok(content.hooks.SubagentStart, 'SubagentStart should be preserved');
  });
});

test('distributeHooks: codex canonical hooks feature does not produce legacy warning', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexConfigPath(), '[features]\nhooks = true\n');
    createCodexCompatibleHook('feature-hook');
    enableHooks(['feature-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const configResults = outcome.results.filter(
      (r) => r.platform === 'codex' && 'filePath' in r && r.filePath === getCodexConfigPath()
    );

    assert.equal(configResults.length, 0, 'canonical features.hooks=true should not warn');
  });
});

test('distributeHooks: codex reports disabled hooks feature without claiming a write', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexConfigPath(), '[features]\nhooks = false\n');
    createCodexCompatibleHook('disabled-feature-hook');
    enableHooks(['disabled-feature-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const configResults = outcome.results.filter(
      (r) => r.platform === 'codex' && 'filePath' in r && r.filePath === getCodexConfigPath()
    );

    assert.ok(
      configResults.some(
        (r) =>
          r.status === 'conflict' &&
          r.reason?.includes('features.hooks') &&
          !r.reason.includes('codex_hooks')
      )
    );
    assert.equal(
      configResults.some((r) => r.status === 'written'),
      false
    );
  });
});

test('distributeHooks: codex respects active profile hooks feature override', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(
      getCodexConfigPath(),
      'profile = "work"\n\n[profiles.work.features]\nhooks = false\n'
    );
    createCodexCompatibleHook('profile-disabled-hook');
    enableHooks(['profile-disabled-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.filePath === getCodexConfigPath() &&
          r.reason?.includes('features.hooks')
      )
    );
  });
});

test('distributeHooks: codex profile hooks feature overrides top-level feature', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(
      getCodexConfigPath(),
      'profile = "work"\n\n[features]\nhooks = false\n\n[profiles.work.features]\nhooks = true\n'
    );
    createCodexCompatibleHook('profile-enabled-hook');
    enableHooks(['profile-enabled-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.filePath === getCodexConfigPath() &&
          r.status === 'conflict' &&
          r.reason?.includes('features.hooks')
      ),
      false
    );
  });
});

test('distributeHooks: codex project hooks do not auto-trust the project', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectRoot = path.join(agentsHome, 'project-with-codex-hooks');
    fs.mkdirSync(projectRoot, { recursive: true });
    createCodexCompatibleHook('project-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['project-hook'],
        agentSync: { codex: { enabled: ['project-hook'] } },
      }),
      { project: projectRoot }
    );

    const outcome = distributeHooks({ project: projectRoot }, ['codex'], new Set(['codex']));

    assert.ok(fs.existsSync(getProjectCodexHooksJsonPath(projectRoot)));
    assert.ok(
      fs.existsSync(resolveHookStatePath('codex', { project: projectRoot })),
      'project-scoped state file should exist'
    );
    const globalConfigPath = getCodexConfigPath();
    const globalConfig = fs.existsSync(globalConfigPath)
      ? fs.readFileSync(globalConfigPath, 'utf-8')
      : '';
    assert.equal(globalConfig.includes('trust_level = "trusted"'), false);
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.reason?.includes('project is not trusted')
      )
    );
  });
});

test('distributeHooks: codex changed hooks report review requirement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('review-hook');
    enableHooks(['review-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      )
    );
  });
});

test('distributeHooks: filters http handlers for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createHttpHandlerHook('http-hook');
    enableHooks(['http-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'http-hook' &&
          r.reason?.includes('unsupported handler types') &&
          r.reason.includes('http')
      )
    );
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
  });
});

test('distributeHooks: preserves existing user hooks in codex hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
      })
    );

    createCodexCompatibleHook('asb-hook');
    enableHooks(['asb-hook'], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = readJson(hooksJsonPath) as { hooks: Record<string, unknown[]> };
    const commands = groupCommands(
      content.hooks.UserPromptSubmit as Array<Record<string, unknown>>
    );
    assert.deepEqual(commands.sort(), ['echo test-codex', 'echo user-hook']);
  });
});

test('distributeHooks: cleans legacy ASB hooks from codex when selection is empty', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [
                {
                  type: 'command',
                  command: 'echo asb\n# asb-managed-by=agent-switchboard\n# asb-hook-id=old-hook',
                },
              ],
            },
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo legacy' }],
              _asb_source: true,
            },
            { matcher: '', hooks: [{ type: 'command', command: 'echo user' }] },
          ],
        },
        _asb_managed_hooks: ['old-hook'],
        preferredNotifChannel: 'notifications_disabled',
      })
    );

    enableHooks([], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const raw = fs.readFileSync(hooksJsonPath, 'utf-8');
    assert.ok(!raw.includes('_asb'));
    const content = readJson(hooksJsonPath) as { hooks: Record<string, unknown[]> };
    assert.deepEqual(
      groupCommands(content.hooks.UserPromptSubmit as Array<Record<string, unknown>>),
      ['echo user']
    );
    assert.equal(content.preferredNotifChannel, 'notifications_disabled');
  });
});

test('distributeHooks: distributes to both claude-code and codex simultaneously', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code', 'codex');
    createCodexCompatibleHook('shared-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['shared-hook'],
      agentSync: {
        'claude-code': { enabled: ['shared-hook'] },
        codex: { enabled: ['shared-hook'] },
      },
    }));

    const outcome = distributeHooks(undefined, ['claude-code', 'codex']);

    assert.ok(outcome.results.some((r) => r.platform === 'claude-code'));
    assert.ok(outcome.results.some((r) => r.platform === 'codex'));
  });
});

test('distributeHooks: codex bundle hook copies files and rewrites HOOK_DIR portably', () => {
  withTempHomes(({ asbHome }) => {
    const fakeHome = path.dirname(asbHome);
    withHome(fakeHome, () => {
      simulateAppsInstalled('codex');
      createBundleHook('bundle-test');
      enableHooks(['bundle-test'], ['codex']);

      distributeHooks(undefined, ['codex'], new Set(['codex']));

      const content = readJson(getCodexHooksJsonPath()) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      const command = content.hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
      assert.equal(command, '$HOME/agents-home/.codex/hooks/managed/bundle-test/run.sh');
      assert.ok(
        fs.existsSync(path.join(getCodexDir(), 'hooks', 'managed', 'bundle-test', 'run.sh'))
      );
    });
  });
});

test('distributeHooks: foreign-home absolute managed paths are reclaimed as $HOME', () => {
  withTempHomes(({ asbHome }) => {
    const fakeHome = path.dirname(asbHome);
    withHome(fakeHome, () => {
      simulateAppsInstalled('claude-code', 'codex');
      createBundleHook('bundle-test');
      enableHooks(['bundle-test'], ['claude-code', 'codex']);

      // Simulate mackup/dotfile sync that left another machine's absolute home
      // plus the correct portable form and a real user-owned hook.
      const foreignClaude = '/home/ubuntu/.claude/hooks/managed/bundle-test/run.sh';
      const foreignCodex = '/home/ubuntu/.codex/hooks/managed/bundle-test/run.sh';
      const foreignUnknown = '/home/ubuntu/.codex/hooks/managed/not-an-asb-hook/run.sh';

      fs.mkdirSync(path.dirname(claudeSettingsPath()), { recursive: true });
      fs.writeFileSync(
        claudeSettingsPath(),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: foreignClaude }] },
              {
                hooks: [
                  {
                    type: 'command',
                    command: '$HOME/agents-home/.claude/hooks/managed/bundle-test/run.sh',
                  },
                ],
              },
              { hooks: [{ type: 'command', command: 'echo mine' }] },
            ],
          },
        })
      );

      fs.mkdirSync(path.dirname(getCodexHooksJsonPath()), { recursive: true });
      fs.writeFileSync(
        getCodexHooksJsonPath(),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: foreignCodex }] },
              {
                hooks: [
                  {
                    type: 'command',
                    command: '$HOME/agents-home/.codex/hooks/managed/bundle-test/run.sh',
                  },
                ],
              },
              { hooks: [{ type: 'command', command: foreignUnknown }] },
              { hooks: [{ type: 'command', command: 'echo mine' }] },
            ],
          },
        })
      );

      distributeHooks(undefined, ['claude-code', 'codex'], new Set(['claude-code', 'codex']));

      const claudeRaw = fs.readFileSync(claudeSettingsPath(), 'utf-8');
      assert.ok(!claudeRaw.includes('/home/ubuntu'), 'claude foreign absolute home is gone');
      const claudeSettings = readJson(claudeSettingsPath()) as {
        hooks: Record<string, Array<Record<string, unknown>>>;
      };
      assert.deepEqual(groupCommands(claudeSettings.hooks.UserPromptSubmit).sort(), [
        '$HOME/agents-home/.claude/hooks/managed/bundle-test/run.sh',
        'echo mine',
      ]);

      const codexRaw = fs.readFileSync(getCodexHooksJsonPath(), 'utf-8');
      assert.ok(!codexRaw.includes('/home/ubuntu/.codex/hooks/managed/bundle-test'));
      const codexContent = readJson(getCodexHooksJsonPath()) as {
        hooks: Record<string, Array<Record<string, unknown>>>;
      };
      assert.deepEqual(groupCommands(codexContent.hooks.UserPromptSubmit).sort(), [
        '$HOME/agents-home/.codex/hooks/managed/bundle-test/run.sh',
        foreignUnknown,
        'echo mine',
      ]);
    });
  });
});

test('distributeHooks: codex bundle content change reports review even when config is stable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-review-test');
    enableHooks(['bundle-review-test'], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'bundle-review-test', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'skipped' && r.reason === 'up-to-date'
      ),
      'hooks.json itself is unchanged'
    );
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'changed bundle content should still surface the review requirement'
    );
  });
});

test('distributeHooks: executable mode drift is repaired for codex bundles', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-mode-test');
    const sourceScript = path.join(ensureHooksDirectory(), 'bundle-mode-test', 'run.sh');
    fs.chmodSync(sourceScript, 0o755);
    enableHooks(['bundle-mode-test'], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const targetDir = path.join(getCodexDir(), 'hooks', 'managed', 'bundle-mode-test');
    const targetScript = path.join(targetDir, 'run.sh');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === targetDir);

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
  });
});

test('distributeHooks: codex bundle copy failure aborts hooks.json merge', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('broken-bundle');
    const bundleDir = path.join(ensureHooksDirectory(), 'broken-bundle');
    fs.symlinkSync(path.join(bundleDir, 'missing.sh'), path.join(bundleDir, 'broken.sh'));
    enableHooks(['broken-bundle'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'));
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
  });
});

test('distributeHooks: codex writes bundles through a symlinked bundle parent', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-parent-symlink');
    enableHooks(['bundle-parent-symlink'], ['codex']);

    const hooksLink = path.join(getCodexDir(), 'hooks', 'managed');
    const outsideDir = path.join(agentsHome, 'outside-codex-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const targetDir = path.join(hooksLink, 'bundle-parent-symlink');
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === targetDir);

    assert.equal(result?.status, 'written');
    assert.equal(fs.existsSync(path.join(outsideDir, 'bundle-parent-symlink')), true);
    assert.equal(fs.lstatSync(hooksLink).isSymbolicLink(), true);
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), true);
  });
});

test('distributeHooks: codex cleanup scans a symlinked bundle parent, keeping unmanaged dirs', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');

    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo asb' }], _asb_source: true },
          ],
        },
        _asb_managed_hooks: ['stale-hook'],
        preferredNotifChannel: 'notifications_disabled',
      })
    );

    enableHooks([], ['codex']);

    const hooksLink = path.join(getCodexDir(), 'hooks', 'managed');
    const outsideDir = path.join(agentsHome, 'outside-codex-hook-cleanup');
    const outsideStaleDir = path.join(outsideDir, 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find(
      (r) => r.platform === 'codex' && r.entryId === 'stale-hook'
    );

    assert.equal(result?.status, 'skipped');
    assert.equal(result?.reason, 'unmanaged directory');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    const content = readJson(hooksJsonPath);
    assert.ok(!JSON.stringify(content).includes('_asb'), 'config is cleaned');
    assert.equal(content.preferredNotifChannel, 'notifications_disabled');
    assert.ok(!outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'));
  });
});

test('distributeHooks: codex cleanup scans a symlinked app root, keeping unmanaged dirs', () => {
  withTempHomes(({ agentsHome }) => {
    const codexRoot = getCodexDir();
    const outsideRoot = path.join(agentsHome, 'outside-codex-root');
    const outsideStaleDir = path.join(outsideRoot, 'hooks', 'managed', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideRoot, codexRoot);

    enableHooks([], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find(
      (r) => r.platform === 'codex' && r.entryId === 'stale-hook'
    );

    assert.equal(result?.status, 'skipped');
    assert.equal(result?.reason, 'unmanaged directory');
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.ok(!outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'));
  });
});

test('distributeHooks: codex mixed hook keeps supported events/handlers, drops unsupported', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createMixedHook('mixed-hook');
    enableHooks(['mixed-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = readJson(getCodexHooksJsonPath()) as { hooks: Record<string, unknown[]> };
    assert.ok(content.hooks.UserPromptSubmit, 'UserPromptSubmit should be present');
    assert.ok(content.hooks.PreCompact, 'PreCompact should be preserved');
    for (const group of (content.hooks.SessionStart ?? []) as Array<{
      hooks: Array<{ type: string }>;
    }>) {
      for (const h of group.hooks) {
        assert.notEqual(h.type, 'http', 'http handler should be filtered out');
      }
    }
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'mixed-hook' &&
          r.reason?.includes('unsupported handler types') &&
          r.reason.includes('http')
      )
    );
  });
});

test('distributeHooks: codex idempotent re-sync updates ASB hooks without duplication', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('idempotent-hook');
    enableHooks(['idempotent-hook'], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'skipped' && r.reason === 'up-to-date'
      )
    );
    const content = readJson(getCodexHooksJsonPath()) as { hooks: Record<string, unknown[]> };
    assert.equal(content.hooks.UserPromptSubmit.length, 1);
  });
});

test('distributeHooks: codex dryRun writes neither hooks.json nor state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('dryrun-hook');
    enableHooks(['dryrun-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']), { dryRun: true });

    assert.ok(outcome.results.filter((r) => r.platform === 'codex').length > 0);
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
    assert.equal(fs.existsSync(resolveHookStatePath('codex')), false);
  });
});

test('distributeHooks: codex returns error for malformed hooks.json shape', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexHooksJsonPath(), JSON.stringify({ hooks: 'bad-shape' }));
    createCodexCompatibleHook('shape-hook');
    enableHooks(['shape-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'error' && r.error?.includes('invalid shape')
      )
    );
  });
});

test('distributeHooks: codex returns error for malformed hooks.json root', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexHooksJsonPath(), '[]');
    createCodexCompatibleHook('root-shape-hook');
    enableHooks(['root-shape-hook'], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'error' &&
          r.error?.includes('root must be a JSON object')
      )
    );
  });
});

test('distributeHooks: codex defers cleanup and state until hooks.json write succeeds', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(getCodexDir(), 'hooks', 'asb', 'old-bundle');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(path.join(oldBundleDir, 'run.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo asb' }], _asb_source: true },
          ],
        },
        preferredNotifChannel: 'notifications_disabled',
      })
    );
    const before = fs.readFileSync(hooksJsonPath, 'utf-8');

    enableHooks([], ['codex']);

    fs.chmodSync(getCodexDir(), 0o555);
    try {
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

      assert.ok(
        outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'),
        'write failure should be reported'
      );
      assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), before, 'config left as-is');
      assert.ok(fs.existsSync(oldBundleDir), 'orphan bundle remains when write fails');
    } finally {
      fs.chmodSync(getCodexDir(), 0o755);
    }
  });
});

test('distributeHooks: codex deletes empty hooks.json and evidenced legacy bundles', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(getCodexDir(), 'hooks', 'asb', 'legacy-bundle');
    const oldBundleScript = path.join(oldBundleDir, 'run.sh');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(oldBundleScript, '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: oldBundleScript }] },
          ],
        },
      })
    );

    enableHooks([], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'deleted' && r.filePath === hooksJsonPath
      )
    );
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'deleted' && r.entryId === 'legacy-bundle'
      )
    );
    assert.equal(fs.existsSync(hooksJsonPath), false);
    assert.equal(fs.existsSync(path.join(getCodexDir(), 'hooks', 'asb')), false);
  });
});

test('distributeHooks: codex reports unevidenced legacy dirs instead of deleting them', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const strayDir = path.join(getCodexDir(), 'hooks', 'asb', 'stray-bundle');
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(path.join(strayDir, 'run.sh'), '#!/bin/sh\necho stray\n');

    enableHooks([], ['codex']);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'stray-bundle' &&
          r.reason?.includes('unrecognized entry in legacy hooks directory')
      )
    );
    assert.equal(fs.existsSync(strayDir), true);
  });
});

test('distributeHooks: codex reports hooks.json delete failure as error', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo asb' }], _asb_source: true },
          ],
        },
      })
    );

    enableHooks([], ['codex']);

    const originalUnlinkSync = fs.unlinkSync;
    try {
      fs.unlinkSync = ((target: fs.PathLike) => {
        if (path.resolve(String(target)) === hooksJsonPath) {
          throw new Error('mock hooks.json delete failure');
        }
        return originalUnlinkSync(target);
      }) as typeof fs.unlinkSync;

      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

      assert.ok(
        outcome.results.some(
          (r) =>
            r.platform === 'codex' &&
            r.status === 'error' &&
            r.error?.includes('mock hooks.json delete failure')
        )
      );
      assert.equal(fs.existsSync(hooksJsonPath), true);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
  });
});

test('distributeHooks: codex empties a symlinked hooks.json instead of unlinking it', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('codex');
    const mackupDir = path.join(asbHome, 'mackup');
    fs.mkdirSync(mackupDir, { recursive: true });
    const realHooksJson = path.join(mackupDir, 'hooks.json');
    fs.writeFileSync(
      realHooksJson,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo asb' }], _asb_source: true },
          ],
        },
      })
    );
    fs.symlinkSync(realHooksJson, getCodexHooksJsonPath());

    enableHooks([], ['codex']);

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(fs.lstatSync(getCodexHooksJsonPath()).isSymbolicLink(), 'symlink survives');
    assert.deepEqual(readJson(realHooksJson), {}, 'real file is emptied, not deleted');
  });
});

test('codex target registry hooks handler delegates to Codex distributor', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const target = getTargetById('codex');
    assert.ok(target?.hooks, 'codex target should expose hooks handler');

    const outcome = target.hooks.distribute({
      selected: [
        {
          id: 'registry-hook',
          bareId: 'registry-hook',
          source: 'test',
          filePath: path.join(ensureHooksDirectory(), 'registry-hook.json'),
          isBundle: false,
          hooks: {
            UserPromptSubmit: [
              { matcher: '', hooks: [{ type: 'command', command: 'echo registry' }] },
            ],
          },
        },
      ],
    });

    assert.ok(fs.existsSync(getCodexHooksJsonPath()), 'registry handler should write hooks.json');
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      )
    );
  });
});
