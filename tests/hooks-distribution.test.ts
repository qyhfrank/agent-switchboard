/**
 * Tests: distributeHooks respects isInstalled check and supports multiple targets.
 */
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  getClaudeDir,
  getCodexConfigPath,
  getCodexDir,
  getCodexHooksJsonPath,
  getProjectClaudeDir,
  getProjectCodexDir,
  getProjectCodexHooksJsonPath,
} from '../src/config/paths.js';
import { captureBundleTreeFingerprint } from '../src/hooks/bundle-cleanup.js';
import { distributeHooks } from '../src/hooks/distribution.js';
import { ensureHooksDirectory } from '../src/hooks/library.js';
import {
  loadManagedHookGroups,
  markLegacyHookBundleCleanup,
  resolveManagedHookStatePath,
  resolveManagedHookTransactionAddress,
  saveManagedHookGroups,
  withManagedHookLock,
} from '../src/hooks/managed-state.js';
import { updateLibraryStateSection } from '../src/library/state.js';
import { getTargetById } from '../src/targets/registry.js';
import { runCli, stripAnsi } from './helpers/cli.js';
import { simulateAppsInstalled, withTempHomes } from './helpers/tmp.js';

function createHookEntry(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Test hook ${id}`,
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo test' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function failSecondStateCommit(statePath: string, operation: () => void): void {
  const originalRenameSync = fs.renameSync;
  let commits = 0;
  try {
    fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(newPath)) === statePath) {
        commits += 1;
        if (commits === 2) throw new Error('mock managed state commit failure');
      }
      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync;
    operation();
  } finally {
    fs.renameSync = originalRenameSync;
  }
}

function withAnchoredRemovalIntercept<T>(
  intercept: (targetPath: string) => void,
  operation: () => T
): T {
  const originalExecFileSync = childProcess.execFileSync;
  try {
    childProcess.execFileSync = ((
      file: string,
      args?: readonly string[],
      options?: { cwd?: string | URL; env?: NodeJS.ProcessEnv }
    ) => {
      const name = options?.env?.ASB_BUNDLE_NAME;
      if (file === process.execPath && typeof options?.cwd === 'string' && name) {
        intercept(path.join(options.cwd, name));
      }
      return originalExecFileSync(file, args as string[] | undefined, options as never);
    }) as typeof childProcess.execFileSync;
    syncBuiltinESMExports();
    return operation();
  } finally {
    childProcess.execFileSync = originalExecFileSync;
    syncBuiltinESMExports();
  }
}

function configSnapshotHash(content?: string): string {
  const hash = createHash('sha256');
  hash.update(content === undefined ? 'missing\0' : 'present\0');
  if (content !== undefined) hash.update(content);
  return hash.digest('hex');
}

function assertNoAsbOwnershipTokens(value: unknown): void {
  assert.doesNotMatch(
    typeof value === 'string' ? value : JSON.stringify(value),
    /hooks[/\\]asb|_asb|asb-managed|asb-hook-id|asb-bundle-sha256|hook-bundle-sha256/i
  );
}

function managedBundleNamespace(
  seed: string,
  target: 'claude-code' | 'codex',
  configPath: string,
  projectRoot?: string
): string {
  return createHash('sha256')
    .update(seed)
    .update('\0')
    .update(path.basename(resolveManagedHookStatePath(target, configPath, projectRoot)))
    .digest('hex');
}

function claudeManagedBundleNamespace(): string {
  return managedBundleNamespace(
    'agent-switchboard\0claude-code\0hooks',
    'claude-code',
    path.join(getClaudeDir(), 'settings.json')
  );
}

function codexManagedBundleNamespace(): string {
  return managedBundleNamespace(
    'agent-switchboard\0codex\0hooks',
    'codex',
    getCodexHooksJsonPath()
  );
}

function claudeManagedBundleRoot(): string {
  return path.join(getClaudeDir(), 'hooks', 'managed', claudeManagedBundleNamespace());
}

function claudeBundleTargetDir(_entryId: string): string {
  const settings = JSON.parse(
    fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8')
  ) as { hooks: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>> };
  for (const groups of Object.values(settings.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) {
        for (const field of ['command', 'commandWindows', 'command_windows']) {
          const command = handler[field];
          if (typeof command !== 'string' || !command.includes('/hooks/managed/')) continue;
          const match = command.match(/(?:\$HOME|\/)[^"'\s]*hooks\/managed\/[^"'\s]+/);
          if (match) return path.dirname(match[0].replace('$HOME', os.homedir()));
        }
      }
    }
  }
  throw new Error('Claude managed bundle command not found');
}

function codexManagedBundleRoot(): string {
  return path.join(getCodexDir(), 'hooks', 'managed', codexManagedBundleNamespace());
}

function writePendingManagedState(
  target: 'claude-code' | 'codex',
  configPath: string,
  previousConfig: string,
  desiredConfig: string,
  previous: Record<string, unknown[]>,
  desired: Record<string, unknown[]>
): void {
  const statePath = resolveManagedHookStatePath(target, configPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      version: 1,
      hooks: previous,
      prefixLengths: Object.fromEntries(Object.keys(previous).map((event) => [event, 0])),
      pending: {
        desired,
        desiredPrefixLengths: Object.fromEntries(Object.keys(desired).map((event) => [event, 0])),
        previousConfigHash: configSnapshotHash(previousConfig),
        desiredConfigHash: configSnapshotHash(desiredConfig),
      },
    })
  );
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

test('distributeHooks: skips when claude-code not installed and not in assumeInstalled', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled() so claude-code appears uninstalled
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(outcome.results.length, 0, 'should produce no results when not installed');
  });
});

test('distributeHooks: distributes when claude-code is in assumeInstalled', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled() so claude-code appears uninstalled
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code'], new Set(['claude-code']));

    assert.ok(outcome.results.length > 0, 'should produce results when assumed installed');
  });
});

test('distributeHooks: distributes when claude-code is actually installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createHookEntry('test-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['test-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.length > 0, 'should produce results when installed');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    assert.doesNotMatch(settings, /asb/i);
    assert.ok(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)));
  });
});

test('distributeHooks: claude-code rejects semantically invalid hook groups without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const original = '{"hooks":{"UserPromptSubmit":[{}]},"theme":"dark"}\n';
    fs.writeFileSync(settingsPath, original);
    createHookEntry('invalid-settings-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['invalid-settings-hook'],
      agentSync: {},
    }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'claude-code' &&
          result.status === 'error' &&
          result.error?.includes('invalid hook configuration')
      )
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), original);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: claude-code rejects explicit null hooks without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const original = '{"hooks":null,"theme":"dark"}\n';
    fs.writeFileSync(settingsPath, original);
    createHookEntry('null-settings-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['null-settings-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), original);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: claude-code requires handler type fields without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const invalidHandlers = [
      { type: 'command' },
      { type: 'http' },
      { type: 'prompt' },
      { type: 'agent' },
    ];
    for (const handler of invalidHandlers) {
      const original = `${JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [handler] }] },
      })}\n`;
      fs.writeFileSync(settingsPath, original);

      const outcome = distributeHooks(undefined, ['claude-code']);

      assert.ok(
        outcome.results.some((result) => result.status === 'error'),
        JSON.stringify(outcome.results)
      );
      assert.equal(fs.readFileSync(settingsPath, 'utf-8'), original);
    }
  });
});

test('distributeHooks: claude-code rejects conflicting Windows command aliases', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const original = `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo user',
                commandWindows: 'echo first',
                command_windows: 'echo second',
              },
            ],
          },
        ],
      },
    })}\n`;
    fs.writeFileSync(settingsPath, original);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), original);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: claude-code strips legacy command metadata from managed hooks', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const id = 'legacy-command-metadata';
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), `${id}.json`),
      JSON.stringify({
        name: id,
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: [
                    'echo managed',
                    CODEX_ASB_MANAGED_MARKER,
                    codexAsbHookIdMarker(id),
                    `# asb-bundle-sha256=${'a'.repeat(64)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [id], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    const settings = fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8');
    assert.doesNotMatch(settings, /asb-managed-by|asb-hook-id|asb-bundle-sha256/);
    assert.match(settings, /echo managed/);
  });
});

test('distributeHooks: claude-code removes disabled standalone hooks from external state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
      })
    );
    createHookEntry('managed-standalone');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['managed-standalone'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(settings.hooks.PreToolUse, [
      { matcher: 'Read', hooks: [{ type: 'command', command: 'echo user-hook' }] },
    ]);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
    assert.ok(!JSON.stringify(settings).includes('_asb_'));
  });
});

test('distributeHooks: claude-code preserves an identical user hook across resync and disable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const userGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo test' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
    createHookEntry('identical-managed-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['identical-managed-hook'],
      agentSync: {},
    }));

    distributeHooks(undefined, ['claude-code']);
    distributeHooks(undefined, ['claude-code']);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(settings.hooks.PreToolUse, [userGroup]);
  });
});

test('distributeHooks: claude-code preserves a user hook appended after the managed segment', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const appendedUserGroup = {
      matcher: 'Write',
      hooks: [{ type: 'command', command: 'echo appended-user' }],
    };
    createHookEntry('managed-before-user-tail');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['managed-before-user-tail'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    settings.hooks.PreToolUse.push(appendedUserGroup);
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

    const resync = distributeHooks(undefined, ['claude-code']);
    assert.ok(resync.results.every((result) => result.status !== 'conflict'));
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);

    const disabled = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(disabled.hooks.PreToolUse, [appendedUserGroup]);
  });
});

test('distributeHooks: claude-code rolls back when final managed state commit fails', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const original = '{"theme":"dark"}\n';
    fs.writeFileSync(settingsPath, original);
    createHookEntry('state-failure-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['state-failure-hook'], agentSync: {} }));
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    let outcome: ReturnType<typeof distributeHooks> | undefined;

    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['claude-code']);
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.ok(!outcome?.results.some((result) => result.status === 'written'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), original);
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('distributeHooks: rollback preserves a concurrent config replacement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const realSettingsPath = fs.realpathSync.native(settingsPath);
    createHookEntry('rollback-concurrent-update');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['rollback-concurrent-update'],
      agentSync: {},
    }));
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);

    const originalRenameSync = fs.renameSync;
    const originalWriteFileSync = fs.writeFileSync;
    let stateCommits = 0;
    let configSwaps = 0;
    let injected = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const oldResolved = path.resolve(String(oldPath));
        const newResolved = path.resolve(String(newPath));
        if (newResolved === statePath) {
          stateCommits += 1;
          if (stateCommits === 2) throw new Error('mock final managed state failure');
        }
        if (oldResolved === realSettingsPath) {
          configSwaps += 1;
          if (configSwaps === 2) {
            injected = true;
            originalWriteFileSync(settingsPath, '{"theme":"light"}\n');
          }
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' &&
            result.error?.includes('rollback failed: application config changed during hook sync')
        )
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(injected, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"light"}\n');
    assert.equal(fs.existsSync(statePath), true);
  });
});

test('distributeHooks: config commit and rollback preserve the original file mode', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    fs.chmodSync(settingsPath, 0o660);
    createHookEntry('mode-preserving-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['mode-preserving-hook'],
      agentSync: {},
    }));
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const previousUmask = process.umask(0o027);
    try {
      failSecondStateCommit(statePath, () => {
        distributeHooks(undefined, ['claude-code']);
      });
      assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o660);

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(outcome.results.some((result) => result.status === 'written'));
      assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o660);
    } finally {
      process.umask(previousUmask);
    }
  });
});

test('distributeHooks: claude-code reports managed standalone drift without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const identicalUserGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo test' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [identicalUserGroup] } }));
    createHookEntry('drifted-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['drifted-hook'], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    const managedGroup = settings.hooks.PreToolUse[settings.hooks.PreToolUse.length - 1];
    assert.ok(managedGroup);
    managedGroup.hooks[0].timeout = 99;
    (managedGroup as Record<string, unknown>)._asb_source = true;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const before = fs.readFileSync(settingsPath, 'utf-8');

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), before);
  });
});

test('distributeHooks: claude-code does not consume an identical user group after suffix loss', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const userGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo test' }],
    };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
    createHookEntry('lost-managed-suffix');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['lost-managed-suffix'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    settings.hooks.PreToolUse.pop();
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const before = fs.readFileSync(settingsPath, 'utf-8');

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), before);
    assert.deepEqual(
      (JSON.parse(before) as { hooks: Record<string, unknown[]> }).hooks.PreToolUse,
      [userGroup]
    );
  });
});

test('distributeHooks: claude-code removes legacy ownership metadata from settings.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              _asb_source: true,
              hooks: [
                {
                  type: 'command',
                  command: `${path.join(getClaudeDir(), 'hooks', 'asb', 'old-hook', 'run.sh')}`,
                },
              ],
            },
            { hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
        _asb_managed_hooks: ['old-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    assert.deepEqual(
      (settings.hooks.UserPromptSubmit[0]?.hooks as Array<{ command: string }>)[0]?.command,
      'echo user-hook'
    );
    assert.ok(!JSON.stringify(settings).includes('_asb_'));
  });
});

test('distributeHooks: claude-code migrates legacy hooks after their definition changes', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: 'echo old' }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['changed-legacy'],
      })
    );
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'changed-legacy.json'),
      JSON.stringify({
        name: 'changed-legacy',
        hooks: {
          PreToolUse: [
            { matcher: 'Read', hooks: [{ type: 'command', command: 'echo new-read' }] },
            { matcher: 'Write', hooks: [{ type: 'command', command: 'echo new-write' }] },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: ['changed-legacy'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.every((result) => result.status !== 'conflict' && result.status !== 'error')
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assertNoAsbOwnershipTokens(settings);
    assert.ok(!JSON.stringify(settings).includes('echo old'));
  });
});

test('distributeHooks: claude-code removes an empty legacy ownership key', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: {}, _asb_managed_hooks: [] }));
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    assert.equal(settings._asb_managed_hooks, undefined);
  });
});

test('distributeHooks: claude-code migrates Windows-style legacy bundle paths', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const legacyCommand = `${path
      .join(getClaudeDir(), 'hooks', 'asb', 'legacy-hook', 'run.cmd')
      .replaceAll('/', '\\')}`;
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: legacyCommand }] }],
        },
        _asb_managed_hooks: ['legacy-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
    assertNoAsbOwnershipTokens(settings);
    assert.ok(!JSON.stringify(settings).includes('legacy-hook'));
  });
});

test('distributeHooks: claude-code migrates legacy bundle paths from Windows command overrides', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              _asb_source: true,
              hooks: [
                {
                  type: 'command',
                  command: 'echo fallback',
                  commandWindows: '& "$HOME\\.claude\\hooks\\asb\\legacy\\run.ps1"',
                },
              ],
            },
          ],
        },
        _asb_managed_hooks: ['legacy'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.SessionStart, undefined);
    assertNoAsbOwnershipTokens(settings);
  });
});

test('distributeHooks: claude-code removes only legacy handlers from mixed groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [
                {
                  type: 'command',
                  command: path.join(getClaudeDir(), 'hooks', 'asb', 'legacy', 'run.sh'),
                },
                { type: 'command', command: 'echo user' },
              ],
            },
          ],
        },
        _asb_managed_hooks: ['legacy'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    assert.deepEqual(settings.hooks.SessionStart, [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user' }] },
    ]);
    assertNoAsbOwnershipTokens(settings);
  });
});

test('distributeHooks: claude-code removes legacy-marked multi-handler groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const handlers = [
      { type: 'command', command: 'echo legacy' },
      { type: 'command', command: 'echo user' },
    ];
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: handlers, _asb_source: true }] },
        _asb_managed_hooks: ['legacy'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.SessionStart, undefined);
    assertNoAsbOwnershipTokens(settings);
  });
});

test('distributeHooks: claude-code preserves unowned relocated asb-like paths', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const foreignCommand = path.join(
      agentsHome,
      'foreign',
      '.claude',
      'hooks',
      'asb',
      'user-hook',
      'run.sh'
    );
    const localSameId = path.join(getClaudeDir(), 'hooks', 'asb', 'user-hook');
    fs.mkdirSync(localSameId, { recursive: true });
    fs.writeFileSync(path.join(localSameId, 'keep.txt'), 'local user directory\n');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: foreignCommand }] }],
        },
        _asb_managed_hooks: ['user-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, foreignCommand);
    assert.equal(
      fs.readFileSync(path.join(localSameId, 'keep.txt'), 'utf-8'),
      'local user directory\n'
    );
  });
});

test('distributeHooks: claude-code does not match a canonical legacy path inside another token', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const canonicalLegacyPath = path.join(getClaudeDir(), 'hooks', 'asb', 'user-hook', 'run.sh');
    const command = `/Volumes/Backup${canonicalLegacyPath}`;
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, command);
  });
});

test('distributeHooks: rewrites plugin hook CLAUDE_PLUGIN_ROOT references to distributed hook paths', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);
    assert.ok(outcome.results.length > 0, 'should produce distribution results');

    const settings = JSON.parse(
      fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8')
    ) as {
      hooks: {
        SessionStart: Array<{
          hooks: Array<{
            command?: string;
          }>;
        }>;
      };
    };

    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command;
    const expectedPath = path.join(claudeBundleTargetDir(hookId), 'run-hook.cmd');
    const portablePath = expectedPath.replace(os.homedir(), '$HOME');

    assert.equal(command, `"${portablePath}" session-start`);
    assertNoAsbOwnershipTokens(settings);
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
          sessionStart: [
            {
              type: 'command',
              bash: 'node "hooks/start.js"',
              powershell: 'node "hooks\\start.js"',
              timeoutSec: 5,
            },
          ],
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
    updateLibraryStateSection('hooks', () => ({ enabled: ['standalone:hooks'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code'], new Set(['claude-code']), {
      dryRun: true,
    });

    assert.ok(outcome.results.length > 0, 'should continue distribution');
    assert.ok(outcome.results.every((r) => r.status !== 'error'));
  });
});

test('distributeHooks: executable mode drift is repaired for claude-code bundles', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const { pluginDir, hookId } = createPluginHookSource(asbHome);
    const sourceScript = path.join(pluginDir, 'hooks', 'run-hook.cmd');
    fs.chmodSync(sourceScript, 0o755);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);
    const targetDir = claudeBundleTargetDir(hookId);
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

test('distributeHooks: first config creation cleans an orphan managed bundle', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const staleDir = path.join(claudeManagedBundleRoot(), 'stale-before-config');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'run.sh'), '#!/bin/sh\n');
    createHookEntry('first-config-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['first-config-hook'],
      agentSync: {},
    }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(staleDir), false);
    assert.equal(fs.existsSync(path.join(getClaudeDir(), 'settings.json')), true);
  });
});

test('distributeHooks: claude-code bundle state is idempotent and cleans on disable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-bundle-lifecycle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-bundle-lifecycle'],
      agentSync: {},
    }));
    const settingsPath = path.join(getClaudeDir(), 'settings.json');

    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('claude-bundle-lifecycle');
    distributeHooks(undefined, ['claude-code']);
    const active = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(active.hooks.UserPromptSubmit.length, 1);
    assert.equal(fs.existsSync(bundleDir), true);

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);
    const disabled = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(disabled.hooks.UserPromptSubmit, undefined);
    assert.equal(fs.existsSync(bundleDir), false);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: claude-code bundle cleanup is isolated by config identity', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const targetA = path.join(agentsHome, 'claude-settings-a.json');
    const targetB = path.join(agentsHome, 'claude-settings-b.json');
    if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    fs.writeFileSync(targetA, '{}\n');
    fs.writeFileSync(targetB, '{}\n');
    fs.symlinkSync(targetA, settingsPath);
    createBundleHook('claude-config-identity-bundle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-config-identity-bundle'],
      agentSync: {},
    }));

    distributeHooks(undefined, ['claude-code']);
    const bundleA = claudeBundleTargetDir('claude-config-identity-bundle');
    assert.equal(fs.existsSync(bundleA), true);

    fs.unlinkSync(settingsPath);
    fs.symlinkSync(targetB, settingsPath);
    distributeHooks(undefined, ['claude-code']);
    const bundleB = claudeBundleTargetDir('claude-config-identity-bundle');
    assert.notEqual(bundleB, bundleA);
    assert.equal(fs.existsSync(bundleB), true);

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));
    distributeHooks(undefined, ['claude-code']);

    assert.equal(fs.existsSync(bundleA), true);
    assert.equal(fs.existsSync(bundleB), false);
  });
});

test('distributeHooks: claude-code orphan quarantine does not follow a replacement symlink', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-orphan-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-orphan-race'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('claude-orphan-race');
    const outside = path.join(agentsHome, 'claude-orphan-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'protected\n');
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRenameSync(oldPath, newPath);
        if (!swapped && path.resolve(String(oldPath)) === path.resolve(bundleDir)) {
          swapped = true;
          fs.symlinkSync(outside, bundleDir);
        }
        return result;
      }) as typeof fs.renameSync;
      distributeHooks(undefined, ['claude-code']);
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8'), 'protected\n');
    assert.equal(fs.lstatSync(bundleDir).isSymbolicLink(), true);
  });
});

test('distributeHooks: orphan deletion does not follow a swapped quarantine path', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-quarantine-swap');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-quarantine-swap'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const outsideDir = path.join(agentsHome, 'outside-quarantine-swap');
    const outsideFile = path.join(outsideDir, 'keep.txt');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'protected\n');
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    let swapped = false;
    let quarantinePath: string | undefined;
    withAnchoredRemovalIntercept(
      (target) => {
        if (!swapped && path.basename(target).startsWith('.delete.')) {
          swapped = true;
          quarantinePath = target;
          fs.rmSync(target, { recursive: true, force: false });
          fs.symlinkSync(outsideDir, target);
        }
      },
      () => {
        distributeHooks(undefined, ['claude-code']);
      }
    );

    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'protected\n');
    const retried = distributeHooks(undefined, ['claude-code']);
    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.ok(quarantinePath);
    assert.equal(fs.lstatSync(quarantinePath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'protected\n');
  });
});

test('distributeHooks: claude-code failed orphan deletion preserves a concurrent replacement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-orphan-delete-failure');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-orphan-delete-failure'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('claude-orphan-delete-failure');
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    let replaced = false;
    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (!replaced && path.basename(target).startsWith('.delete.')) {
          replaced = true;
          fs.writeFileSync(bundleDir, 'concurrent replacement\n');
          throw new Error('mock quarantined orphan delete failure');
        }
      },
      () => distributeHooks(undefined, ['claude-code'])
    );
    assert.ok(outcome.results.some((result) => result.status === 'error'));

    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(bundleDir, 'utf-8'), 'concurrent replacement\n');
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));

    const retried = distributeHooks(undefined, ['claude-code']);

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.readFileSync(bundleDir, 'utf-8'), 'concurrent replacement\n');
  });
});

test('distributeHooks: claude-code keeps a bundle restored by a concurrent config edit', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-concurrent-config-cleanup');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-concurrent-config-cleanup'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const previousConfig = fs.readFileSync(settingsPath, 'utf-8');
    const bundleDir = claudeBundleTargetDir('claude-concurrent-config-cleanup');
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const originalReaddirSync = fs.readdirSync;
    let edited = false;
    try {
      fs.readdirSync = ((target: fs.PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
        if (!edited && path.resolve(String(target)) === path.resolve(bundleParent)) {
          edited = true;
          fs.writeFileSync(settingsPath, previousConfig);
        }
        return originalReaddirSync(target, options as never);
      }) as typeof fs.readdirSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(outcome.results.some((result) => result.status === 'error'));
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(edited, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), previousConfig);
    assert.equal(fs.existsSync(bundleDir), true);
  });
});

test('distributeHooks: claude-code drift conflict does not update bundle files', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-drifted-bundle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-drifted-bundle'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    settings.hooks.UserPromptSubmit[0].timeout = 99;
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'claude-drifted-bundle', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );
    const targetScript = path.join(claudeBundleTargetDir('claude-drifted-bundle'), 'run.sh');

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(targetScript, 'utf-8'), '#!/bin/sh\necho test\n');
  });
});

test('distributeHooks: claude-code bundle update keeps the active bundle on state failure', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-bundle-state-failure');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-bundle-state-failure'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const originalConfig = fs.readFileSync(settingsPath, 'utf-8');
    const originalBundleDir = claudeBundleTargetDir('claude-bundle-state-failure');
    const originalScript = path.join(originalBundleDir, 'run.sh');
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'claude-bundle-state-failure', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );

    let outcome: ReturnType<typeof distributeHooks> | undefined;
    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['claude-code']);
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), originalConfig);
    assert.equal(claudeBundleTargetDir('claude-bundle-state-failure'), originalBundleDir);
    assert.equal(fs.readFileSync(originalScript, 'utf-8'), '#!/bin/sh\necho test\n');
  });
});

test('distributeHooks: claude-code mode update keeps the active bundle on state failure', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-bundle-mode-failure');
    const sourceScript = path.join(ensureHooksDirectory(), 'claude-bundle-mode-failure', 'run.sh');
    fs.chmodSync(sourceScript, 0o644);
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-bundle-mode-failure'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const originalConfig = fs.readFileSync(settingsPath, 'utf-8');
    const originalBundleDir = claudeBundleTargetDir('claude-bundle-mode-failure');
    const originalScript = path.join(originalBundleDir, 'run.sh');
    assert.equal(fs.statSync(originalScript).mode & 0o111, 0);
    fs.chmodSync(sourceScript, 0o755);

    let outcome: ReturnType<typeof distributeHooks> | undefined;
    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['claude-code']);
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), originalConfig);
    assert.equal(claudeBundleTargetDir('claude-bundle-mode-failure'), originalBundleDir);
    assert.equal(fs.statSync(originalScript).mode & 0o111, 0);
  });
});

test('distributeHooks: claude-code deploys the captured bundle snapshot when the source races', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-bundle-source-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-bundle-source-race'],
      agentSync: {},
    }));
    const sourceScript = path.join(ensureHooksDirectory(), 'claude-bundle-source-race', 'run.sh');
    fs.writeFileSync(sourceScript, '#!/bin/sh\necho captured\n');
    const originalMkdtempSync = fs.mkdtempSync;
    try {
      fs.mkdtempSync = ((prefix: string, options?: BufferEncoding | null) => {
        if (prefix.includes('asb-hooks-')) {
          fs.writeFileSync(sourceScript, '#!/bin/sh\necho raced\n');
        }
        return originalMkdtempSync(prefix, options as BufferEncoding);
      }) as typeof fs.mkdtempSync;
      distributeHooks(undefined, ['claude-code']);
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
    }

    const targetScript = path.join(claudeBundleTargetDir('claude-bundle-source-race'), 'run.sh');
    assert.equal(fs.readFileSync(targetScript, 'utf-8'), '#!/bin/sh\necho captured\n');
    assert.equal(fs.readFileSync(sourceScript, 'utf-8'), '#!/bin/sh\necho raced\n');
  });
});

test('distributeHooks: claude-code uses hook definitions from the captured bundle', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const id = 'claude-definition-race';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional hook placeholder
    const hookDirPlaceholder = '${HOOK_DIR}';
    const bundleDir = path.join(ensureHooksDirectory(), id);
    const hookJsonPath = path.join(bundleDir, 'hook.json');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'old.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hookJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: `${hookDirPlaceholder}/old.sh` }] }],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [id], agentSync: {} }));

    const originalReadFileSync = fs.readFileSync;
    let swapped = false;
    try {
      fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
        const value = originalReadFileSync(file, options as never);
        if (!swapped && path.resolve(String(file)) === hookJsonPath) {
          swapped = true;
          fs.unlinkSync(path.join(bundleDir, 'old.sh'));
          fs.writeFileSync(path.join(bundleDir, 'new.sh'), '#!/bin/sh\necho new\n');
          fs.writeFileSync(
            hookJsonPath,
            JSON.stringify({
              hooks: {
                SessionStart: [
                  { hooks: [{ type: 'command', command: `${hookDirPlaceholder}/new.sh` }] },
                ],
              },
            })
          );
        }
        return value;
      }) as typeof fs.readFileSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(outcome.results.every((result) => result.status !== 'error'));
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    const settings = JSON.parse(
      fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8')
    ) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? '';
    assert.match(command, /new\.sh$/);
    assert.equal(fs.existsSync(command.replace('$HOME', os.homedir())), true);
    assert.doesNotMatch(command, /old\.sh$/);
  });
});

test('distributeHooks: claude-code partial bundle copy does not change the active bundle', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    createBundleHook('claude-partial-bundle');
    const sourceDir = path.join(ensureHooksDirectory(), 'claude-partial-bundle');
    fs.writeFileSync(path.join(sourceDir, 'a.sh'), 'a-v1\n');
    fs.writeFileSync(path.join(sourceDir, 'b.sh'), 'b-v1\n');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['claude-partial-bundle'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const originalConfig = fs.readFileSync(settingsPath, 'utf-8');
    const originalBundleDir = claudeBundleTargetDir('claude-partial-bundle');
    fs.writeFileSync(path.join(sourceDir, 'a.sh'), 'a-v2\n');
    fs.writeFileSync(path.join(sourceDir, 'b.sh'), 'b-v2\n');

    const originalWriteFileSync = fs.writeFileSync;
    let failed = false;
    let outcome: ReturnType<typeof distributeHooks> | undefined;
    try {
      fs.writeFileSync = ((
        target: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView
      ) => {
        if (
          !failed &&
          typeof target === 'string' &&
          target.includes(`${path.sep}hooks${path.sep}managed${path.sep}`) &&
          path.basename(target) === 'b.sh'
        ) {
          failed = true;
          throw new Error('mock partial bundle copy failure');
        }
        return originalWriteFileSync(target, data);
      }) as typeof fs.writeFileSync;
      outcome = distributeHooks(undefined, ['claude-code']);
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(failed, true);
    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), originalConfig);
    assert.equal(fs.readFileSync(path.join(originalBundleDir, 'a.sh'), 'utf-8'), 'a-v1\n');
    assert.equal(fs.readFileSync(path.join(originalBundleDir, 'b.sh'), 'utf-8'), 'b-v1\n');
  });
});

test('distributeHooks: claude-code rejects symlinked bundle parent before settings merge', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    const hooksLink = claudeManagedBundleRoot();
    const outsideDir = path.join(agentsHome, 'outside-claude-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === hooksLink
    );

    assert.equal(
      fs.existsSync(path.join(outsideDir, createHash('sha256').update(hookId).digest('hex'))),
      false
    );
    assert.equal(fs.existsSync(path.join(getClaudeDir(), 'settings.json')), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked/);
  });
});

test('distributeHooks: claude-code rejects symlinked hook ancestor before settings merge', () => {
  withTempHomes(({ asbHome, agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const { hookId } = createPluginHookSource(asbHome);
    updateLibraryStateSection('hooks', () => ({ enabled: [hookId], agentSync: {} }));

    const hooksLink = path.join(getClaudeDir(), 'hooks');
    const outsideHooksDir = path.join(agentsHome, 'outside-claude-hooks-ancestor');
    fs.mkdirSync(outsideHooksDir, { recursive: true });
    fs.mkdirSync(path.join(outsideHooksDir, 'managed'), { recursive: true });
    fs.symlinkSync(outsideHooksDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) =>
        r.platform === 'claude-code' &&
        r.targetDir === path.join(hooksLink, 'managed', claudeManagedBundleNamespace())
    );

    assert.equal(
      fs.existsSync(
        path.join(
          outsideHooksDir,
          'managed',
          claudeManagedBundleNamespace(),
          createHash('sha256').update(hookId).digest('hex')
        )
      ),
      false
    );
    assert.equal(fs.existsSync(path.join(getClaudeDir(), 'settings.json')), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /refusing to follow symlinked path/);
  });
});

test('distributeHooks: claude-code does not clean unowned legacy bundle parents', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const hooksLink = path.join(getClaudeDir(), 'hooks', 'asb');
    const outsideDir = path.join(agentsHome, 'outside-claude-hook-cleanup');
    const outsideStaleDir = path.join(outsideDir, 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) => r.platform === 'claude-code' && r.targetDir === hooksLink
    );

    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(fs.lstatSync(hooksLink).isSymbolicLink(), true);
    assert.equal(result, undefined);
  });
});

test('distributeHooks: claude-code does not infer bundle ownership from a legacy standalone ID', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const unrelatedDir = path.join(getClaudeDir(), 'hooks', 'asb', 'legacy-standalone');
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, 'keep.txt'), 'unrelated directory\n');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        theme: 'dark',
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: 'command', command: 'echo standalone' }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['legacy-standalone'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(
      fs.readFileSync(path.join(unrelatedDir, 'keep.txt'), 'utf-8'),
      'unrelated directory\n'
    );
    assertNoAsbOwnershipTokens(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')));
  });
});

test('distributeHooks: claude-code retargeting does not clean legacy bundles owned by old config', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const targetA = path.join(agentsHome, 'legacy-claude-target-a.json');
    const targetB = path.join(agentsHome, 'legacy-claude-target-b.json');
    const legacyDir = path.join(getClaudeDir(), 'hooks', 'asb', 'legacy-retarget');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      targetA,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['legacy-retarget'],
      })
    );
    fs.writeFileSync(targetB, '{}\n');
    if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
    fs.symlinkSync(targetA, settingsPath);
    fs.unlinkSync(settingsPath);
    fs.symlinkSync(targetB, settingsPath);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    assert.equal(fs.existsSync(legacyScript), true);
    assert.match(fs.readFileSync(targetA, 'utf-8'), /hooks[/\\]asb/);
  });
});

test('distributeHooks: claude-code cleans only canonical legacy bundles for a config alias', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectA = path.join(agentsHome, 'legacy-owner-claude-a');
    const projectB = path.join(agentsHome, 'legacy-owner-claude-b');
    const aliasPath = path.join(getProjectClaudeDir(projectA), 'settings.local.json');
    const targetPath = path.join(getProjectClaudeDir(projectB), 'settings.local.json');
    const legacyA = path.join(getProjectClaudeDir(projectA), 'hooks', 'asb', 'keep-a');
    const legacyB = path.join(getProjectClaudeDir(projectB), 'hooks', 'asb', 'remove-b');
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(legacyA, { recursive: true });
    fs.mkdirSync(legacyB, { recursive: true });
    fs.writeFileSync(path.join(legacyA, 'run.sh'), '#!/bin/sh\n');
    const legacyBScript = path.join(legacyB, 'run.sh');
    fs.writeFileSync(legacyBScript, '#!/bin/sh\n');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyBScript }] }],
        },
        _asb_managed_hooks: ['remove-b'],
      })
    );
    fs.symlinkSync(targetPath, aliasPath);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }), {
      project: projectA,
    });

    const outcome = distributeHooks(
      { project: projectA },
      ['claude-code'],
      new Set(['claude-code'])
    );

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(legacyB), false);
    assert.equal(fs.existsSync(legacyA), true);
    assertNoAsbOwnershipTokens(JSON.parse(fs.readFileSync(targetPath, 'utf-8')));
  });
});

test('distributeHooks: claude-code cleanup rejects symlinked hook ancestor without deleting outside', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const hooksLink = path.join(getClaudeDir(), 'hooks');
    const outsideHooksDir = path.join(agentsHome, 'outside-claude-cleanup-ancestor');
    const outsideStaleDir = path.join(outsideHooksDir, 'asb', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideHooksDir, hooksLink);

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) =>
        r.platform === 'claude-code' &&
        r.targetDir === path.join(hooksLink, 'managed', claudeManagedBundleNamespace())
    );

    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /refusing to follow symlinked path/);
  });
});

test('distributeHooks: claude-code cleanup rejects symlinked app root without deleting outside', () => {
  withTempHomes(({ agentsHome }) => {
    const claudeRoot = getClaudeDir();
    const outsideRoot = path.join(agentsHome, 'outside-claude-root');
    const outsideStaleDir = path.join(outsideRoot, 'hooks', 'asb', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideRoot, claudeRoot);

    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);
    const result = outcome.results.find(
      (r) =>
        r.platform === 'claude-code' &&
        r.targetDir === path.join(claudeRoot, 'hooks', 'managed', claudeManagedBundleNamespace())
    );

    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked bundle root/);
  });
});

test('distributeHooks: claude-code cleanup waits for readable settings', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');

    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const staleDir = path.join(getClaudeDir(), 'hooks', 'asb', 'stale-hook');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'run.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(settingsPath, '{not json');
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'claude-code' &&
          r.status === 'error' &&
          r.error?.includes('Cannot read settings.json')
      )
    );
    assert.equal(fs.existsSync(staleDir), true);
  });
});

test('distributeHooks: claude-code aborts when managed hook state is corrupt', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      '{"version":1,"hooks":{"PreToolUse":[{}]},"prefixLengths":{"PreToolUse":0}}'
    );
    createHookEntry('blocked-hook');
    updateLibraryStateSection('hooks', () => ({ enabled: ['blocked-hook'], agentSync: {} }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'claude-code' &&
          result.status === 'error' &&
          result.error?.includes('Cannot read managed hook state')
      )
    );
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"dark"}\n');
  });
});

test('hook load claude-code imports only user-defined hooks', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const userGroup = {
      matcher: 'Read',
      hooks: [{ type: 'command', command: 'echo user-hook' }],
    };
    const managedGroup = {
      matcher: '*',
      hooks: [{ type: 'command', command: 'echo managed-hook' }],
    };
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [userGroup, managedGroup] } })
    );
    saveManagedHookGroups(
      'claude-code',
      settingsPath,
      { PreToolUse: [managedGroup] },
      { PreToolUse: 1 }
    );

    runCli(['hook', 'load', 'claude-code', '--force']);

    const importedPath = path.join(asbHome, 'hooks', 'claude-code-hooks', 'hook.json');
    const imported = JSON.parse(fs.readFileSync(importedPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(imported.hooks.PreToolUse, [userGroup]);

    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [managedGroup, userGroup] } })
    );
    saveManagedHookGroups(
      'claude-code',
      settingsPath,
      { PreToolUse: [managedGroup] },
      { PreToolUse: 0 }
    );
    runCli(['hook', 'load', 'claude-code', '--force']);
    const tailImport = JSON.parse(fs.readFileSync(importedPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(tailImport.hooks.PreToolUse, [userGroup]);

    const before = fs.readFileSync(importedPath, 'utf-8');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [managedGroup] } }));
    saveManagedHookGroups(
      'claude-code',
      settingsPath,
      { PreToolUse: [managedGroup] },
      { PreToolUse: 0 }
    );
    const { stdout } = runCli(['hook', 'load', 'claude-code', '--force']);
    assert.match(stripAnsi(stdout), /No user-defined hooks/);
    assert.equal(fs.readFileSync(importedPath, 'utf-8'), before);
  });
});

test('hook load claude-code uses the canonical project scope for legacy hooks', () => {
  withTempHomes(({ agentsHome, asbHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'import-project-alias');
    const projectSettings = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    const globalSettings = path.join(getClaudeDir(), 'settings.json');
    const legacyDir = path.join(getProjectClaudeDir(projectRoot), 'hooks', 'asb', 'legacy-import');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
      })
    );
    fs.symlinkSync(projectSettings, globalSettings);

    const { stdout } = runCli(['hook', 'load', 'claude-code', '--force']);

    assert.match(stripAnsi(stdout), /No user-defined hooks/);
    assert.equal(fs.existsSync(path.join(asbHome, 'hooks', 'claude-code-hooks')), false);
  });
});

test('hook load claude-code imports a canonical legacy path embedded in another token', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const command = `/Volumes/Backup${path.join(
      getClaudeDir(),
      'hooks',
      'asb',
      'user-hook',
      'run.sh'
    )}`;
    const userGroup = { hooks: [{ type: 'command', command }] };
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [userGroup] } }));

    runCli(['hook', 'load', 'claude-code', '--force']);

    const importedPath = path.join(asbHome, 'hooks', 'claude-code-hooks', 'hook.json');
    const imported = JSON.parse(fs.readFileSync(importedPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(imported.hooks.SessionStart, [userGroup]);
  });
});

test('managed hook state recovers either side of an interrupted config commit', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const previousConfig = '{"theme":"dark"}\n';
    const desiredConfig = '{"theme":"dark","hooks":{}}\n';
    const previous = {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo previous' }] }],
    };
    const desired = {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo desired' }] }],
    };
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const pendingState = JSON.stringify({
      version: 1,
      hooks: previous,
      prefixLengths: { PreToolUse: 0 },
      pending: {
        desired,
        desiredPrefixLengths: { PreToolUse: 0 },
        previousConfigHash: configSnapshotHash(previousConfig),
        desiredConfigHash: configSnapshotHash(desiredConfig),
      },
    });
    fs.writeFileSync(statePath, pendingState);

    fs.writeFileSync(settingsPath, previousConfig);
    const beforeCommit = loadManagedHookGroups('claude-code', settingsPath);
    assert.equal(beforeCommit.ok, true);
    if (beforeCommit.ok) assert.deepEqual(beforeCommit.hooks, previous);

    fs.writeFileSync(statePath, pendingState);
    fs.writeFileSync(settingsPath, desiredConfig);
    const afterCommit = loadManagedHookGroups('claude-code', settingsPath);
    assert.equal(afterCommit.ok, true);
    if (afterCommit.ok) assert.deepEqual(afterCommit.hooks, desired);
  });
});

test('managed hook recovery restores pending state after a same-content config race', () => {
  withTempHomes(({ agentsHome }) => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const heldSettingsPath = path.join(agentsHome, 'pending-race-settings.json');
    const desiredConfig = '{"theme":"dark","hooks":{}}\n';
    const previous = {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo previous' }] }],
    };
    const desired = {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo desired' }] }],
    };
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const pendingState = {
      version: 1,
      hooks: previous,
      prefixLengths: { PreToolUse: 0 },
      pending: {
        desired,
        desiredPrefixLengths: { PreToolUse: 0 },
        previousConfigHash: configSnapshotHash('{"theme":"dark"}\n'),
        desiredConfigHash: configSnapshotHash(desiredConfig),
      },
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(pendingState));
    fs.writeFileSync(settingsPath, desiredConfig);
    const originalMode = fs.statSync(settingsPath).mode & 0o777;
    const originalIdentity = `${fs.statSync(settingsPath).dev}:${fs.statSync(settingsPath).ino}`;

    const originalRenameSync = fs.renameSync;
    let published = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRenameSync(oldPath, newPath);
        if (!published && path.resolve(String(newPath)) === path.resolve(statePath)) {
          published = true;
          originalRenameSync(settingsPath, heldSettingsPath);
          fs.writeFileSync(settingsPath, desiredConfig);
          fs.chmodSync(settingsPath, originalMode);
        }
        return result;
      }) as typeof fs.renameSync;
      const recovered = loadManagedHookGroups('claude-code', settingsPath);
      assert.equal(recovered.ok, false);
      if (!recovered.ok) assert.match(recovered.error, /application config changed/);
    } finally {
      fs.renameSync = originalRenameSync;
    }

    const restoredState = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as {
      pending?: unknown;
    };
    const replacementIdentity = `${fs.statSync(settingsPath).dev}:${fs.statSync(settingsPath).ino}`;
    assert.equal(published, true);
    assert.notEqual(replacementIdentity, originalIdentity);
    assert.ok(restoredState.pending);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), desiredConfig);
  });
});

test('managed hook state restores a config after termination between capture and publish', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const settingsRealPath = fs.realpathSync.native(settingsPath);
    createHookEntry('crash-recovery-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['crash-recovery-hook'],
      agentSync: {},
    }));
    const scriptPath = path.join(agentsHome, 'crash-config-commit.mjs');
    const distributionUrl = pathToFileURL(
      path.join(process.cwd(), 'src', 'hooks', 'distribution.ts')
    ).href;
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs';\nimport path from 'node:path';\nconst { distributeHooks } = await import(${JSON.stringify(distributionUrl)});\nconst originalRenameSync = fs.renameSync;\nfs.renameSync = (oldPath, newPath) => {\n  const result = originalRenameSync(oldPath, newPath);\n  if (path.resolve(String(oldPath)) === ${JSON.stringify(settingsRealPath)} && String(newPath).includes('.previous.')) process.exit(77);\n  return result;\n};\ndistributeHooks(undefined, ['claude-code']);\n`
    );

    const crashed = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf-8',
    });
    assert.equal(crashed.status, 77, crashed.stderr);
    assert.equal(fs.existsSync(settingsPath), false);
    assert.ok(
      fs
        .readdirSync(path.dirname(settingsRealPath))
        .some((name) => name.startsWith(`${path.basename(settingsRealPath)}.previous.`))
    );

    const imported = runCli(['hook', 'load', 'claude-code', '--force']);
    assert.match(stripAnsi(imported.stdout), /No hooks found/);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"dark"}\n');

    const recovered = distributeHooks(undefined, ['claude-code']);
    assert.ok(recovered.results.every((result) => result.status !== 'error'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(
      fs
        .readdirSync(path.dirname(settingsRealPath))
        .some(
          (name) =>
            name.startsWith(`${path.basename(settingsRealPath)}.previous.`) ||
            name.startsWith(`${path.basename(settingsRealPath)}.tmp.`)
        ),
      false
    );
    const state = JSON.parse(
      fs.readFileSync(resolveManagedHookStatePath('claude-code', settingsPath), 'utf-8')
    ) as { pending?: unknown };
    assert.equal(state.pending, undefined);
  });
});

test('managed hook state restores a config after termination during rollback', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const settingsRealPath = fs.realpathSync.native(settingsPath);
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    createHookEntry('rollback-crash-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['rollback-crash-hook'],
      agentSync: {},
    }));
    const scriptPath = path.join(agentsHome, 'crash-config-rollback.mjs');
    const distributionUrl = pathToFileURL(
      path.join(process.cwd(), 'src', 'hooks', 'distribution.ts')
    ).href;
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs';\nimport path from 'node:path';\nconst { distributeHooks } = await import(${JSON.stringify(distributionUrl)});\nconst originalRenameSync = fs.renameSync;\nlet stateCommits = 0;\nfs.renameSync = (oldPath, newPath) => {\n  if (path.resolve(String(newPath)) === ${JSON.stringify(statePath)}) {\n    stateCommits += 1;\n    if (stateCommits === 2) throw new Error('mock final state commit failure');\n  }\n  const result = originalRenameSync(oldPath, newPath);\n  if (path.resolve(String(oldPath)) === ${JSON.stringify(settingsRealPath)} && String(newPath).includes('.failed.')) process.exit(78);\n  return result;\n};\ndistributeHooks(undefined, ['claude-code']);\n`
    );

    const crashed = spawnSync(process.execPath, ['--import', 'tsx', scriptPath], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf-8',
    });
    assert.equal(crashed.status, 78, crashed.stderr);
    assert.equal(fs.existsSync(settingsPath), false);
    const artifactNames = fs.readdirSync(path.dirname(settingsRealPath));
    assert.ok(artifactNames.some((name) => name.includes('.previous.')));
    assert.ok(artifactNames.some((name) => name.includes('.failed.')));

    const recovered = distributeHooks(undefined, ['claude-code']);

    assert.ok(recovered.results.every((result) => result.status !== 'error'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(
      fs
        .readdirSync(path.dirname(settingsRealPath))
        .some(
          (name) =>
            name.startsWith(`${path.basename(settingsRealPath)}.previous.`) ||
            name.startsWith(`${path.basename(settingsRealPath)}.tmp.`) ||
            name.startsWith(`${path.basename(settingsRealPath)}.failed.`)
        ),
      false
    );
  });
});

test('managed hook state preserves journal artifacts when config restoration fails', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    const settingsRealPath = fs.realpathSync.native(settingsPath);
    createHookEntry('restore-failure-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['restore-failure-hook'],
      agentSync: {},
    }));

    const originalLinkSync = fs.linkSync;
    const originalRenameSync = fs.renameSync;
    let configLinks = 0;
    try {
      fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(newPath)) === settingsRealPath) {
          configLinks += 1;
          if (configLinks <= 2) throw new Error('mock config link failure');
        }
        return originalLinkSync(existingPath, newPath);
      }) as typeof fs.linkSync;
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (
          String(oldPath).includes('.previous.') &&
          path.resolve(String(newPath)) === settingsRealPath
        ) {
          throw new Error('mock config restore failure');
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(outcome.results.some((result) => result.status === 'error'));
    } finally {
      fs.linkSync = originalLinkSync;
      fs.renameSync = originalRenameSync;
    }

    assert.equal(configLinks, 1);
    assert.equal(fs.existsSync(settingsPath), false);
    assert.ok(
      fs
        .readdirSync(path.dirname(settingsRealPath))
        .some((name) => name.startsWith(`${path.basename(settingsRealPath)}.previous.`))
    );

    const recovered = distributeHooks(undefined, ['claude-code']);
    assert.ok(recovered.results.every((result) => result.status !== 'error'));
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('managed hook recovery preserves a committed config deletion before downstream failure', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const previousConfig =
      '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo old"}]}]}}\n';
    const previous = {
      Stop: [{ hooks: [{ type: 'command', command: 'echo old' }] }],
    };
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    const transactionId = 'a'.repeat(24);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        hooks: previous,
        prefixLengths: { Stop: 0 },
        pending: {
          desired: {},
          desiredPrefixLengths: {},
          previousConfigHash: configSnapshotHash(previousConfig),
          desiredConfigHash: configSnapshotHash(undefined),
          transactionId,
          configCommitted: true,
        },
      })
    );
    fs.writeFileSync(`${hooksJsonPath}.previous.${transactionId}`, previousConfig);
    const managedRoot = codexManagedBundleRoot();
    const outside = path.join(agentsHome, 'committed-delete-downstream-failure');
    fs.mkdirSync(path.dirname(managedRoot), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, managedRoot);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.existsSync(hooksJsonPath), false);
    assert.equal(fs.existsSync(`${hooksJsonPath}.previous.${transactionId}`), false);
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('managed hook recovery does not resurrect a committed config deleted externally', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const previousConfig = '{"theme":"dark"}\n';
    const desiredConfig =
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo managed"}]}]}}\n';
    const previous = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo previous' }] }],
    };
    const desired = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
    };
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const transactionId = 'b'.repeat(24);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        hooks: previous,
        prefixLengths: { SessionStart: 0 },
        pending: {
          desired,
          desiredPrefixLengths: { SessionStart: 0 },
          previousConfigHash: configSnapshotHash(previousConfig),
          desiredConfigHash: configSnapshotHash(desiredConfig),
          transactionId,
          configCommitted: true,
        },
      })
    );
    const backupPath = `${settingsPath}.previous.${transactionId}`;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(backupPath, previousConfig);

    const loaded = loadManagedHookGroups('claude-code', settingsPath);

    assert.equal(loaded.ok, false);
    assert.equal(fs.existsSync(settingsPath), false);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.existsSync(statePath), true);
  });
});

test('distributeHooks: claude-code finalizes an interrupted empty ownership state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const previousConfig =
      '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"echo old"}]}]}}\n';
    const desiredConfig = '{"hooks":{}}\n';
    const previous = {
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo old' }] }],
    };
    fs.writeFileSync(settingsPath, desiredConfig);
    writePendingManagedState(
      'claude-code',
      settingsPath,
      previousConfig,
      desiredConfig,
      previous,
      {}
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    distributeHooks(undefined, ['claude-code']);

    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('managed hook state uses one identity for real and symlinked config paths', () => {
  withTempHomes(({ agentsHome }) => {
    const projectRoot = path.join(agentsHome, 'real-project');
    const projectAlias = path.join(agentsHome, 'project-alias');
    fs.mkdirSync(projectRoot);
    fs.symlinkSync(projectRoot, projectAlias);

    const realConfig = path.join(projectRoot, '.codex', 'hooks.json');
    const aliasConfig = path.join(projectAlias, '.codex', 'hooks.json');
    assert.equal(
      resolveManagedHookStatePath('codex', realConfig),
      resolveManagedHookStatePath('codex', aliasConfig)
    );
  });
});

test('distributeHooks: rejects a symlinked project managed-state ancestor', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'state-symlink-project');
    const outside = path.join(agentsHome, 'outside-project-state');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(projectRoot, '.asb'));
    createHookEntry('project-state-symlink');
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['project-state-symlink'], agentSync: {} }),
      { project: projectRoot }
    );

    const outcome = distributeHooks(
      { project: projectRoot },
      ['claude-code'],
      new Set(['claude-code'])
    );

    assert.ok(
      outcome.results.some(
        (result) => result.status === 'error' && result.error?.includes('symlinked path')
      )
    );
    assert.equal(fs.existsSync(path.join(outside, 'state')), false);
    assert.equal(
      fs.existsSync(path.join(getProjectClaudeDir(projectRoot), 'settings.local.json')),
      false
    );
  });
});

test('distributeHooks: preserves a concurrent app config update before commit', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    createBundleHook('concurrent-config-update');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['concurrent-config-update'],
      agentSync: {},
    }));

    const originalWriteFileSync = fs.writeFileSync;
    let changed = false;
    try {
      fs.writeFileSync = ((
        target: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
        options?: unknown
      ) => {
        if (
          !changed &&
          typeof target === 'string' &&
          target.includes(`${path.sep}hooks${path.sep}managed${path.sep}`) &&
          path.basename(target) === 'run.sh'
        ) {
          changed = true;
          originalWriteFileSync(settingsPath, '{"theme":"light"}\n');
        }
        return originalWriteFileSync(target, data, options as never);
      }) as typeof fs.writeFileSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' && result.error?.includes('config changed during hook sync')
        )
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(changed, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"light"}\n');
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: preserves a concurrent config update after the pending journal commit', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    createHookEntry('post-journal-config-update');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['post-journal-config-update'],
      agentSync: {},
    }));
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);

    const originalRenameSync = fs.renameSync;
    let injected = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRenameSync(oldPath, newPath);
        if (!injected && path.resolve(String(newPath)) === statePath) {
          injected = true;
          fs.writeFileSync(settingsPath, '{"theme":"light"}\n');
        }
        return result;
      }) as typeof fs.renameSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' && result.error?.includes('config changed during hook sync')
        )
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(injected, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"light"}\n');
    assert.equal(fs.existsSync(statePath), false);

    const retried = distributeHooks(undefined, ['claude-code']);
    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
      theme: string;
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.theme, 'light');
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('distributeHooks: reports a concurrent edit at final managed state publication', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    createHookEntry('final-state-race');
    updateLibraryStateSection('hooks', () => ({ enabled: ['final-state-race'], agentSync: {} }));
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);

    const originalRenameSync = fs.renameSync;
    let stateCommits = 0;
    let injected = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(newPath)) === statePath) {
          stateCommits += 1;
          if (stateCommits === 2) {
            injected = true;
            fs.writeFileSync(settingsPath, '{"theme":"light"}\n');
          }
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' && result.error?.includes('config changed during hook sync')
        )
      );
      assert.ok(!outcome.results.some((result) => result.status === 'written'));
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(injected, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"light"}\n');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { pending?: unknown };
    assert.ok(state.pending);
  });
});

test('distributeHooks: rejects config symlink retargeting under the captured lock', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const targetA = path.join(agentsHome, 'claude-settings-a.json');
    const targetB = path.join(agentsHome, 'claude-settings-b.json');
    fs.writeFileSync(targetA, '{"theme":"a"}\n');
    fs.writeFileSync(targetB, '{"theme":"b"}\n');
    const targetAReal = fs.realpathSync.native(targetA);
    fs.symlinkSync(targetA, settingsPath);
    createHookEntry('retargeted-settings');
    updateLibraryStateSection('hooks', () => ({ enabled: ['retargeted-settings'], agentSync: {} }));

    const originalOpenSync = fs.openSync;
    let retargeted = false;
    try {
      fs.openSync = ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const result = originalOpenSync(target, flags, mode);
        if (!retargeted && path.resolve(String(target)) === targetAReal) {
          retargeted = true;
          fs.unlinkSync(settingsPath);
          fs.symlinkSync(targetB, settingsPath);
        }
        return result;
      }) as typeof fs.openSync;

      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' &&
            result.error?.includes('config target changed during hook sync')
        ),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.openSync = originalOpenSync;
    }

    assert.equal(retargeted, true);
    assert.equal(fs.readFileSync(targetA, 'utf-8'), '{"theme":"a"}\n');
    assert.equal(fs.readFileSync(targetB, 'utf-8'), '{"theme":"b"}\n');
    assert.equal(fs.realpathSync.native(settingsPath), fs.realpathSync.native(targetB));
  });
});

test('distributeHooks: preserves a dangling symlinked Claude settings file', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const realSettingsPath = path.join(agentsHome, 'real-claude-settings.json');
    fs.symlinkSync(realSettingsPath, settingsPath);
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    createHookEntry('symlinked-settings-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['symlinked-settings-hook'],
      agentSync: {},
    }));

    distributeHooks(undefined, ['claude-code']);
    distributeHooks(undefined, ['claude-code']);

    assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
    assert.equal(resolveManagedHookStatePath('claude-code', settingsPath), statePath);
    const settings = JSON.parse(fs.readFileSync(realSettingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assertNoAsbOwnershipTokens(settings);
  });
});

test('distributeHooks: preserves a multi-level dangling Claude settings symlink chain', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const aliasPath = path.join(agentsHome, 'settings-alias.json');
    const targetPath = path.join(agentsHome, 'nested', 'settings-target.json');
    fs.symlinkSync(aliasPath, settingsPath);
    fs.symlinkSync(targetPath, aliasPath);
    createHookEntry('multi-level-symlink-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['multi-level-symlink-hook'],
      agentSync: {},
    }));

    const outcome = distributeHooks(undefined, ['claude-code']);

    assert.ok(outcome.results.every((result) => result.status !== 'error'));
    assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(aliasPath).isSymbolicLink(), true);
    const settings = JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(
      resolveManagedHookStatePath('claude-code', settingsPath),
      resolveManagedHookStatePath('claude-code', targetPath)
    );
  });
});

test('managed hook state does not assign project ownership to nonstandard config carriers', () => {
  withTempHomes(({ agentsHome }) => {
    const projectRoot = path.join(agentsHome, 'dot-prefix-project');
    const configPath = path.join(projectRoot, '..data', 'settings.json');
    fs.mkdirSync(projectRoot, { recursive: true });

    const statePath = resolveManagedHookStatePath('claude-code', configPath, projectRoot);

    assert.equal(
      statePath.startsWith(
        path.join(fs.realpathSync.native(projectRoot), '.asb', 'state', 'hooks') + path.sep
      ),
      false
    );
  });
});

test('managed hook state resolves a dangling config through a symlinked ancestor', () => {
  withTempHomes(({ agentsHome }) => {
    const projectRoot = path.join(agentsHome, 'dangling-ancestor-project');
    const linkedAncestor = path.join(projectRoot, 'config-link');
    const missingAncestor = path.join(projectRoot, 'missing-config-dir');
    const linkedConfig = path.join(linkedAncestor, 'settings.json');
    const targetConfig = path.join(missingAncestor, 'settings.json');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.symlinkSync(missingAncestor, linkedAncestor);

    assert.equal(
      resolveManagedHookStatePath('claude-code', linkedConfig, projectRoot),
      resolveManagedHookStatePath('claude-code', targetConfig, projectRoot)
    );
  });
});

test('distributeHooks: project config symlink retargeting uses a distinct ownership identity', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'project-retarget');
    const settingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    const targetA = path.join(projectRoot, 'settings-a.json');
    const targetB = path.join(projectRoot, 'settings-b.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(targetA, '{}\n');
    fs.symlinkSync(targetA, settingsPath);
    createHookEntry('project-retarget-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['project-retarget-hook'], agentSync: {} }),
      { project: projectRoot }
    );
    distributeHooks({ project: projectRoot }, ['claude-code']);
    const managedGroup = (
      JSON.parse(fs.readFileSync(targetA, 'utf-8')) as { hooks: Record<string, unknown[]> }
    ).hooks.PreToolUse[0];
    const stateA = resolveManagedHookStatePath('claude-code', settingsPath, projectRoot);

    fs.unlinkSync(settingsPath);
    fs.writeFileSync(targetB, JSON.stringify({ hooks: { PreToolUse: [managedGroup] } }));
    fs.symlinkSync(targetB, settingsPath);
    const stateB = resolveManagedHookStatePath('claude-code', settingsPath, projectRoot);
    assert.notEqual(stateB, stateA);

    const outcome = distributeHooks({ project: projectRoot }, ['claude-code']);
    assert.ok(outcome.results.every((result) => result.status !== 'conflict'));
    const targetBSettings = JSON.parse(fs.readFileSync(targetB, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(targetBSettings.hooks.PreToolUse.length, 2);
    assert.equal(fs.existsSync(stateA), true);
    assert.equal(fs.existsSync(stateB), true);
  });
});

test('distributeHooks: global and project aliases of one config share hook ownership', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const globalSettingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(globalSettingsPath, '{}\n');
    const projectRoot = path.join(agentsHome, 'shared-config-project');
    const projectSettingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.symlinkSync(globalSettingsPath, projectSettingsPath);
    createHookEntry('shared-config-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['shared-config-hook'],
      agentSync: {},
    }));
    updateLibraryStateSection('hooks', () => ({ enabled: ['shared-config-hook'], agentSync: {} }), {
      project: projectRoot,
    });

    distributeHooks(undefined, ['claude-code']);
    distributeHooks({ project: projectRoot }, ['claude-code'], new Set(['claude-code']));

    assert.equal(
      resolveManagedHookStatePath('claude-code', globalSettingsPath),
      resolveManagedHookStatePath('claude-code', projectSettingsPath, projectRoot)
    );
    const settings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('distributeHooks: aliases of a nonstandard config carrier share global ownership', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const carrier = path.join(agentsHome, 'shared-config-carrier.json');
    const globalSettingsPath = path.join(getClaudeDir(), 'settings.json');
    const projectRoot = path.join(agentsHome, 'nonstandard-carrier-project');
    const projectSettingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(carrier, '{}\n');
    fs.symlinkSync(carrier, globalSettingsPath);
    fs.symlinkSync(carrier, projectSettingsPath);
    createHookEntry('nonstandard-carrier-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['nonstandard-carrier-hook'],
      agentSync: {},
    }));
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['nonstandard-carrier-hook'], agentSync: {} }),
      { project: projectRoot }
    );

    distributeHooks(undefined, ['claude-code']);
    distributeHooks({ project: projectRoot }, ['claude-code'], new Set(['claude-code']));

    assert.equal(
      resolveManagedHookStatePath('claude-code', globalSettingsPath),
      resolveManagedHookStatePath('claude-code', projectSettingsPath, projectRoot)
    );
    const settings = JSON.parse(fs.readFileSync(carrier, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('distributeHooks: a project Codex alias to global hooks shares global ownership', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const globalHooksPath = getCodexHooksJsonPath();
    const projectRoot = path.join(agentsHome, 'project-to-global-codex');
    const projectHooksPath = getProjectCodexHooksJsonPath(projectRoot);
    fs.mkdirSync(path.dirname(projectHooksPath), { recursive: true });
    fs.writeFileSync(globalHooksPath, '{}\n');
    fs.symlinkSync(globalHooksPath, projectHooksPath);
    createCodexCompatibleHook('project-global-codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['project-global-codex-hook'],
      agentSync: { codex: { enabled: ['project-global-codex-hook'] } },
    }));
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['project-global-codex-hook'],
        agentSync: { codex: { enabled: ['project-global-codex-hook'] } },
      }),
      { project: projectRoot }
    );

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    distributeHooks({ project: projectRoot }, ['codex'], new Set(['codex']));

    assert.equal(
      resolveManagedHookStatePath('codex', globalHooksPath),
      resolveManagedHookStatePath('codex', projectHooksPath, projectRoot)
    );
    const hooks = JSON.parse(fs.readFileSync(globalHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  });
});

test('distributeHooks: global Claude alias to a project config shares project ownership', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'global-to-project-claude');
    const projectSettingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    const globalSettingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.mkdirSync(path.dirname(projectSettingsPath), { recursive: true });
    fs.writeFileSync(projectSettingsPath, '{}\n');
    if (fs.existsSync(globalSettingsPath)) fs.unlinkSync(globalSettingsPath);
    fs.symlinkSync(projectSettingsPath, globalSettingsPath);
    createHookEntry('global-project-claude-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['global-project-claude-hook'],
      agentSync: {},
    }));
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['global-project-claude-hook'], agentSync: {} }),
      { project: projectRoot }
    );

    distributeHooks(undefined, ['claude-code']);
    distributeHooks({ project: projectRoot }, ['claude-code'], new Set(['claude-code']));

    assert.equal(
      resolveManagedHookStatePath('claude-code', globalSettingsPath),
      resolveManagedHookStatePath('claude-code', projectSettingsPath, projectRoot)
    );
    const settings = JSON.parse(fs.readFileSync(projectSettingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('distributeHooks: global Codex alias to a project config shares project ownership', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectRoot = path.join(agentsHome, 'global-to-project-codex');
    const projectHooksPath = getProjectCodexHooksJsonPath(projectRoot);
    const globalHooksPath = getCodexHooksJsonPath();
    fs.mkdirSync(path.dirname(projectHooksPath), { recursive: true });
    fs.writeFileSync(projectHooksPath, '{}\n');
    if (fs.existsSync(globalHooksPath)) fs.unlinkSync(globalHooksPath);
    fs.symlinkSync(projectHooksPath, globalHooksPath);
    createCodexCompatibleHook('global-project-codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['global-project-codex-hook'],
      agentSync: { codex: { enabled: ['global-project-codex-hook'] } },
    }));
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['global-project-codex-hook'],
        agentSync: { codex: { enabled: ['global-project-codex-hook'] } },
      }),
      { project: projectRoot }
    );

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    distributeHooks({ project: projectRoot }, ['codex'], new Set(['codex']));

    assert.equal(
      resolveManagedHookStatePath('codex', globalHooksPath),
      resolveManagedHookStatePath('codex', projectHooksPath, projectRoot)
    );
    const hooks = JSON.parse(fs.readFileSync(projectHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  });
});

test('managed hook state follows a project config alias to the target project owner', () => {
  withTempHomes(({ agentsHome }) => {
    const projectA = path.join(agentsHome, 'project-alias-a');
    const projectB = path.join(agentsHome, 'project-alias-b');
    const aliasPath = getProjectCodexHooksJsonPath(projectA);
    const targetPath = getProjectCodexHooksJsonPath(projectB);
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '{}\n');
    fs.symlinkSync(targetPath, aliasPath);

    assert.equal(
      resolveManagedHookStatePath('codex', aliasPath, projectA),
      resolveManagedHookStatePath('codex', targetPath, projectB)
    );
  });
});

test('distributeHooks: bundle targets follow the canonical project config owner', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code', 'codex');
    const projectA = path.join(agentsHome, 'bundle-owner-a');
    const projectB = path.join(agentsHome, 'bundle-owner-b');
    const claudeAlias = path.join(getProjectClaudeDir(projectA), 'settings.local.json');
    const claudeTarget = path.join(getProjectClaudeDir(projectB), 'settings.local.json');
    const codexAlias = getProjectCodexHooksJsonPath(projectA);
    const codexTarget = getProjectCodexHooksJsonPath(projectB);
    fs.mkdirSync(path.dirname(claudeAlias), { recursive: true });
    fs.mkdirSync(path.dirname(claudeTarget), { recursive: true });
    fs.mkdirSync(path.dirname(codexAlias), { recursive: true });
    fs.mkdirSync(path.dirname(codexTarget), { recursive: true });
    fs.writeFileSync(claudeTarget, '{}\n');
    fs.writeFileSync(codexTarget, '{}\n');
    fs.symlinkSync(claudeTarget, claudeAlias);
    fs.symlinkSync(codexTarget, codexAlias);
    createBundleHook('canonical-owner-bundle');
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['canonical-owner-bundle'],
        agentSync: { codex: { enabled: ['canonical-owner-bundle'] } },
      }),
      { project: projectA }
    );

    const outcome = distributeHooks(
      { project: projectA },
      ['claude-code', 'codex'],
      new Set(['claude-code', 'codex'])
    );

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    const claudeConfig = JSON.parse(fs.readFileSync(claudeTarget, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    const claudeCommands = Object.values(claudeConfig.hooks).flatMap((groups) =>
      codexGroupCommands(groups)
    );
    const codexConfig = JSON.parse(fs.readFileSync(codexTarget, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    const codexCommands = Object.values(codexConfig.hooks).flatMap((groups) =>
      codexGroupCommands(groups)
    );
    assert.ok(claudeCommands.every((command) => command.includes(projectB)));
    assert.ok(codexCommands.every((command) => command.includes(projectB)));
  });
});

test('managed hook lock rejects live overlap and recovers a dead owner', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    assert.throws(
      () =>
        withManagedHookLock('claude-code', settingsPath, () =>
          withManagedHookLock('claude-code', settingsPath, () => undefined)
        ),
      /EEXIST/
    );

    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner'), '99999999\n');
    let entered = false;
    withManagedHookLock('claude-code', settingsPath, () => {
      entered = true;
    });
    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('managed hook transactions reject a replaced global state root', () => {
  withTempHomes(({ agentsHome, asbHome }) => {
    const settingsPath = path.join(agentsHome, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}\n');
    const movedRoot = `${asbHome}.moved`;

    withManagedHookLock('claude-code', settingsPath, (address) => {
      fs.renameSync(asbHome, movedRoot);
      fs.mkdirSync(asbHome, { recursive: true });
      try {
        assert.throws(
          () =>
            saveManagedHookGroups(
              'claude-code',
              settingsPath,
              { SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }] },
              { SessionStart: 0 },
              undefined,
              address
            ),
          /state root changed during hook sync/
        );
        assert.deepEqual(fs.readdirSync(asbHome), []);
      } finally {
        fs.rmdirSync(asbHome);
        fs.renameSync(movedRoot, asbHome);
      }
    });
  });
});

test('managed hook lock recovers an orphaned recovery guard', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    const recoveryPath = `${lockPath}.recovery`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), '99999998 stale-main\n');
    fs.mkdirSync(recoveryPath);
    fs.writeFileSync(path.join(recoveryPath, 'owner'), '99999999 stale-recovery\n');

    let entered = false;
    withManagedHookLock('claude-code', settingsPath, () => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(recoveryPath), false);
  });
});

test('managed hook lock recovers a stale owner after PID reuse', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(
      path.join(lockPath, 'owner'),
      `${JSON.stringify({ pid: process.pid, token: 'old', identity: 'different-start' })}\n`
    );

    let entered = false;
    withManagedHookLock('claude-code', settingsPath, () => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('managed hook state rejects an ancestor swapped to a symlink after address capture', () => {
  withTempHomes(({ agentsHome }) => {
    const projectRoot = path.join(agentsHome, 'state-swap-project');
    const configPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    const stateRoot = path.join(projectRoot, '.asb');
    const capturedRoot = path.join(projectRoot, '.asb-captured');
    const outside = path.join(agentsHome, 'outside-state-swap');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });

    assert.throws(
      () =>
        withManagedHookLock(
          'claude-code',
          configPath,
          (address) => {
            fs.renameSync(stateRoot, capturedRoot);
            fs.symlinkSync(outside, stateRoot);
            try {
              saveManagedHookGroups(
                'claude-code',
                configPath,
                {
                  PreToolUse: [
                    { matcher: '*', hooks: [{ type: 'command', command: 'echo managed' }] },
                  ],
                },
                { PreToolUse: 0 },
                projectRoot,
                address
              );
            } finally {
              fs.unlinkSync(stateRoot);
              fs.renameSync(capturedRoot, stateRoot);
            }
          },
          projectRoot
        ),
      /symlinked path/
    );
    assert.equal(fs.existsSync(path.join(outside, 'state')), false);
  });
});

test('managed hook transaction does not recreate a project moved after journal publication', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'project-move-during-commit');
    const movedRoot = path.join(agentsHome, 'project-move-during-commit-new');
    const settingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}\n');
    createHookEntry('project-move-during-commit-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['project-move-during-commit-hook'], agentSync: {} }),
      { project: projectRoot }
    );
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath, projectRoot);

    const originalRenameSync = fs.renameSync;
    let moved = false;
    let outcome: ReturnType<typeof distributeHooks> | undefined;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRenameSync(oldPath, newPath);
        if (!moved && path.resolve(String(newPath)) === statePath) {
          moved = true;
          originalRenameSync(projectRoot, movedRoot);
        }
        return result;
      }) as typeof fs.renameSync;
      outcome = distributeHooks(
        { project: projectRoot },
        ['claude-code'],
        new Set(['claude-code'])
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(moved, true);
    assert.ok(
      outcome?.results.some(
        (result) => result.status === 'error' && result.error?.includes('project root changed')
      )
    );
    assert.equal(fs.existsSync(projectRoot), false);
    const movedSettingsPath = path.join(getProjectClaudeDir(movedRoot), 'settings.local.json');
    assert.equal(fs.readFileSync(movedSettingsPath, 'utf-8'), '{}\n');

    const recovered = distributeHooks(
      { project: movedRoot },
      ['claude-code'],
      new Set(['claude-code'])
    );
    assert.ok(recovered.results.every((result) => result.status !== 'error'));
    const settings = JSON.parse(fs.readFileSync(movedSettingsPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(settings.hooks.PreToolUse.length, 1);
  });
});

test('managed hook lock rejects a symlinked lock path without touching its target', () => {
  withTempHomes(({ agentsHome }) => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    const outside = path.join(agentsHome, 'outside-lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'owner'), 'protected\n');
    fs.symlinkSync(outside, lockPath);

    assert.throws(
      () => withManagedHookLock('claude-code', settingsPath, () => undefined),
      /symlinked path/
    );
    assert.equal(fs.readFileSync(path.join(outside, 'owner'), 'utf-8'), 'protected\n');
  });
});

test('managed hook lock does not reclaim a freshly malformed owner', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), 'publishing\n');
    let entered = false;

    assert.throws(
      () =>
        withManagedHookLock('claude-code', settingsPath, () => {
          entered = true;
        }),
      /EEXIST/
    );
    assert.equal(entered, false);
    assert.equal(fs.existsSync(lockPath), true);
  });
});

test('managed hook lock reclaims a stale non-positive owner PID', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner'), '0\n');
    const staleTime = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    let entered = false;
    withManagedHookLock('claude-code', settingsPath, () => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test('managed hook lock preserves a replacement owner during release', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    const replacement = {
      pid: process.pid,
      token: 'replacement-owner',
      identity: 'replacement-identity',
    };

    assert.throws(
      () =>
        withManagedHookLock('claude-code', settingsPath, () => {
          fs.writeFileSync(path.join(lockPath, 'owner'), `${JSON.stringify(replacement)}\n`);
        }),
      /ownership changed/
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(lockPath, 'owner'), 'utf-8')),
      replacement
    );
  });
});

test('managed hook lock rejects a symlinked owner file without reading its target', () => {
  withTempHomes(({ agentsHome }) => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    const outsideOwner = path.join(agentsHome, 'outside-lock-owner.json');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(outsideOwner, `${JSON.stringify({ pid: 99999999 })}\n`);
    fs.symlinkSync(outsideOwner, path.join(lockPath, 'owner'));
    let entered = false;

    assert.throws(
      () =>
        withManagedHookLock('claude-code', settingsPath, () => {
          entered = true;
        }),
      /symlinked path/
    );
    assert.equal(entered, false);
    assert.equal(fs.readFileSync(outsideOwner, 'utf-8'), `${JSON.stringify({ pid: 99999999 })}\n`);
    assert.equal(fs.lstatSync(path.join(lockPath, 'owner')).isSymbolicLink(), true);
  });
});

test('managed hook lock recovers known owner publication and release residues', () => {
  withTempHomes(() => {
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const lockPath = `${resolveManagedHookStatePath('claude-code', settingsPath)}.lock`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, `.owner.${'a'.repeat(24)}`), 'partial owner\n');
    fs.writeFileSync(
      path.join(lockPath, `.release.99999999.${'b'.repeat(24)}`),
      'partial release\n'
    );
    const staleTime = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    let entered = false;
    withManagedHookLock('claude-code', settingsPath, () => {
      entered = true;
    });

    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// Codex hook distribution tests
// ---------------------------------------------------------------------------

const CODEX_ASB_MANAGED_MARKER = '# asb-managed-by=agent-switchboard';
const CODEX_ASB_HOOK_ID_MARKER_PREFIX = '# asb-hook-id=';

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

function codexGroupCommands(groups: Array<Record<string, unknown>>): string[] {
  return groups.flatMap((group) =>
    Array.isArray(group.hooks)
      ? group.hooks
          .map((hook) => (hook as Record<string, unknown>).command)
          .filter((command): command is string => typeof command === 'string')
      : []
  );
}

function codexBundleTargetDir(hooksJsonPath = getCodexHooksJsonPath()): string {
  const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  };
  const command = content.hooks.UserPromptSubmit[0].hooks[0].command.split('\n', 1)[0];
  return path.dirname(command);
}

function codexAsbHookIdMarker(id: string): string {
  return `${CODEX_ASB_HOOK_ID_MARKER_PREFIX}${encodeURIComponent(id)}`;
}

function createUnsupportedEventHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Hook with unsupported event ${id}`,
    hooks: {
      Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'echo notify' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

function createHttpHandlerHook(id: string): void {
  const hooksDir = ensureHooksDirectory();
  const hookContent = JSON.stringify({
    name: id,
    description: `Hook with http handler ${id}`,
    hooks: {
      SessionStart: [{ hooks: [{ type: 'http', url: 'http://example.com' }] }],
    },
  });
  fs.writeFileSync(path.join(hooksDir, `${id}.json`), hookContent);
}

test('distributeHooks: writes hooks.json for codex when installed', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-hook'],
      agentSync: { codex: { enabled: ['codex-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(codexResults.length > 0, 'should produce codex results');

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    assert.equal(content._asb_managed_hooks, undefined);
    assert.ok(!JSON.stringify(content).includes('_asb_source'));
    assert.ok(hooks.UserPromptSubmit, 'should have UserPromptSubmit event');
    assert.ok(Array.isArray(hooks.UserPromptSubmit), 'UserPromptSubmit should be an array');
    assert.ok(hooks.UserPromptSubmit.length > 0, 'should have at least one matcher group');
    const commands = codexGroupCommands(hooks.UserPromptSubmit as Array<Record<string, unknown>>);
    assert.deepEqual(commands, ['echo test-codex']);
    assert.ok(!JSON.stringify(content).includes('asb-managed-by'));
    assert.ok(!JSON.stringify(content).includes('asb-hook-id'));
    assert.ok(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)));
  });
});

test('distributeHooks: codex canonicalizes Windows aliases with no managed selection', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'echo user',
                  command_windows: 'echo user-windows',
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<
        string,
        Array<{
          hooks: Array<{ commandWindows?: string; command_windows?: string }>;
        }>
      >;
    };
    const handler = content.hooks.SessionStart[0].hooks[0];
    assert.equal(handler.commandWindows, 'echo user-windows');
    assert.equal(handler.command_windows, undefined);
  });
});

test('distributeHooks: codex rejects conflicting Windows command aliases without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = `${JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo user',
                commandWindows: 'echo first',
                command_windows: 'echo second',
              },
            ],
          },
        ],
      },
    })}\n`;
    fs.writeFileSync(hooksJsonPath, original);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
  });
});

test('distributeHooks: codex preserves native prompt, agent, and empty matcher groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const userGroups = [
      {},
      { matcher: 'prompt', hooks: [{ type: 'prompt' }] },
      { matcher: 'agent', hooks: [{ type: 'agent' }] },
    ];
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({ description: 'user hooks', hooks: { SessionStart: userGroups } })
    );
    createCodexCompatibleHook('native-user-hooks');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['native-user-hooks'],
      agentSync: { codex: { enabled: ['native-user-hooks'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      description: string;
      hooks: Record<string, unknown[]>;
    };
    assert.equal(content.description, 'user hooks');
    assert.deepEqual(content.hooks.SessionStart, userGroups);
    assert.equal(content.hooks.UserPromptSubmit, undefined);
  });
});

test('distributeHooks: codex accepts null native optional fields', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const userGroup = {
      matcher: null,
      hooks: [
        {
          type: 'command',
          command: 'echo nullable',
          commandWindows: null,
          timeout: null,
          statusMessage: null,
        },
      ],
    };
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({ description: null, hooks: { SessionStart: [userGroup] } })
    );
    createCodexCompatibleHook('nullable-user-hooks');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['nullable-user-hooks'],
      agentSync: { codex: { enabled: ['nullable-user-hooks'] } },
    }));

    const enabled = distributeHooks(undefined, ['codex'], new Set(['codex']));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    const disabled = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      enabled.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(
      disabled.results.some((result) => result.status === 'error'),
      false
    );
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      description: null;
      hooks: Record<string, unknown[]>;
    };
    assert.equal(content.description, null);
    assert.deepEqual(content.hooks.SessionStart, [userGroup]);
  });
});

test('distributeHooks: skips codex when not installed', () => {
  withTempHomes(() => {
    // Do NOT call simulateAppsInstalled('codex')
    createCodexCompatibleHook('codex-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-hook'],
      agentSync: { codex: { enabled: ['codex-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex']);

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.equal(codexResults.length, 0, 'should produce no codex results when not installed');
  });
});

test('distributeHooks: filters unsupported events for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createUnsupportedEventHook('compact-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['compact-hook'],
      agentSync: { codex: { enabled: ['compact-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(
      codexResults.some(
        (r) =>
          r.status === 'skipped' &&
          r.entryId === 'compact-hook' &&
          r.reason?.includes('unsupported events') &&
          r.reason.includes('Notification')
      ),
      'unsupported-only hook should produce a visible Codex diagnostic'
    );
    const hooksJsonPath = getCodexHooksJsonPath();
    if (fs.existsSync(hooksJsonPath)) {
      const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const hooks = content.hooks as Record<string, unknown[]> | undefined;
      // Notification should NOT appear in codex hooks.json
      assert.equal(
        hooks?.Notification,
        undefined,
        'Notification should not be in codex hooks.json'
      );
    }
  });
});

test('distributeHooks: preserves current Codex supported events', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('permission-hook', 'PermissionRequest');
    createCodexCompatibleHook('pre-compact-hook', 'PreCompact');
    createCodexCompatibleHook('post-compact-hook', 'PostCompact');
    createCodexCompatibleHook('subagent-start-hook', 'SubagentStart');
    createCodexCompatibleHook('subagent-stop-hook', 'SubagentStop');
    updateLibraryStateSection('hooks', () => ({
      enabled: [
        'permission-hook',
        'pre-compact-hook',
        'post-compact-hook',
        'subagent-start-hook',
        'subagent-stop-hook',
      ],
      agentSync: {
        codex: {
          enabled: [
            'permission-hook',
            'pre-compact-hook',
            'post-compact-hook',
            'subagent-start-hook',
            'subagent-stop-hook',
          ],
        },
      },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;

    assert.ok(hooks.PermissionRequest, 'PermissionRequest should be preserved');
    assert.ok(hooks.PreCompact, 'PreCompact should be preserved');
    assert.ok(hooks.PostCompact, 'PostCompact should be preserved');
    assert.ok(hooks.SubagentStart, 'SubagentStart should be preserved');
    assert.ok(hooks.SubagentStop, 'SubagentStop should be preserved');
  });
});

test('distributeHooks: codex canonical hooks feature does not produce legacy warning', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    fs.writeFileSync(getCodexConfigPath(), '[features]\nhooks = true\n');
    createCodexCompatibleHook('feature-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['feature-hook'],
      agentSync: { codex: { enabled: ['feature-hook'] } },
    }));

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
    updateLibraryStateSection('hooks', () => ({
      enabled: ['disabled-feature-hook'],
      agentSync: { codex: { enabled: ['disabled-feature-hook'] } },
    }));

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
      ),
      'disabled features.hooks should be reported as a conflict-style warning'
    );
    assert.equal(
      configResults.some((r) => r.status === 'written'),
      false,
      'feature warning must not be reported as written'
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
    updateLibraryStateSection('hooks', () => ({
      enabled: ['profile-disabled-hook'],
      agentSync: { codex: { enabled: ['profile-disabled-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.filePath === getCodexConfigPath() &&
          r.reason?.includes('features.hooks')
      ),
      'active profile features.hooks=false should be reported as disabled'
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
    updateLibraryStateSection('hooks', () => ({
      enabled: ['profile-enabled-hook'],
      agentSync: { codex: { enabled: ['profile-enabled-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.filePath === getCodexConfigPath() &&
          r.status === 'conflict' &&
          r.reason?.includes('features.hooks')
      ),
      false,
      'profile features.hooks=true should override top-level disabled hooks'
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

    assert.ok(
      fs.existsSync(getProjectCodexHooksJsonPath(projectRoot)),
      'project hooks.json should be written'
    );
    const globalConfigPath = getCodexConfigPath();
    const globalConfig = fs.existsSync(globalConfigPath)
      ? fs.readFileSync(globalConfigPath, 'utf-8')
      : '';
    assert.equal(
      globalConfig.includes('trust_level = "trusted"'),
      false,
      'hook distribution must not automatically trust project config'
    );
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'conflict' &&
          r.reason?.includes('project is not trusted')
      ),
      'project trust gap should be visible to the user'
    );
  });
});

test('distributeHooks: codex project ownership moves with a renamed project', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectA = path.join(agentsHome, 'project-a');
    const projectB = path.join(agentsHome, 'project-b');
    fs.mkdirSync(projectA);
    createCodexCompatibleHook('movable-project-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({
        enabled: ['movable-project-hook'],
        agentSync: { codex: { enabled: ['movable-project-hook'] } },
      }),
      { project: projectA }
    );

    distributeHooks({ project: projectA }, ['codex'], new Set(['codex']));
    fs.renameSync(projectA, projectB);
    distributeHooks({ project: projectB }, ['codex'], new Set(['codex']));

    const hooksJsonPath = getProjectCodexHooksJsonPath(projectB);
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(content.hooks.UserPromptSubmit.length, 1);
    assert.equal(
      fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath, projectB)),
      true
    );
    assertNoAsbOwnershipTokens(content);
  });
});

test('distributeHooks: project legacy cleanup markers survive a project rename', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code', 'codex');
    const projectA = path.join(agentsHome, 'legacy-marker-move-a');
    const projectB = path.join(agentsHome, 'legacy-marker-move-b');
    const claudeConfigA = path.join(getProjectClaudeDir(projectA), 'settings.local.json');
    const codexConfigA = getProjectCodexHooksJsonPath(projectA);
    const claudeLegacyA = path.join(getProjectClaudeDir(projectA), 'hooks', 'asb', 'claude-old');
    const codexLegacyA = path.join(getProjectCodexDir(projectA), 'hooks', 'asb', 'codex-old');
    fs.mkdirSync(path.dirname(claudeConfigA), { recursive: true });
    fs.mkdirSync(path.dirname(codexConfigA), { recursive: true });
    fs.mkdirSync(claudeLegacyA, { recursive: true });
    fs.mkdirSync(codexLegacyA, { recursive: true });
    fs.writeFileSync(claudeConfigA, '{}\n');
    fs.writeFileSync(codexConfigA, '{}\n');
    fs.writeFileSync(path.join(claudeLegacyA, 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(codexLegacyA, 'run.sh'), '#!/bin/sh\n');
    markLegacyHookBundleCleanup(
      resolveManagedHookTransactionAddress('claude-code', claudeConfigA, projectA),
      [{ id: 'claude-old', fingerprint: captureBundleTreeFingerprint(claudeLegacyA) ?? '' }],
      '{}\n'
    );
    markLegacyHookBundleCleanup(
      resolveManagedHookTransactionAddress('codex', codexConfigA, projectA),
      [{ id: 'codex-old', fingerprint: captureBundleTreeFingerprint(codexLegacyA) ?? '' }],
      '{}\n'
    );

    fs.renameSync(projectA, projectB);
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: [], agentSync: { codex: { enabled: [] } } }),
      { project: projectB }
    );
    const first = distributeHooks(
      { project: projectB },
      ['claude-code', 'codex'],
      new Set(['claude-code', 'codex'])
    );
    const second = distributeHooks(
      { project: projectB },
      ['claude-code', 'codex'],
      new Set(['claude-code', 'codex'])
    );

    assert.equal(
      first.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(
      second.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(
      fs.existsSync(path.join(getProjectClaudeDir(projectB), 'hooks', 'asb', 'claude-old')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(getProjectCodexDir(projectB), 'hooks', 'asb', 'codex-old')),
      false
    );
    assert.equal(
      fs.existsSync(
        `${resolveManagedHookStatePath(
          'claude-code',
          path.join(getProjectClaudeDir(projectB), 'settings.local.json'),
          projectB
        )}.legacy-bundles`
      ),
      false
    );
    assert.equal(
      fs.existsSync(
        `${resolveManagedHookStatePath(
          'codex',
          getProjectCodexHooksJsonPath(projectB),
          projectB
        )}.legacy-bundles`
      ),
      false
    );
  });
});

test('distributeHooks: claude-code removes markerless legacy hooks after a project rename', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectA = path.join(agentsHome, 'legacy-claude-a');
    const projectB = path.join(agentsHome, 'legacy-claude-b');
    const settingsPathA = path.join(getProjectClaudeDir(projectA), 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPathA), { recursive: true });
    fs.writeFileSync(
      settingsPathA,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              _asb_source: true,
              hooks: [
                {
                  type: 'command',
                  command: path.join(projectA, '.claude', 'hooks', 'asb', 'old-hook', 'run.sh'),
                },
              ],
            },
          ],
        },
        _asb_managed_hooks: ['old-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }), {
      project: projectA,
    });

    fs.renameSync(projectA, projectB);
    distributeHooks({ project: projectB }, ['claude-code'], new Set(['claude-code']));

    const settingsPathB = path.join(getProjectClaudeDir(projectB), 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPathB, 'utf-8')) as Record<string, unknown>;
    assertNoAsbOwnershipTokens(settings);
  });
});

test('distributeHooks: codex removes markerless legacy hooks after a project rename', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectA = path.join(agentsHome, 'legacy-codex-a');
    const projectB = path.join(agentsHome, 'legacy-codex-b');
    const hooksJsonPathA = getProjectCodexHooksJsonPath(projectA);
    fs.mkdirSync(path.dirname(hooksJsonPathA), { recursive: true });
    fs.writeFileSync(
      hooksJsonPathA,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              _asb_source: true,
              hooks: [
                {
                  type: 'command',
                  command: path.join(projectA, '.codex', 'hooks', 'asb', 'old-hook', 'run.sh'),
                },
              ],
            },
          ],
        },
        _asb_managed_hooks: ['old-hook'],
      })
    );
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: [], agentSync: { codex: { enabled: [] } } }),
      { project: projectA }
    );

    fs.renameSync(projectA, projectB);
    distributeHooks({ project: projectB }, ['codex'], new Set(['codex']));

    assert.equal(fs.existsSync(getProjectCodexHooksJsonPath(projectB)), false);
  });
});

test('distributeHooks: codex changed hooks report review requirement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('review-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['review-hook'],
      agentSync: { codex: { enabled: ['review-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'new or changed Codex hooks should tell users to review them in /hooks'
    );
  });
});

test('distributeHooks: filters http handlers for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createHttpHandlerHook('http-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['http-hook'],
      agentSync: { codex: { enabled: ['http-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'skipped' &&
          r.entryId === 'http-hook' &&
          r.reason?.includes('unsupported handler types') &&
          r.reason.includes('http')
      ),
      'unsupported handler type should produce a visible Codex diagnostic'
    );

    // http handlers must not appear in codex hooks.json
    const hooksJsonPath = getCodexHooksJsonPath();
    if (fs.existsSync(hooksJsonPath)) {
      const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const hooks = content.hooks as Record<string, unknown[]> | undefined;
      if (hooks?.SessionStart) {
        for (const group of hooks.SessionStart as Array<{ hooks: Array<{ type: string }> }>) {
          for (const h of group.hooks) {
            assert.notEqual(h.type, 'http', 'http handlers should not appear in codex hooks.json');
          }
        }
      }
    }
  });
});

test('distributeHooks: filters asynchronous command handlers for codex', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksDir = ensureHooksDirectory();
    fs.writeFileSync(
      path.join(hooksDir, 'async-hook.json'),
      JSON.stringify({
        name: 'async-hook',
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo async', async: true }] }],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: ['async-hook'],
      agentSync: { codex: { enabled: ['async-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'codex' &&
          result.entryId === 'async-hook' &&
          result.status === 'skipped' &&
          result.reason?.includes('async command handlers')
      )
    );
    if (fs.existsSync(getCodexHooksJsonPath())) {
      const content = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')) as {
        hooks?: Record<string, unknown[]>;
      };
      assert.equal(content.hooks?.SessionStart, undefined);
    }
  });
});

test('distributeHooks: codex never writes invalid managed command timeouts', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'invalid-timeout-hook';
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), `${id}.json`),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'echo negative', timeout: -1 },
                { type: 'command', command: 'echo fractional', timeout: 1.5 },
                {
                  type: 'command',
                  command: 'echo unsafe',
                  timeout: Number.MAX_SAFE_INTEGER + 1,
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    const first = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const second = distributeHooks(undefined, ['codex'], new Set(['codex']));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    const disabled = distributeHooks(undefined, ['codex'], new Set(['codex']));

    for (const outcome of [first, second, disabled]) {
      assert.equal(
        outcome.results.some((result) => result.status === 'error'),
        false
      );
    }
    assert.ok(
      first.results.some(
        (result) => result.entryId === id && result.reason?.includes('invalid command timeout')
      )
    );
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
  });
});

test('distributeHooks: codex projects managed handlers onto native fields', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'native-field-projection';
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), `${id}.json`),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '',
              extraGroupField: 'drop',
              hooks: [
                {
                  type: 'command',
                  command: 'echo native',
                  timeout: 5,
                  statusMessage: 'running',
                  once: true,
                  headers: { Authorization: 'drop' },
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const file = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')) as {
      hooks: { SessionStart: Array<Record<string, unknown>> };
    };
    const group = file.hooks.SessionStart[0] as {
      hooks: Array<Record<string, unknown>>;
      extraGroupField?: unknown;
    };
    const handler = group.hooks[0] ?? {};

    assert.equal(group.extraGroupField, undefined);
    assert.deepEqual(handler, {
      type: 'command',
      command: 'echo native',
      timeout: 5,
      statusMessage: 'running',
    });
    assert.ok(outcome.results.some((result) => result.reason?.includes('once')));
    assert.ok(outcome.results.some((result) => result.reason?.includes('headers')));
  });
});

test('distributeHooks: preserves existing user hooks in codex hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    // Write a pre-existing user hook in hooks.json
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            },
          ],
        },
      })
    );
    createCodexCompatibleHook('asb-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['asb-hook'],
      agentSync: { codex: { enabled: ['asb-hook'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    const commands = codexGroupCommands(groups);
    assert.ok(!JSON.stringify(content).includes('_asb_source'));
    assert.ok(commands.some((command) => command.includes('echo user-hook')));
    assert.ok(commands.some((command) => command === 'echo test-codex'));
    assert.ok(commands.every((command) => !command.includes('asb-managed-by')));
    assertNoAsbOwnershipTokens(content);
  });
});

test('distributeHooks: codex removes disabled standalone hooks from external state', () => {
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
    createCodexCompatibleHook('managed-standalone');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['managed-standalone'],
      agentSync: { codex: { enabled: ['managed-standalone'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    assert.deepEqual(codexGroupCommands(content.hooks.UserPromptSubmit), ['echo user-hook']);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
    assert.ok(!JSON.stringify(content).includes('_asb_'));
  });
});

test('distributeHooks: codex preserves an identical user hook across resync and disable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const userGroup = {
      matcher: '',
      hooks: [{ type: 'command', command: 'echo test-codex' }],
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { UserPromptSubmit: [userGroup] } }));
    createCodexCompatibleHook('identical-managed-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['identical-managed-hook'],
      agentSync: { codex: { enabled: ['identical-managed-hook'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(content.hooks.UserPromptSubmit, [userGroup]);
  });
});

test('distributeHooks: codex rolls back when final managed state commit fails', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = '{"preferredNotifChannel":"notifications_disabled"}\n';
    fs.writeFileSync(hooksJsonPath, original);
    createCodexCompatibleHook('state-failure-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['state-failure-hook'],
      agentSync: { codex: { enabled: ['state-failure-hook'] } },
    }));
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    let outcome: ReturnType<typeof distributeHooks> | undefined;

    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.ok(!outcome?.results.some((result) => result.status === 'written'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('distributeHooks: codex aborts when managed hook state is corrupt', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = '{"preferredNotifChannel":"notifications_disabled"}\n';
    fs.writeFileSync(hooksJsonPath, original);
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      '{"version":1,"hooks":{"UserPromptSubmit":[{}]},"prefixLengths":{"UserPromptSubmit":0}}'
    );
    createCodexCompatibleHook('blocked-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['blocked-hook'],
      agentSync: { codex: { enabled: ['blocked-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'codex' &&
          result.status === 'error' &&
          result.error?.includes('Cannot read managed hook state')
      )
    );
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
  });
});

test('distributeHooks: codex rejects non-command handlers in managed state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original =
      '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo user"}]}]}}\n';
    fs.writeFileSync(hooksJsonPath, original);
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'http', url: 'https://example.com/hook' }] }],
        },
        prefixLengths: { UserPromptSubmit: 0 },
      })
    );

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (result) =>
          result.status === 'error' && result.error?.includes('Cannot read managed hook state')
      )
    );
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
  });
});

test('distributeHooks: codex reports managed standalone drift without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const identicalUserGroup = {
      matcher: '',
      hooks: [{ type: 'command', command: 'echo test-codex' }],
    };
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [identicalUserGroup] } })
    );
    createCodexCompatibleHook('drifted-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['drifted-hook'],
      agentSync: { codex: { enabled: ['drifted-hook'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    const managedGroup = content.hooks.UserPromptSubmit[content.hooks.UserPromptSubmit.length - 1];
    assert.ok(managedGroup);
    managedGroup.hooks[0].timeout = 99;
    (managedGroup as Record<string, unknown>)._asb_source = true;
    fs.writeFileSync(hooksJsonPath, `${JSON.stringify(content, null, 2)}\n`);
    const before = fs.readFileSync(hooksJsonPath, 'utf-8');
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), before);
  });
});

test('distributeHooks: codex does not consume an identical user group after suffix loss', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const userGroup = {
      matcher: '',
      hooks: [{ type: 'command', command: 'echo test-codex' }],
    };
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: { UserPromptSubmit: [userGroup] } }));
    createCodexCompatibleHook('lost-managed-suffix');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['lost-managed-suffix'],
      agentSync: { codex: { enabled: ['lost-managed-suffix'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    content.hooks.UserPromptSubmit.pop();
    fs.writeFileSync(hooksJsonPath, `${JSON.stringify(content, null, 2)}\n`);
    const before = fs.readFileSync(hooksJsonPath, 'utf-8');

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), before);
    assert.deepEqual(
      (JSON.parse(before) as { hooks: Record<string, unknown[]> }).hooks.UserPromptSubmit,
      [userGroup]
    );
  });
});

test('distributeHooks: codex finalizes an interrupted empty ownership state', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const previousConfig =
      '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo old"}]}]}}\n';
    const desiredConfig = '{"hooks":{}}\n';
    const previous = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo old' }] }],
    };
    fs.writeFileSync(hooksJsonPath, desiredConfig);
    writePendingManagedState('codex', hooksJsonPath, previousConfig, desiredConfig, previous, {});
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
  });
});

test('distributeHooks: preserves a symlinked Codex hooks file when clearing it', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const realHooksPath = path.join(agentsHome, 'real-codex-hooks.json');
    fs.writeFileSync(realHooksPath, '{}\n');
    fs.symlinkSync(realHooksPath, hooksJsonPath);
    createCodexCompatibleHook('symlinked-hooks-file');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['symlinked-hooks-file'],
      agentSync: { codex: { enabled: ['symlinked-hooks-file'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(fs.lstatSync(hooksJsonPath).isSymbolicLink(), true);
    const content = JSON.parse(fs.readFileSync(realHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.deepEqual(content.hooks, {});
    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
  });
});

test('distributeHooks: cleans ASB hooks from codex when selection is empty', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');

    // Pre-populate hooks.json with an ASB-managed group
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
                  command: `echo asb\n${CODEX_ASB_MANAGED_MARKER}\n${codexAsbHookIdMarker('old-hook')}`,
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
      })
    );

    // Empty selection for codex
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    const commands = codexGroupCommands(groups);
    assert.ok(!JSON.stringify(content).includes('_asb_source'));
    assert.ok(!JSON.stringify(content).includes('_asb_managed_hooks'));
    assert.deepEqual(commands, ['echo user']);
  });
});

test('distributeHooks: codex removes only legacy handlers from mixed groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup',
              hooks: [
                {
                  type: 'command',
                  command: path.join(getCodexDir(), 'hooks', 'asb', 'legacy', 'run.sh'),
                },
                { type: 'command', command: 'echo user' },
              ],
            },
          ],
        },
        _asb_managed_hooks: ['legacy'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    assert.deepEqual(content.hooks.SessionStart, [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user' }] },
    ]);
    assertNoAsbOwnershipTokens(content);
  });
});

test('distributeHooks: codex removes legacy-marked multi-handler groups', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const handlers = [
      { type: 'command', command: 'echo legacy' },
      { type: 'command', command: 'echo user' },
    ];
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: handlers, _asb_source: true }] },
        _asb_managed_hooks: ['legacy'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(fs.existsSync(hooksJsonPath), false);
  });
});

test('distributeHooks: codex preserves unowned relocated asb-like paths', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const foreignCommand = path.join(
      agentsHome,
      'foreign',
      '.codex',
      'hooks',
      'asb',
      'user-hook',
      'run.sh'
    );
    const localSameId = path.join(getCodexDir(), 'hooks', 'asb', 'user-hook');
    fs.mkdirSync(localSameId, { recursive: true });
    fs.writeFileSync(path.join(localSameId, 'keep.txt'), 'local user directory\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: foreignCommand }] }],
        },
        _asb_managed_hooks: ['user-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    assert.equal(content.hooks.SessionStart[0].hooks[0].command, foreignCommand);
    assert.equal(
      fs.readFileSync(path.join(localSameId, 'keep.txt'), 'utf-8'),
      'local user directory\n'
    );
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

    const claudeResults = outcome.results.filter((r) => r.platform === 'claude-code');
    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(claudeResults.length > 0, 'should produce claude-code results');
    assert.ok(codexResults.length > 0, 'should produce codex results');
  });
});

test('distributeHooks: neutral managed roots preserve foreign bundle directories', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code', 'codex');
    const claudeForeign = path.join(getClaudeDir(), 'hooks', 'managed', 'foreign-tool');
    const codexForeign = path.join(getCodexDir(), 'hooks', 'managed', 'foreign-tool');
    fs.mkdirSync(claudeForeign, { recursive: true });
    fs.mkdirSync(codexForeign, { recursive: true });
    fs.writeFileSync(path.join(claudeForeign, 'keep.txt'), 'claude\n');
    fs.writeFileSync(path.join(codexForeign, 'keep.txt'), 'codex\n');
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['claude-code', 'codex']);

    assert.equal(fs.readFileSync(path.join(claudeForeign, 'keep.txt'), 'utf-8'), 'claude\n');
    assert.equal(fs.readFileSync(path.join(codexForeign, 'keep.txt'), 'utf-8'), 'codex\n');
  });
});

// ---------------------------------------------------------------------------
// Additional coverage for Codex hook distribution
// ---------------------------------------------------------------------------

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

test('distributeHooks: codex bundle hook copies files and rewrites HOOK_DIR', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-test');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-test'],
      agentSync: { codex: { enabled: ['bundle-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const command = hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    assert.ok(command, 'should have a command');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal check
    assert.ok(!command.includes('${HOOK_DIR}'), 'HOOK_DIR should be rewritten');
    assert.ok(command.includes(codexManagedBundleRoot()), 'should reference managed bundle dir');
    assert.ok(!command.includes('hook-bundle-sha256'));
    assert.ok(!command.includes('asb-managed-by'));
    assert.ok(!command.includes('asb-hook-id'));
    assert.ok(!command.includes('asb-bundle-sha256'));
    assert.ok(!JSON.stringify(content).includes('_asb_source'));
    assertNoAsbOwnershipTokens(content);
  });
});

test('distributeHooks: codex rewrites Windows command overrides for bundle hooks', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'bundle-windows-command';
    const bundleDir = path.join(ensureHooksDirectory(), id);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, 'hook.json'),
      JSON.stringify({
        name: id,
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
                  command: '${HOOK_DIR}/run.sh',
                  commandWindows: '& "$env:CLAUDE_PLUGIN_ROOT\\hooks\\run.ps1"',
                  command_windows: '& "$env:CLAUDE_PLUGIN_ROOT\\hooks\\run.ps1"',
                },
                {
                  type: 'command',
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
                  command: '${HOOK_DIR}/run.sh',
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
                  command_windows: '& "${CLAUDE_PLUGIN_ROOT}\\hooks\\run.ps1"',
                },
              ],
            },
          ],
        },
      })
    );
    fs.writeFileSync(path.join(bundleDir, 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(bundleDir, 'run.ps1'), 'Write-Output test\n');
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const content = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')) as {
      hooks: Record<
        string,
        Array<{
          hooks: Array<{
            command: string;
            commandWindows: string;
            command_windows?: string;
          }>;
        }>
      >;
    };
    const handlers = content.hooks.UserPromptSubmit[0].hooks;

    for (const handler of handlers) {
      for (const command of [handler.command, handler.commandWindows]) {
        assert.ok(command.includes(codexManagedBundleRoot()));
        assert.doesNotMatch(command, /HOOK_DIR|CLAUDE_PLUGIN_ROOT/);
      }
      assert.equal(handler.command_windows, undefined);
    }
  });
});

test('distributeHooks: opaque bundle paths contain hostile source namespaces', () => {
  withTempHomes(({ asbHome }) => {
    simulateAppsInstalled('claude-code', 'codex');
    const namespace = '../../../foreign';
    const pluginDir = path.join(asbHome, 'external', 'hostile-namespace-plugin');
    const hooksDir = path.join(pluginDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: 'command',
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder
                  command: '${HOOK_DIR}/run.sh',
                },
              ],
            },
          ],
        },
      })
    );
    fs.writeFileSync(path.join(hooksDir, 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(
      path.join(asbHome, 'config.toml'),
      `[plugins.sources]\n"${namespace}" = "${pluginDir}"\n`
    );
    const hookId = `${namespace}:hooks`;
    updateLibraryStateSection('hooks', () => ({
      enabled: [hookId],
      agentSync: { codex: { enabled: [hookId] } },
    }));
    const claudeEscaped = path.resolve(claudeManagedBundleRoot(), hookId);
    const codexEscaped = path.resolve(codexManagedBundleRoot(), 'deployment', hookId);
    fs.mkdirSync(claudeEscaped, { recursive: true });
    fs.mkdirSync(codexEscaped, { recursive: true });
    fs.writeFileSync(path.join(claudeEscaped, 'keep.txt'), 'claude\n');
    fs.writeFileSync(path.join(codexEscaped, 'keep.txt'), 'codex\n');

    const outcome = distributeHooks(
      undefined,
      ['claude-code', 'codex'],
      new Set(['claude-code', 'codex'])
    );
    assert.ok(outcome.results.every((result) => result.status !== 'error'));

    const claudeSettings = JSON.parse(
      fs.readFileSync(path.join(getClaudeDir(), 'settings.json'), 'utf-8')
    ) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const codexHooks = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const claudeTarget = path.dirname(claudeSettings.hooks.UserPromptSubmit[0].hooks[0].command);
    const codexTarget = path.dirname(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command);
    const resolvedClaudeTarget = claudeTarget.replace('$HOME', os.homedir());
    const resolvedCodexTarget = codexTarget.replace('$HOME', os.homedir());
    assert.ok(
      path.relative(claudeManagedBundleRoot(), resolvedClaudeTarget).split(path.sep).length === 1
    );
    assert.ok(
      path.relative(codexManagedBundleRoot(), resolvedCodexTarget).split(path.sep).length === 1
    );
    assert.equal(fs.readFileSync(path.join(claudeEscaped, 'keep.txt'), 'utf-8'), 'claude\n');
    assert.equal(fs.readFileSync(path.join(codexEscaped, 'keep.txt'), 'utf-8'), 'codex\n');
  });
});

test('distributeHooks: codex bundle digest separates binary fields and file records', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'bundle-framing';
    createBundleHook(id);
    const bundleDir = path.join(ensureHooksDirectory(), id);
    fs.writeFileSync(path.join(bundleDir, 'a'), Buffer.from('left\0mode:0\0b\0right'));
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const firstCommand = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')).hooks
      .UserPromptSubmit[0].hooks[0].command as string;

    fs.writeFileSync(path.join(bundleDir, 'a'), 'left');
    fs.writeFileSync(path.join(bundleDir, 'b'), 'right');
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const secondCommand = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')).hooks
      .UserPromptSubmit[0].hooks[0].command as string;

    assert.notEqual(secondCommand, firstCommand);
  });
});

test('distributeHooks: codex bundle state is idempotent and cleans on disable', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-bundle-lifecycle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-bundle-lifecycle'],
      agentSync: { codex: { enabled: ['codex-bundle-lifecycle'] } },
    }));
    const hooksJsonPath = getCodexHooksJsonPath();
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleDir = codexBundleTargetDir(hooksJsonPath);
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const active = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
    };
    assert.equal(active.hooks.UserPromptSubmit.length, 1);
    assert.equal(fs.existsSync(bundleDir), true);

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    assert.equal(fs.existsSync(hooksJsonPath), false);
    assert.equal(fs.existsSync(bundleDir), false);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
  });
});

test('distributeHooks: codex bundle cleanup is isolated by config identity', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const targetA = path.join(agentsHome, 'codex-hooks-a.json');
    const targetB = path.join(agentsHome, 'codex-hooks-b.json');
    if (fs.existsSync(hooksJsonPath)) fs.unlinkSync(hooksJsonPath);
    fs.writeFileSync(targetA, '{}\n');
    fs.writeFileSync(targetB, '{}\n');
    fs.symlinkSync(targetA, hooksJsonPath);
    createBundleHook('codex-config-identity-bundle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-config-identity-bundle'],
      agentSync: { codex: { enabled: ['codex-config-identity-bundle'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleA = codexBundleTargetDir(hooksJsonPath);
    assert.equal(fs.existsSync(bundleA), true);

    fs.unlinkSync(hooksJsonPath);
    fs.symlinkSync(targetB, hooksJsonPath);
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleB = codexBundleTargetDir(hooksJsonPath);
    assert.notEqual(bundleB, bundleA);
    assert.equal(fs.existsSync(bundleB), true);

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(fs.existsSync(bundleA), true);
    assert.equal(fs.existsSync(bundleB), false);
  });
});

test('distributeHooks: codex orphan quarantine does not follow a replacement symlink', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-orphan-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-orphan-race'],
      agentSync: { codex: { enabled: ['codex-orphan-race'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleDir = codexBundleTargetDir();
    const outside = path.join(agentsHome, 'codex-orphan-outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'protected\n');
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        const result = originalRenameSync(oldPath, newPath);
        if (!swapped && path.resolve(String(oldPath)) === path.resolve(bundleDir)) {
          swapped = true;
          fs.symlinkSync(outside, bundleDir);
        }
        return result;
      }) as typeof fs.renameSync;
      distributeHooks(undefined, ['codex'], new Set(['codex']));
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf-8'), 'protected\n');
    assert.equal(fs.lstatSync(bundleDir).isSymbolicLink(), true);
  });
});

test('distributeHooks: orphan cleanup fails closed when its parent is swapped', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-parent-swap');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-parent-swap'],
      agentSync: { codex: { enabled: ['codex-parent-swap'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleParent = path.dirname(codexBundleTargetDir());
    const heldParent = `${bundleParent}.held`;
    const outsideParent = path.join(agentsHome, 'outside-parent-swap');
    const outsideFile = path.join(outsideParent, 'victim', 'keep.txt');
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(outsideFile, 'protected\n');
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const originalReaddirSync = fs.readdirSync;
    let swapped = false;
    try {
      fs.readdirSync = ((target: fs.PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
        if (!swapped && path.resolve(String(target)) === path.resolve(bundleParent)) {
          swapped = true;
          fs.renameSync(bundleParent, heldParent);
          fs.symlinkSync(outsideParent, bundleParent);
        }
        return originalReaddirSync(target, options as never);
      }) as typeof fs.readdirSync;
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
      assert.ok(outcome.results.some((result) => result.status === 'error'));
    } finally {
      fs.readdirSync = originalReaddirSync;
      if (fs.lstatSync(bundleParent).isSymbolicLink()) fs.unlinkSync(bundleParent);
      if (fs.existsSync(heldParent)) fs.renameSync(heldParent, bundleParent);
    }

    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'protected\n');
  });
});

test('distributeHooks: codex failed orphan deletion preserves a concurrent replacement', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-orphan-delete-failure');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-orphan-delete-failure'],
      agentSync: { codex: { enabled: ['codex-orphan-delete-failure'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleDir = codexBundleTargetDir();
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    let replaced = false;
    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (!replaced && path.basename(target).startsWith('.delete.')) {
          replaced = true;
          fs.writeFileSync(bundleDir, 'concurrent replacement\n');
          throw new Error('mock quarantined orphan delete failure');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );
    assert.ok(outcome.results.some((result) => result.status === 'error'));

    assert.equal(replaced, true);
    assert.equal(fs.readFileSync(bundleDir, 'utf-8'), 'concurrent replacement\n');
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));
  });
});

test('distributeHooks: codex keeps a bundle restored by a concurrent config edit', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-concurrent-config-cleanup');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-concurrent-config-cleanup'],
      agentSync: { codex: { enabled: ['codex-concurrent-config-cleanup'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const previousConfig = fs.readFileSync(hooksJsonPath, 'utf-8');
    const bundleDir = codexBundleTargetDir();
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const originalReaddirSync = fs.readdirSync;
    let edited = false;
    try {
      fs.readdirSync = ((target: fs.PathLike, options?: Parameters<typeof fs.readdirSync>[1]) => {
        if (!edited && path.resolve(String(target)) === path.resolve(bundleParent)) {
          edited = true;
          fs.writeFileSync(hooksJsonPath, previousConfig);
        }
        return originalReaddirSync(target, options as never);
      }) as typeof fs.readdirSync;
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
      assert.ok(outcome.results.some((result) => result.status === 'error'));
    } finally {
      fs.readdirSync = originalReaddirSync;
    }

    assert.equal(edited, true);
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), previousConfig);
    assert.equal(fs.existsSync(bundleDir), true);
  });
});

test('distributeHooks: codex drift conflict does not update bundle files', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('codex-drifted-bundle');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['codex-drifted-bundle'],
      agentSync: { codex: { enabled: ['codex-drifted-bundle'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    content.hooks.UserPromptSubmit[0].timeout = 99;
    const targetScript = path.join(codexBundleTargetDir(hooksJsonPath), 'run.sh');
    fs.writeFileSync(hooksJsonPath, `${JSON.stringify(content, null, 2)}\n`);
    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'codex-drifted-bundle', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'conflict'));
    assert.equal(fs.readFileSync(targetScript, 'utf-8'), '#!/bin/sh\necho test\n');
  });
});

test('distributeHooks: codex bundle content changes update review surface', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-review-test');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-review-test'],
      agentSync: { codex: { enabled: ['bundle-review-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const firstContent = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const firstHooks = firstContent.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const firstCommand = firstHooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
    assert.ok(firstCommand);
    assert.ok(!firstCommand.includes('hook-bundle-sha256'));
    assert.ok(!firstCommand?.includes('asb-managed-by'));
    assert.ok(!firstCommand?.includes('asb-hook-id'));
    assert.ok(!firstCommand?.includes('asb-bundle-sha256'));

    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'bundle-review-test', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const secondContent = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const secondHooks = secondContent.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string }> }>
    >;
    const secondCommand = secondHooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command;

    assert.notEqual(secondCommand, firstCommand, 'bundle content change should alter hooks.json');
    assert.ok(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'conflict' && r.reason?.includes('/hooks')
      ),
      'bundle content change should report Codex review requirement'
    );
  });
});

test('distributeHooks: codex bundle update keeps the active bundle on state commit failure', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-state-failure');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-state-failure'],
      agentSync: { codex: { enabled: ['bundle-state-failure'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    const originalConfig = fs.readFileSync(hooksJsonPath, 'utf-8');
    const originalBundleDir = codexBundleTargetDir(hooksJsonPath);
    const originalScript = path.join(originalBundleDir, 'run.sh');
    assert.equal(fs.readFileSync(originalScript, 'utf-8'), '#!/bin/sh\necho test\n');

    fs.writeFileSync(
      path.join(ensureHooksDirectory(), 'bundle-state-failure', 'run.sh'),
      '#!/bin/sh\necho changed\n'
    );
    let outcome: ReturnType<typeof distributeHooks> | undefined;
    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), originalConfig);
    assert.equal(codexBundleTargetDir(hooksJsonPath), originalBundleDir);
    assert.equal(fs.readFileSync(originalScript, 'utf-8'), '#!/bin/sh\necho test\n');
  });
});

test('distributeHooks: codex mode update keeps the active bundle on state commit failure', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-mode-state-failure');
    const sourceScript = path.join(ensureHooksDirectory(), 'bundle-mode-state-failure', 'run.sh');
    fs.chmodSync(sourceScript, 0o644);
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-mode-state-failure'],
      agentSync: { codex: { enabled: ['bundle-mode-state-failure'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const hooksJsonPath = getCodexHooksJsonPath();
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    const originalConfig = fs.readFileSync(hooksJsonPath, 'utf-8');
    const originalBundleDir = codexBundleTargetDir(hooksJsonPath);
    const originalScript = path.join(originalBundleDir, 'run.sh');
    assert.equal(fs.statSync(originalScript).mode & 0o111, 0);

    fs.chmodSync(sourceScript, 0o755);
    let outcome: ReturnType<typeof distributeHooks> | undefined;
    failSecondStateCommit(statePath, () => {
      outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    });

    assert.ok(outcome?.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), originalConfig);
    assert.equal(codexBundleTargetDir(hooksJsonPath), originalBundleDir);
    assert.equal(fs.statSync(originalScript).mode & 0o111, 0);
  });
});

test('distributeHooks: codex deploys the captured bundle snapshot when the source races', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-source-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-source-race'],
      agentSync: { codex: { enabled: ['bundle-source-race'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const sourceScript = path.join(ensureHooksDirectory(), 'bundle-source-race', 'run.sh');
    fs.writeFileSync(sourceScript, '#!/bin/sh\necho captured\n');
    const originalMkdtempSync = fs.mkdtempSync;
    try {
      fs.mkdtempSync = ((prefix: string, options?: BufferEncoding | null) => {
        if (prefix.includes('asb-hooks-')) {
          fs.writeFileSync(sourceScript, '#!/bin/sh\necho raced\n');
        }
        return originalMkdtempSync(prefix, options as BufferEncoding);
      }) as typeof fs.mkdtempSync;
      distributeHooks(undefined, ['codex'], new Set(['codex']));
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
    }

    const targetScript = path.join(codexBundleTargetDir(), 'run.sh');
    assert.equal(fs.readFileSync(targetScript, 'utf-8'), '#!/bin/sh\necho captured\n');
    assert.equal(fs.readFileSync(sourceScript, 'utf-8'), '#!/bin/sh\necho raced\n');
  });
});

test('distributeHooks: codex uses hook definitions from the captured bundle', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'codex-definition-race';
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional hook placeholder
    const hookDirPlaceholder = '${HOOK_DIR}';
    const bundleDir = path.join(ensureHooksDirectory(), id);
    const hookJsonPath = path.join(bundleDir, 'hook.json');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'old.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hookJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: `${hookDirPlaceholder}/old.sh` }] }],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    const originalReadFileSync = fs.readFileSync;
    let definitionReads = 0;
    try {
      fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
        const value = originalReadFileSync(file, options as never);
        if (path.resolve(String(file)) === hookJsonPath) {
          definitionReads += 1;
        }
        if (definitionReads === 3) {
          definitionReads += 1;
          fs.unlinkSync(path.join(bundleDir, 'old.sh'));
          fs.writeFileSync(path.join(bundleDir, 'new.sh'), '#!/bin/sh\necho new\n');
          fs.writeFileSync(
            hookJsonPath,
            JSON.stringify({
              hooks: {
                SessionStart: [
                  { hooks: [{ type: 'command', command: `${hookDirPlaceholder}/new.sh` }] },
                ],
              },
            })
          );
        }
        return value;
      }) as typeof fs.readFileSync;
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
      assert.ok(
        outcome.results.every((result) => result.status !== 'error'),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    const hooksFile = JSON.parse(fs.readFileSync(getCodexHooksJsonPath(), 'utf-8')) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = hooksFile.hooks.SessionStart[0]?.hooks[0]?.command ?? '';
    assert.match(command, /new\.sh$/);
    assert.equal(fs.existsSync(command.replace('$HOME', os.homedir())), true);
    assert.doesNotMatch(command, /old\.sh$/);
  });
});

test('distributeHooks: executable mode drift is repaired for codex bundles', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-mode-test');
    const sourceScript = path.join(ensureHooksDirectory(), 'bundle-mode-test', 'run.sh');
    fs.chmodSync(sourceScript, 0o755);
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-mode-test'],
      agentSync: { codex: { enabled: ['bundle-mode-test'] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const targetDir = codexBundleTargetDir();
    const targetScript = path.join(targetDir, 'run.sh');
    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);

    fs.chmodSync(targetScript, 0o644);
    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === targetDir);

    assert.equal(fs.statSync(targetScript).mode & 0o111, 0o111);
    assert.equal(result?.status, 'written');
    assert.equal(result?.reason, 'updated');
    assert.equal(result?.filesWritten, 1);
    assert.equal(result?.filesSkipped, 1);
  });
});

test('distributeHooks: codex bundle copy failure aborts hooks.json merge', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createBundleHook('broken-bundle');
    const bundleDir = path.join(ensureHooksDirectory(), 'broken-bundle');
    fs.symlinkSync(path.join(bundleDir, 'missing.sh'), path.join(bundleDir, 'broken.sh'));
    updateLibraryStateSection('hooks', () => ({
      enabled: ['broken-bundle'],
      agentSync: { codex: { enabled: ['broken-bundle'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'),
      'bundle copy failure should be reported'
    );
    assert.equal(
      fs.existsSync(getCodexHooksJsonPath()),
      false,
      'hooks.json should not be written when bundle copy fails'
    );
  });
});

test('distributeHooks: codex rejects symlinked bundle parent before hooks.json merge', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-parent-symlink');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-parent-symlink'],
      agentSync: { codex: { enabled: ['bundle-parent-symlink'] } },
    }));

    const hooksLink = codexManagedBundleRoot();
    const outsideDir = path.join(agentsHome, 'outside-codex-hooks');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find((r) => r.platform === 'codex' && r.targetDir === hooksLink);

    assert.equal(fs.existsSync(path.join(outsideDir, 'bundle-parent-symlink')), false);
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked/);
  });
});

test('distributeHooks: codex rejects symlinked hook ancestor before hooks.json merge', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    createBundleHook('bundle-ancestor-symlink');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['bundle-ancestor-symlink'],
      agentSync: { codex: { enabled: ['bundle-ancestor-symlink'] } },
    }));

    const hooksLink = path.join(getCodexDir(), 'hooks');
    const outsideHooksDir = path.join(agentsHome, 'outside-codex-hooks-ancestor');
    fs.mkdirSync(outsideHooksDir, { recursive: true });
    fs.mkdirSync(path.join(outsideHooksDir, 'managed'), { recursive: true });
    fs.symlinkSync(outsideHooksDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find(
      (r) =>
        r.platform === 'codex' &&
        r.targetDir === path.join(hooksLink, 'managed', codexManagedBundleNamespace())
    );

    assert.equal(
      fs.existsSync(
        path.join(
          outsideHooksDir,
          'managed',
          codexManagedBundleNamespace(),
          'bundle-ancestor-symlink'
        )
      ),
      false
    );
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /refusing to follow symlinked path/);
  });
});

test('distributeHooks: codex does not infer bundle ownership from a legacy standalone ID', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');

    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo asb' }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['stale-hook'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const hooksLink = path.join(getCodexDir(), 'hooks', 'asb');
    const outsideDir = path.join(agentsHome, 'outside-codex-hook-cleanup');
    const outsideStaleDir = path.join(outsideDir, 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(path.dirname(hooksLink), { recursive: true });
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(fs.existsSync(hooksJsonPath), false);
    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
  });
});

test('distributeHooks: active standalone hooks preserve referenced legacy directories', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code', 'codex');
    const claudeId = 'active-claude-legacy-path';
    const codexId = 'active-codex-legacy-path';
    const claudeDir = path.join(getClaudeDir(), 'hooks', 'asb', claudeId);
    const codexDir = path.join(getCodexDir(), 'hooks', 'asb', codexId);
    const claudeScript = path.join(claudeDir, 'run.sh');
    const codexScript = path.join(codexDir, 'run.sh');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(claudeScript, '#!/bin/sh\n');
    fs.writeFileSync(codexScript, '#!/bin/sh\n');
    for (const [id, command] of [
      [claudeId, claudeScript],
      [codexId, codexScript],
    ]) {
      fs.writeFileSync(
        path.join(ensureHooksDirectory(), `${id}.json`),
        JSON.stringify({
          name: id,
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command }] }],
          },
        })
      );
    }
    updateLibraryStateSection('hooks', () => ({
      enabled: [claudeId],
      agentSync: { codex: { enabled: [codexId] } },
    }));

    distributeHooks(undefined, ['claude-code', 'codex'], new Set(['claude-code', 'codex']));
    const second = distributeHooks(
      undefined,
      ['claude-code', 'codex'],
      new Set(['claude-code', 'codex'])
    );

    assert.equal(
      second.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(claudeScript), true);
    assert.equal(fs.existsSync(codexScript), true);
    assert.equal(
      second.results.some(
        (result) =>
          result.status === 'deleted' &&
          (result.targetDir === claudeDir || result.targetDir === codexDir)
      ),
      false
    );
  });
});

test('distributeHooks: codex cleanup rejects symlinked hook ancestor before hooks.json write', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');

    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo asb' }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['stale-hook'],
      })
    );
    const before = fs.readFileSync(hooksJsonPath, 'utf-8');

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const hooksLink = path.join(getCodexDir(), 'hooks');
    const outsideHooksDir = path.join(agentsHome, 'outside-codex-cleanup-ancestor');
    const outsideStaleDir = path.join(outsideHooksDir, 'asb', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideHooksDir, hooksLink);

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find(
      (r) =>
        r.platform === 'codex' &&
        r.targetDir === path.join(hooksLink, 'managed', codexManagedBundleNamespace())
    );

    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), before);
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /refusing to follow symlinked path/);
  });
});

test('distributeHooks: codex cleanup rejects symlinked app root before hooks.json write', () => {
  withTempHomes(({ agentsHome }) => {
    const codexRoot = getCodexDir();
    const outsideRoot = path.join(agentsHome, 'outside-codex-root');
    const outsideStaleDir = path.join(outsideRoot, 'hooks', 'asb', 'stale-hook');
    const outsideFile = path.join(outsideStaleDir, 'protected.txt');
    fs.mkdirSync(outsideStaleDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'keep me\n');
    fs.symlinkSync(outsideRoot, codexRoot);

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    const result = outcome.results.find(
      (r) =>
        r.platform === 'codex' &&
        r.targetDir === path.join(codexRoot, 'hooks', 'managed', codexManagedBundleNamespace())
    );

    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'keep me\n');
    assert.equal(result?.status, 'error');
    assert.match(result?.error ?? '', /symlinked bundle root/);
  });
});

test('distributeHooks: codex mixed hook keeps supported events/handlers, drops unsupported', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createMixedHook('mixed-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['mixed-hook'],
      agentSync: { codex: { enabled: ['mixed-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(fs.existsSync(hooksJsonPath), 'hooks.json should exist');

    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;

    // UserPromptSubmit (supported event, command handler) should be present
    assert.ok(hooks.UserPromptSubmit, 'UserPromptSubmit should be present');
    // PreCompact is supported by current Codex and should be present
    assert.ok(hooks.PreCompact, 'PreCompact should be preserved');
    // SessionStart should have only the command handler, not the http one
    if (hooks.SessionStart) {
      for (const group of hooks.SessionStart as Array<{ hooks: Array<{ type: string }> }>) {
        for (const h of group.hooks) {
          assert.notEqual(h.type, 'http', 'http handler should be filtered out');
        }
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
      ),
      'partial filtering should produce a visible Codex diagnostic'
    );
  });
});

test('distributeHooks: codex idempotent re-sync updates ASB hooks without duplication', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('idempotent-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['idempotent-hook'],
      agentSync: { codex: { enabled: ['idempotent-hook'] } },
    }));

    // First sync
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    // Second sync (idempotent)
    distributeHooks(undefined, ['codex'], new Set(['codex']));

    const hooksJsonPath = getCodexHooksJsonPath();
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as Record<string, unknown>;
    const hooks = content.hooks as Record<string, unknown[]>;
    const groups = hooks.UserPromptSubmit as Array<Record<string, unknown>>;

    const asbGroups = groups.filter((g) =>
      codexGroupCommands([g]).some((command) => command === 'echo test-codex')
    );
    assert.ok(!JSON.stringify(content).includes('_asb_source'));
    assert.equal(
      asbGroups.length,
      1,
      'should have exactly 1 ASB group after re-sync, not duplicated'
    );
  });
});

test('distributeHooks: codex dryRun does not write hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    createCodexCompatibleHook('dryrun-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['dryrun-hook'],
      agentSync: { codex: { enabled: ['dryrun-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']), { dryRun: true });

    const codexResults = outcome.results.filter((r) => r.platform === 'codex');
    assert.ok(codexResults.length > 0, 'should produce results');

    const hooksJsonPath = getCodexHooksJsonPath();
    assert.ok(!fs.existsSync(hooksJsonPath), 'hooks.json should NOT be written in dryRun');
  });
});

test('distributeHooks: codex returns error for malformed hooks.json shape', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = '{"hooks":{"UserPromptSubmit":[{}]},"theme":"dark"}\n';
    fs.writeFileSync(hooksJsonPath, original);

    createCodexCompatibleHook('shape-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['shape-hook'],
      agentSync: { codex: { enabled: ['shape-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (result) =>
          result.platform === 'codex' &&
          result.status === 'error' &&
          result.error?.includes('invalid hook configuration')
      ),
      'should produce error result for malformed hooks.json'
    );
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
  });
});

test('distributeHooks: codex rejects explicit null hooks without mutation', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = '{"hooks":null,"theme":"dark"}\n';
    fs.writeFileSync(hooksJsonPath, original);
    createCodexCompatibleHook('null-hooks');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['null-hooks'],
      agentSync: { codex: { enabled: ['null-hooks'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('codex', hooksJsonPath)), false);
  });
});

test('distributeHooks: codex rejects command handlers without commands', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const original = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command"}]}]}}\n';
    fs.writeFileSync(hooksJsonPath, original);
    createCodexCompatibleHook('missing-command');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['missing-command'],
      agentSync: { codex: { enabled: ['missing-command'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), original);
  });
});

test('distributeHooks: codex returns error for malformed hooks.json root', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    fs.writeFileSync(hooksJsonPath, '[]');

    createCodexCompatibleHook('root-shape-hook');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['root-shape-hook'],
      agentSync: { codex: { enabled: ['root-shape-hook'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'error' &&
          r.error?.includes('root must be an object')
      ),
      'array root should produce invalid-shape error'
    );
  });
});

test('distributeHooks: codex defers orphan cleanup until hooks.json write succeeds', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb', 'old-bundle');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(path.join(oldBundleDir, 'run.sh'), '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `${oldBundleDir}/run.sh` }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['old-bundle'],
        preferredNotifChannel: 'notifications_disabled',
      })
    );
    const realHooksJsonPath = fs.realpathSync.native(hooksJsonPath);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const originalLinkSync = fs.linkSync;
    try {
      fs.linkSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(newPath)) === realHooksJsonPath) {
          throw new Error('mock hooks.json write failure');
        }
        return originalLinkSync(oldPath, newPath);
      }) as typeof fs.linkSync;
      const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

      assert.ok(
        outcome.results.some((r) => r.platform === 'codex' && r.status === 'error'),
        'write failure should be reported'
      );
      assert.ok(
        fs.existsSync(oldBundleDir),
        'orphan bundle should remain when hooks.json write fails'
      );
    } finally {
      fs.linkSync = originalLinkSync;
    }
  });
});

test('distributeHooks: codex cleans markerless orphan bundles after deleting empty hooks.json', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb', 'legacy-bundle');
    const oldBundleScript = path.join(oldBundleDir, 'run.sh');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(oldBundleScript, '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: oldBundleScript }],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

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
    assert.equal(fs.existsSync(oldBundleDir), false);
  });
});

test('distributeHooks: codex preserves unowned markerless legacy bundle directories', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb', 'retry-bundle');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(path.join(oldBundleDir, 'run.sh'), '#!/bin/sh\necho retry\n');

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some(
        (r) => r.platform === 'codex' && r.status === 'deleted' && r.entryId === 'retry-bundle'
      ),
      false
    );
    assert.equal(fs.existsSync(oldBundleDir), true);
  });
});

test('distributeHooks: codex retargeting does not clean legacy bundles owned by old config', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const targetA = path.join(agentsHome, 'legacy-codex-target-a.json');
    const targetB = path.join(agentsHome, 'legacy-codex-target-b.json');
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', 'legacy-retarget');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      targetA,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['legacy-retarget'],
      })
    );
    fs.writeFileSync(targetB, '{}\n');
    if (fs.existsSync(hooksJsonPath)) fs.unlinkSync(hooksJsonPath);
    fs.symlinkSync(targetA, hooksJsonPath);
    fs.unlinkSync(hooksJsonPath);
    fs.symlinkSync(targetB, hooksJsonPath);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(fs.existsSync(legacyScript), true);
    assert.match(fs.readFileSync(targetA, 'utf-8'), /hooks[/\\]asb/);
  });
});

test('distributeHooks: codex cleans only canonical legacy bundles for a config alias', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('codex');
    const projectA = path.join(agentsHome, 'legacy-owner-codex-a');
    const projectB = path.join(agentsHome, 'legacy-owner-codex-b');
    const aliasPath = getProjectCodexHooksJsonPath(projectA);
    const targetPath = getProjectCodexHooksJsonPath(projectB);
    const legacyA = path.join(getProjectCodexDir(projectA), 'hooks', 'asb', 'keep-a');
    const legacyB = path.join(getProjectCodexDir(projectB), 'hooks', 'asb', 'remove-b');
    fs.mkdirSync(path.dirname(aliasPath), { recursive: true });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.mkdirSync(legacyA, { recursive: true });
    fs.mkdirSync(legacyB, { recursive: true });
    fs.writeFileSync(path.join(legacyA, 'run.sh'), '#!/bin/sh\n');
    const legacyBScript = path.join(legacyB, 'run.sh');
    fs.writeFileSync(legacyBScript, '#!/bin/sh\n');
    fs.writeFileSync(
      targetPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyBScript }] }],
        },
        _asb_managed_hooks: ['remove-b'],
      })
    );
    fs.symlinkSync(targetPath, aliasPath);
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: [], agentSync: { codex: { enabled: [] } } }),
      { project: projectA }
    );

    const outcome = distributeHooks({ project: projectA }, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(legacyB), false);
    assert.equal(fs.existsSync(legacyA), true);
    assertNoAsbOwnershipTokens(JSON.parse(fs.readFileSync(targetPath, 'utf-8')));
  });
});

test('distributeHooks: codex removes legacy cleanup marker when orphan cleanup fails', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const oldBundleDir = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb', 'old-bundle');
    const bundleParentDir = path.dirname(oldBundleDir);
    const oldBundleScript = path.join(oldBundleDir, 'run.sh');
    fs.mkdirSync(oldBundleDir, { recursive: true });
    fs.writeFileSync(oldBundleScript, '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: `${oldBundleScript}` }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['old-bundle'],
      })
    );
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (path.dirname(target) === bundleParentDir) {
          throw new Error('mock bundle cleanup failure');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );
    assert.ok(
      outcome.results.some(
        (r) =>
          r.platform === 'codex' &&
          r.status === 'error' &&
          r.error?.includes('mock bundle cleanup failure')
      )
    );
    assert.equal(fs.existsSync(hooksJsonPath), false);
    assert.equal(fs.existsSync(oldBundleScript), false);
    assert.equal(fs.existsSync(cleanupMarker), true);

    const retryOutcome = distributeHooks(undefined, ['codex'], new Set(['codex']));
    assert.ok(retryOutcome.results.some((r) => r.platform === 'codex' && r.status === 'deleted'));
    assert.equal(fs.existsSync(oldBundleDir), false);
    assert.equal(fs.existsSync(cleanupMarker), false);
  });
});

test('distributeHooks: legacy cleanup retries an owned quarantine', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const bundleParent = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb');
    const legacyDir = path.join(bundleParent, 'retry-quarantine');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['retry-quarantine'],
      })
    );
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    let failed = false;
    const first = withAnchoredRemovalIntercept(
      (target) => {
        if (!failed && path.basename(target).startsWith('.delete.')) {
          failed = true;
          throw new Error('mock quarantine removal failure');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );
    assert.ok(first.results.some((result) => result.status === 'error'));

    assert.equal(failed, true);
    assert.equal(fs.existsSync(cleanupMarker), true);
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, 'keep.txt'), 'user replacement\n');

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));
    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'keep.txt'), 'utf-8'), 'user replacement\n');
    assert.deepEqual(fs.readdirSync(bundleParent), ['retry-quarantine']);
  });
});

test('distributeHooks: legacy cleanup refreshes ownership after a partial delete', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const bundleParent = path.join(path.dirname(hooksJsonPath), 'hooks', 'asb');
    const legacyDir = path.join(bundleParent, 'partial-delete');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(path.join(legacyDir, 'extra.txt'), 'remove first\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['partial-delete'],
      })
    );
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    let quarantinePath: string | undefined;
    const first = withAnchoredRemovalIntercept(
      (target) => {
        if (!quarantinePath && path.basename(target).startsWith('.delete.')) {
          quarantinePath = target;
          fs.unlinkSync(path.join(target, 'extra.txt'));
          throw new Error('mock partial quarantine removal');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );

    assert.ok(first.results.some((result) => result.status === 'error'));
    assert.ok(quarantinePath);
    const marker = JSON.parse(fs.readFileSync(cleanupMarker, 'utf-8')) as {
      bundles: Array<{ id: string; fingerprint: string }>;
    };
    assert.equal(marker.bundles[0].id, 'partial-delete');
    assert.equal(marker.bundles[0].fingerprint, captureBundleTreeFingerprint(quarantinePath));

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(fs.existsSync(quarantinePath), false);
  });
});

test('distributeHooks: legacy cleanup marker is published only after the config transition', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const legacyDir = path.join(getClaudeDir(), 'hooks', 'asb', 'marker-after-config');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['marker-after-config'],
      })
    );
    const statePath = resolveManagedHookStatePath('claude-code', settingsPath);
    const cleanupMarker = `${statePath}.legacy-bundles`;
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const originalRenameSync = fs.renameSync;
    let replaced = false;
    let stateCommits = 0;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(newPath)) === statePath) {
          stateCommits += 1;
          if (stateCommits === 2) {
            replaced = true;
            fs.writeFileSync(settingsPath, '{"theme":"user replacement"}\n');
          }
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some((result) => result.status === 'error'),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(replaced, true);
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(fs.existsSync(legacyDir), true);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '{"theme":"user replacement"}\n');
  });
});

test('distributeHooks: anchored legacy cleanup rejects content changed at child launch', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', 'child-content-race');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\necho legacy\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['child-content-race'],
      })
    );
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    let quarantinePath: string | undefined;
    const first = withAnchoredRemovalIntercept(
      (target) => {
        if (!quarantinePath && path.basename(target).startsWith('.delete.')) {
          quarantinePath = target;
          fs.writeFileSync(path.join(target, 'run.sh'), '#!/bin/sh\necho user replacement\n');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );

    assert.ok(first.results.some((result) => result.status === 'error'));
    assert.ok(quarantinePath);
    assert.equal(fs.existsSync(cleanupMarker), true);

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(
      fs.readFileSync(path.join(quarantinePath, 'run.sh'), 'utf-8'),
      '#!/bin/sh\necho user replacement\n'
    );
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
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo asb' }],
              _asb_source: true,
            },
          ],
        },
        _asb_managed_hooks: ['old-bundle'],
      })
    );
    const realHooksJsonPath = fs.realpathSync.native(hooksJsonPath);

    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const originalRenameSync = fs.renameSync;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (path.resolve(String(oldPath)) === realHooksJsonPath) {
          throw new Error('mock hooks.json delete failure');
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;

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
      fs.renameSync = originalRenameSync;
    }
  });
});

test('codex target registry hooks handler delegates to Codex distributor', () => {
  withTempHomes(() => {
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
      ),
      'registry handler should return Codex review diagnostic'
    );
  });
});

test('distributeHooks: quarantine cleanup rejects a replacement directory after config verification', () => {
  withTempHomes(() => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    fs.writeFileSync(settingsPath, '{"theme":"dark"}\n');
    createBundleHook('quarantine-verify-swap');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['quarantine-verify-swap'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const settingsRealPath = fs.realpathSync.native(settingsPath);
    const bundleDir = claudeBundleTargetDir('quarantine-verify-swap');
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const originalLstatSync = fs.lstatSync;
    let replacementPath: string | undefined;
    try {
      fs.lstatSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
        if (
          replacementPath === undefined &&
          path.resolve(String(target)) === settingsRealPath &&
          fs.existsSync(bundleParent)
        ) {
          const quarantine = fs
            .readdirSync(bundleParent)
            .find((name) => name.startsWith('.delete.'));
          if (quarantine) {
            replacementPath = path.join(bundleParent, quarantine);
            fs.rmSync(replacementPath, { recursive: true, force: false });
            fs.mkdirSync(replacementPath);
            fs.writeFileSync(path.join(replacementPath, 'keep.txt'), 'replacement\n');
          }
        }
        return originalLstatSync(target, options as never);
      }) as typeof fs.lstatSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some((result) => result.status === 'error'),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.lstatSync = originalLstatSync;
    }

    assert.ok(replacementPath);
    assert.equal(fs.readFileSync(path.join(replacementPath, 'keep.txt'), 'utf-8'), 'replacement\n');
  });
});

test('distributeHooks: config commit preserves a same-content symlink replacement', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const concurrentTarget = path.join(agentsHome, 'concurrent-settings.json');
    const originalConfig = '{"theme":"dark"}\n';
    fs.writeFileSync(settingsPath, originalConfig);
    const settingsRealPath = fs.realpathSync.native(settingsPath);
    fs.writeFileSync(concurrentTarget, originalConfig);
    fs.chmodSync(concurrentTarget, fs.statSync(settingsPath).mode & 0o777);
    createHookEntry('config-carrier-symlink-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['config-carrier-symlink-race'],
      agentSync: {},
    }));

    const originalRenameSync = fs.renameSync;
    let swapped = false;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (
          !swapped &&
          path.resolve(String(oldPath)) === settingsRealPath &&
          String(newPath).includes('.previous.')
        ) {
          swapped = true;
          fs.unlinkSync(settingsPath);
          fs.symlinkSync(concurrentTarget, settingsPath);
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' &&
            result.error?.includes('application config changed during hook sync')
        ),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(swapped, true);
    assert.equal(fs.lstatSync(settingsPath).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(settingsPath), fs.realpathSync(concurrentTarget));
    assert.equal(fs.readFileSync(concurrentTarget, 'utf-8'), originalConfig);
    assert.equal(fs.existsSync(resolveManagedHookStatePath('claude-code', settingsPath)), false);
  });
});

test('distributeHooks: bundle deployment rejects a same-content config inode replacement', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const heldSettingsPath = path.join(agentsHome, 'held-settings.json');
    const originalConfig = '{"theme":"dark"}\n';
    fs.writeFileSync(settingsPath, originalConfig);
    const originalMode = fs.statSync(settingsPath).mode & 0o777;
    const originalIdentity = `${fs.statSync(settingsPath).dev}:${fs.statSync(settingsPath).ino}`;
    createBundleHook('config-inode-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['config-inode-race'],
      agentSync: {},
    }));

    const originalMkdtempSync = fs.mkdtempSync;
    let replaced = false;
    try {
      fs.mkdtempSync = ((prefix: string, options?: Parameters<typeof fs.mkdtempSync>[1]) => {
        const created = originalMkdtempSync(prefix, options as never);
        if (!replaced) {
          replaced = true;
          fs.renameSync(settingsPath, heldSettingsPath);
          fs.writeFileSync(settingsPath, originalConfig);
          fs.chmodSync(settingsPath, originalMode);
        }
        return created;
      }) as typeof fs.mkdtempSync;
      const outcome = distributeHooks(undefined, ['claude-code']);
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' &&
            result.error?.includes('application config changed during hook sync')
        ),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
    }

    const replacementIdentity = `${fs.statSync(settingsPath).dev}:${fs.statSync(settingsPath).ino}`;
    assert.equal(replaced, true);
    assert.notEqual(replacementIdentity, originalIdentity);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), originalConfig);
    assert.equal(fs.existsSync(path.join(getClaudeDir(), 'hooks', 'managed')), false);
  });
});

test('managed hook lock does not recreate a project root moved after address resolution', () => {
  withTempHomes(({ agentsHome }) => {
    const projectRoot = path.join(agentsHome, 'project-moved-before-pin');
    const movedRoot = path.join(agentsHome, 'project-moved-before-pin-new');
    const settingsPath = path.join(getProjectClaudeDir(projectRoot), 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{}\n');
    const canonicalProjectRoot = fs.realpathSync.native(projectRoot);

    const originalStatSync = fs.statSync;
    let moved = false;
    try {
      fs.statSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
        const stat = originalStatSync(target, options as never);
        if (!moved && path.resolve(String(target)) === canonicalProjectRoot) {
          moved = true;
          fs.renameSync(projectRoot, movedRoot);
        }
        return stat;
      }) as typeof fs.statSync;
      let caught: unknown;
      try {
        withManagedHookLock('claude-code', settingsPath, () => undefined, projectRoot);
      } catch (error) {
        caught = error;
      }
      assert.match(String(caught), /safety root changed before lock acquisition/, `moved=${moved}`);
    } finally {
      fs.statSync = originalStatSync;
    }

    assert.equal(moved, true);
    assert.equal(fs.existsSync(projectRoot), false);
    assert.equal(
      fs.readFileSync(path.join(movedRoot, '.claude', 'settings.local.json'), 'utf-8'),
      '{}\n'
    );
  });
});

test('distributeHooks: project move before bundle deployment does not recreate the old root', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const projectRoot = path.join(agentsHome, 'project-move-before-bundle');
    const movedRoot = path.join(agentsHome, 'project-move-before-bundle-new');
    fs.mkdirSync(projectRoot);
    const canonicalProjectRoot = fs.realpathSync.native(projectRoot);
    createBundleHook('project-move-before-bundle-hook');
    updateLibraryStateSection(
      'hooks',
      () => ({ enabled: ['project-move-before-bundle-hook'], agentSync: {} }),
      { project: projectRoot }
    );

    const originalLstatSync = fs.lstatSync;
    let moved = false;
    try {
      fs.lstatSync = ((target: fs.PathLike, options?: fs.StatOptions) => {
        if (
          !moved &&
          path
            .resolve(String(target))
            .startsWith(path.join(canonicalProjectRoot, '.claude', 'hooks', 'managed'))
        ) {
          moved = true;
          fs.renameSync(projectRoot, movedRoot);
        }
        return originalLstatSync(target, options as never);
      }) as typeof fs.lstatSync;
      const outcome = distributeHooks(
        { project: projectRoot },
        ['claude-code'],
        new Set(['claude-code'])
      );
      assert.ok(
        outcome.results.some(
          (result) =>
            result.status === 'error' &&
            /(project root|state root) changed/.test(result.error ?? '')
        ),
        JSON.stringify(outcome.results)
      );
    } finally {
      fs.lstatSync = originalLstatSync;
    }

    assert.equal(moved, true);
    assert.equal(fs.existsSync(projectRoot), false);
    assert.equal(fs.existsSync(path.join(movedRoot, '.claude', 'hooks', 'managed')), false);
  });
});

test('distributeHooks: non-bundle legacy hook-id marker does not authorize bundle deletion', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', 'marker-only');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'keep.txt'), 'user directory\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `echo old\n${CODEX_ASB_MANAGED_MARKER}\n${codexAsbHookIdMarker('marker-only')}`,
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.readFileSync(path.join(legacyDir, 'keep.txt'), 'utf-8'), 'user directory\n');
  });
});

test('distributeHooks: decodes a legacy bundle marker ID exactly once', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const id = 'encoded%20bundle';
    const doubleDecodedId = 'encoded bundle';
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', id);
    const doubleDecodedDir = path.join(getCodexDir(), 'hooks', 'asb', doubleDecodedId);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(doubleDecodedDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'run.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(doubleDecodedDir, 'keep.txt'), 'double-decoded user path\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: [
                    'echo old',
                    CODEX_ASB_MANAGED_MARKER,
                    codexAsbHookIdMarker(id),
                    `# asb-bundle-sha256=${'a'.repeat(64)}`,
                  ].join('\n'),
                },
              ],
            },
          ],
        },
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(
      fs.readFileSync(path.join(doubleDecodedDir, 'keep.txt'), 'utf-8'),
      'double-decoded user path\n'
    );
  });
});

test('distributeHooks: clears legacy cleanup ownership when managed cleanup fails', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    createBundleHook('managed-cleanup-failure');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['managed-cleanup-failure'],
      agentSync: { codex: { enabled: ['managed-cleanup-failure'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const managedDir = codexBundleTargetDir();
    const managedParent = path.dirname(managedDir);
    const legacyId = 'legacy-cleanup-success';
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', legacyId);
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    const config = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8')) as {
      hooks: Record<string, unknown[]>;
      _asb_managed_hooks?: string[];
    };
    config.hooks.SessionStart = [
      { hooks: [{ type: 'command', command: legacyScript }], _asb_source: true },
    ];
    config._asb_managed_hooks = [legacyId];
    fs.writeFileSync(hooksJsonPath, JSON.stringify(config));
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;

    let failedManagedCleanup = false;
    const first = withAnchoredRemovalIntercept(
      (target) => {
        if (
          !failedManagedCleanup &&
          path.dirname(target) === managedParent &&
          path.basename(target).startsWith('.delete.')
        ) {
          failedManagedCleanup = true;
          throw new Error('mock managed cleanup failure');
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );
    assert.ok(first.results.some((result) => result.status === 'error'));

    assert.equal(failedManagedCleanup, true);
    assert.equal(fs.existsSync(legacyDir), false);
    assert.equal(fs.existsSync(cleanupMarker), false);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'keep.txt'), 'new user directory\n');

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(
      fs.readFileSync(path.join(legacyDir, 'keep.txt'), 'utf-8'),
      'new user directory\n'
    );
  });
});

test('distributeHooks: codex recovers a pending config before a bundle capture failure', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const previousConfig = '{"description":"restored","hooks":{}}\n';
    const desiredConfig =
      '{"description":"restored","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo desired"}]}]}}\n';
    const transactionId = 'c'.repeat(24);
    const statePath = resolveManagedHookStatePath('codex', hooksJsonPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        hooks: {},
        prefixLengths: {},
        pending: {
          desired: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo desired' }] }],
          },
          desiredPrefixLengths: { SessionStart: 0 },
          previousConfigHash: configSnapshotHash(previousConfig),
          desiredConfigHash: configSnapshotHash(desiredConfig),
          transactionId,
        },
      })
    );
    const backupPath = `${hooksJsonPath}.previous.${transactionId}`;
    fs.mkdirSync(path.dirname(hooksJsonPath), { recursive: true });
    fs.writeFileSync(backupPath, previousConfig);
    createBundleHook('broken-after-recovery');
    const bundleDir = path.join(ensureHooksDirectory(), 'broken-after-recovery');
    fs.symlinkSync(path.join(bundleDir, 'missing.sh'), path.join(bundleDir, 'broken.sh'));
    updateLibraryStateSection('hooks', () => ({
      enabled: ['broken-after-recovery'],
      agentSync: { codex: { enabled: ['broken-after-recovery'] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.readFileSync(hooksJsonPath, 'utf-8'), previousConfig);
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(statePath), false);
  });
});

test('distributeHooks: codex skips an unsupported bundle without reading broken ancillary files', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const id = 'unsupported-broken-ancillary';
    createBundleHook(id, 'Notification');
    const bundleDir = path.join(ensureHooksDirectory(), id);
    fs.symlinkSync(path.join(bundleDir, 'missing.sh'), path.join(bundleDir, 'broken.sh'));
    updateLibraryStateSection('hooks', () => ({
      enabled: [id],
      agentSync: { codex: { enabled: [id] } },
    }));

    const outcome = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      outcome.results.some((result) => result.status === 'error'),
      false
    );
    assert.ok(
      outcome.results.some(
        (result) =>
          result.entryId === id &&
          result.status === 'skipped' &&
          result.reason?.includes('unsupported events')
      )
    );
    assert.equal(fs.existsSync(getCodexHooksJsonPath()), false);
  });
});

test('distributeHooks: legacy cleanup retires ownership when a bundle changes before quarantine', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', 'changed-before-quarantine');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\necho old\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['changed-before-quarantine'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;

    const originalRenameSync = fs.renameSync;
    try {
      fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
        if (
          path.resolve(String(oldPath)) === path.resolve(legacyDir) &&
          path.basename(String(newPath)).startsWith('.delete.')
        ) {
          throw new Error('mock pre-quarantine failure');
        }
        return originalRenameSync(oldPath, newPath);
      }) as typeof fs.renameSync;
      const first = distributeHooks(undefined, ['codex'], new Set(['codex']));
      assert.ok(first.results.some((result) => result.status === 'error'));
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.equal(fs.existsSync(cleanupMarker), true);
    fs.writeFileSync(legacyScript, '#!/bin/sh\necho user replacement\n');

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(fs.readFileSync(legacyScript, 'utf-8'), '#!/bin/sh\necho user replacement\n');
  });
});

test('distributeHooks: legacy cleanup does not own a replaced quarantine', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    const legacyDir = path.join(getCodexDir(), 'hooks', 'asb', 'replaced-quarantine');
    const legacyScript = path.join(legacyDir, 'run.sh');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyScript, '#!/bin/sh\n');
    fs.writeFileSync(
      hooksJsonPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: legacyScript }] }],
        },
        _asb_managed_hooks: ['replaced-quarantine'],
      })
    );
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));
    const cleanupMarker = `${resolveManagedHookStatePath('codex', hooksJsonPath)}.legacy-bundles`;

    const first = withAnchoredRemovalIntercept(
      () => {
        throw new Error('mock quarantine delete failure');
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );
    assert.ok(first.results.some((result) => result.status === 'error'));
    const bundleParent = path.dirname(legacyDir);
    const quarantineName = fs.readdirSync(bundleParent).find((name) => name.startsWith('.delete.'));
    assert.ok(quarantineName);
    const quarantinePath = path.join(bundleParent, quarantineName);
    fs.rmSync(quarantinePath, { recursive: true, force: false });
    fs.mkdirSync(quarantinePath);
    fs.writeFileSync(path.join(quarantinePath, 'keep.txt'), 'replacement quarantine\n');

    const retried = distributeHooks(undefined, ['codex'], new Set(['codex']));

    assert.equal(
      retried.results.some((result) => result.status === 'error'),
      false
    );
    assert.equal(fs.existsSync(cleanupMarker), false);
    assert.equal(
      fs.readFileSync(path.join(quarantinePath, 'keep.txt'), 'utf-8'),
      'replacement quarantine\n'
    );
  });
});

test('distributeHooks: anchored cleanup rejects a swapped parent before recursive deletion', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    createBundleHook('anchored-parent-swap');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['anchored-parent-swap'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('anchored-parent-swap');
    const bundleParent = path.dirname(bundleDir);
    const heldParent = `${bundleParent}.held`;
    const outsideParent = path.join(agentsHome, 'anchored-parent-swap-outside');
    let outsideFile: string | undefined;
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        const name = path.basename(target);
        fs.renameSync(bundleParent, heldParent);
        fs.mkdirSync(path.join(outsideParent, name), { recursive: true });
        outsideFile = path.join(outsideParent, name, 'keep.txt');
        fs.writeFileSync(outsideFile, 'outside replacement\n');
        fs.symlinkSync(outsideParent, bundleParent);
      },
      () => distributeHooks(undefined, ['claude-code'])
    );

    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.ok(outsideFile);
    assert.equal(fs.readFileSync(outsideFile, 'utf-8'), 'outside replacement\n');
    fs.unlinkSync(bundleParent);
    fs.renameSync(heldParent, bundleParent);
  });
});

test('distributeHooks: anchored cleanup rejects a config replacement before child deletion', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const heldSettingsPath = path.join(agentsHome, 'anchored-config-held.json');
    createBundleHook('anchored-config-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['anchored-config-race'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('anchored-config-race');
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    let replaced = false;
    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (!replaced && path.basename(target).startsWith('.delete.')) {
          replaced = true;
          const content = fs.readFileSync(settingsPath);
          const mode = fs.statSync(settingsPath).mode & 0o777;
          fs.renameSync(settingsPath, heldSettingsPath);
          fs.writeFileSync(settingsPath, content);
          fs.chmodSync(settingsPath, mode);
        }
      },
      () => distributeHooks(undefined, ['claude-code'])
    );

    assert.equal(replaced, true);
    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));
  });
});

test('distributeHooks: anchored cleanup rejects config recreation before child deletion', () => {
  withTempHomes(() => {
    simulateAppsInstalled('codex');
    const hooksJsonPath = getCodexHooksJsonPath();
    createBundleHook('anchored-missing-config-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['anchored-missing-config-race'],
      agentSync: { codex: { enabled: ['anchored-missing-config-race'] } },
    }));
    distributeHooks(undefined, ['codex'], new Set(['codex']));
    const bundleDir = codexBundleTargetDir();
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({
      enabled: [],
      agentSync: { codex: { enabled: [] } },
    }));

    let recreated = false;
    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (!recreated && path.basename(target).startsWith('.delete.')) {
          recreated = true;
          fs.writeFileSync(
            hooksJsonPath,
            `${JSON.stringify({
              hooks: {
                SessionStart: [
                  {
                    hooks: [{ type: 'command', command: path.join(target, 'run.sh') }],
                  },
                ],
              },
            })}\n`
          );
        }
      },
      () => distributeHooks(undefined, ['codex'], new Set(['codex']))
    );

    assert.equal(recreated, true);
    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.existsSync(hooksJsonPath), true);
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));
  });
});

test('distributeHooks: anchored cleanup rejects config alias retargeting', () => {
  withTempHomes(({ agentsHome }) => {
    simulateAppsInstalled('claude-code');
    const settingsPath = path.join(getClaudeDir(), 'settings.json');
    const targetA = path.join(agentsHome, 'anchored-alias-a.json');
    const targetB = path.join(agentsHome, 'anchored-alias-b.json');
    const targetBContent = '{"theme":"user target"}\n';
    fs.writeFileSync(targetA, '{"theme":"managed target"}\n');
    fs.writeFileSync(targetB, targetBContent);
    fs.symlinkSync(targetA, settingsPath);
    createBundleHook('anchored-alias-race');
    updateLibraryStateSection('hooks', () => ({
      enabled: ['anchored-alias-race'],
      agentSync: {},
    }));
    distributeHooks(undefined, ['claude-code']);
    const bundleDir = claudeBundleTargetDir('anchored-alias-race');
    const bundleParent = path.dirname(bundleDir);
    updateLibraryStateSection('hooks', () => ({ enabled: [], agentSync: {} }));

    let retargeted = false;
    const outcome = withAnchoredRemovalIntercept(
      (target) => {
        if (!retargeted && path.basename(target).startsWith('.delete.')) {
          retargeted = true;
          fs.unlinkSync(settingsPath);
          fs.symlinkSync(targetB, settingsPath);
        }
      },
      () => distributeHooks(undefined, ['claude-code'])
    );

    assert.equal(retargeted, true);
    assert.ok(outcome.results.some((result) => result.status === 'error'));
    assert.equal(fs.realpathSync.native(settingsPath), fs.realpathSync.native(targetB));
    assert.equal(fs.readFileSync(targetB, 'utf-8'), targetBContent);
    assert.ok(fs.readdirSync(bundleParent).some((name) => name.startsWith('.delete.')));
  });
});
