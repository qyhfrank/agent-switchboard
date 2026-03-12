import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import ora from 'ora';
import { resolveScopedSectionConfig } from '../config/application-config.js';
import { loadMcpConfigWithPlugins } from '../config/mcp-config.js';
import type { McpServer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import { loadMcpEnabledState } from '../library/state.js';
import {
  computeMcpCleanupSet,
  getMcpEntryKeysForPath,
  getOwnedMcpServers,
  getOwnedMcpServersForPath,
  getOwnedMcpTargetIds,
  recordMcpEntry,
  removeMcpEntry,
} from '../manifest/store.js';
import type { ProjectDistributionManifest } from '../manifest/types.js';
import { initTargets } from '../targets/init.js';
import { getTargetById } from '../targets/registry.js';
import type { ManagedMcpOptions } from '../targets/types.js';
import { shortenPath } from '../util/cli.js';

export interface McpDistributionResult {
  application: string;
  filePath: string;
  status: 'written' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export interface DistributeMcpOptions {
  useSpinner?: boolean;
  assumeInstalled?: ReadonlySet<string>;
  /** Project distribution manifest for managed merge (project scope only) */
  manifest?: ProjectDistributionManifest;
  /** Project distribution mode */
  projectMode?: 'managed' | 'exclusive' | 'none';
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function distributeMcp(
  scope?: ConfigScope,
  enabledServerNames?: string[],
  options?: DistributeMcpOptions
): Promise<McpDistributionResult[]> {
  if (scope?.project && options?.projectMode === 'none') {
    return [];
  }

  if (scope?.project && (options?.projectMode ?? 'exclusive') === 'managed' && !options?.manifest) {
    throw new Error('Managed project distribution requires a valid manifest');
  }

  const layerOpts = scopeToLayerOptions(scope);
  const switchboardConfig = loadSwitchboardConfig(layerOpts);
  const mcpConfig = loadMcpConfigWithPlugins(scope);
  await initTargets(switchboardConfig);
  const useSpinner = options?.useSpinner ?? true;
  const assumeInstalled =
    options?.assumeInstalled ?? new Set(switchboardConfig.applications.assume_installed);
  const results: McpDistributionResult[] = [];
  const managedTargetIds = options?.manifest
    ? getOwnedMcpTargetIds(options.manifest)
    : new Set<string>();
  const targetIds = [...new Set([...switchboardConfig.applications.enabled, ...managedTargetIds])];

  if (targetIds.length === 0) {
    if (useSpinner) {
      console.log(chalk.yellow('\n⚠ No applications found in the enabled configuration stack.'));
      console.log();
      console.log('Add applications under the relevant TOML layer (user, profile, or project).');
      console.log(chalk.dim('  Example: [applications]\n  enabled = ["claude-code", "cursor"]'));
    }
    return results;
  }

  const globalMcpServers = enabledServerNames ?? loadMcpEnabledState(scope);
  const projectWrites = new Map<
    string,
    {
      handler: NonNullable<NonNullable<ReturnType<typeof getTargetById>>['mcp']>;
      agentIds: string[];
      configs: Array<Record<string, Omit<McpServer, 'enabled'>>>;
      previouslyOwned: Set<string>;
      relativePath: string;
      desiredByAgent: Map<string, Set<string>>;
      persistByAgent: Map<string, (symbol: string, text: string) => void>;
    }
  >();

  for (const agentId of targetIds) {
    const spinner = useSpinner ? ora({ indent: 2 }).start(`Applying to ${agentId}...`) : null;
    const persist = (symbol: string, text: string) => {
      if (!spinner) return;
      spinner.stopAndPersist({ symbol: `  ${symbol}`, text });
    };
    const isActiveApplication = switchboardConfig.applications.enabled.includes(agentId);

    try {
      const agentMcpConfig = isActiveApplication
        ? resolveScopedSectionConfig('mcp', agentId, scope)
        : { enabled: [] };
      const agentActiveServers = isActiveApplication
        ? enabledServerNames
          ? agentMcpConfig.enabled.filter((serverName) => globalMcpServers.includes(serverName))
          : agentMcpConfig.enabled
        : [];
      const activeSet = new Set(agentActiveServers);
      const enabledServers: Record<string, Omit<McpServer, 'enabled'>> = {};
      for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
        if (activeSet.has(serverName)) {
          enabledServers[serverName] = server;
        }
      }
      const configToApply = { mcpServers: enabledServers };

      const target = getTargetById(agentId);
      const skipInstallCheck =
        scope?.project && managedTargetIds.has(agentId) && !isActiveApplication;
      if (!skipInstallCheck && !assumeInstalled.has(agentId) && target?.isInstalled?.() === false) {
        persist(
          chalk.gray('○'),
          `${chalk.cyan(agentId)} ${chalk.gray('(not installed, skipped)')}`
        );
        results.push({
          application: agentId,
          filePath: '(not installed)',
          status: 'skipped',
          reason: 'not installed',
        });
        continue;
      }

      if (!target?.mcp) {
        persist(chalk.yellow('⚠'), `${chalk.cyan(agentId)} - no MCP handler (skipped)`);
        results.push({
          application: agentId,
          filePath: '(unknown)',
          status: 'skipped',
          reason: 'no MCP handler',
        });
        continue;
      }

      const mcpHandler = target.mcp;

      if (scope?.project && mcpHandler.applyProjectConfig) {
        const projectPath = mcpHandler.projectConfigPath?.(scope.project) ?? 'project config';
        const relativePath = path.relative(path.resolve(scope.project), projectPath);

        // Build managed merge options if manifest is provided
        const manifest = options?.manifest;
        const isManaged = manifest && (options?.projectMode ?? 'exclusive') === 'managed';
        const sanitize = mcpHandler.sanitizeServerName;
        const ownedServers = isManaged ? getOwnedMcpServers(manifest, agentId) : new Set<string>();

        // Skip silently if no servers to apply and nothing to clean up
        if (Object.keys(configToApply.mcpServers).length === 0 && ownedServers.size === 0) {
          persist(chalk.gray('○'), `${chalk.cyan(agentId)} ${chalk.gray('(no MCP changes)')}`);
          continue;
        }

        const write = projectWrites.get(projectPath) ?? {
          handler: mcpHandler,
          agentIds: [],
          configs: [],
          previouslyOwned: isManaged
            ? getOwnedMcpServersForPath(manifest, relativePath)
            : new Set<string>(),
          relativePath,
          desiredByAgent: new Map<string, Set<string>>(),
          persistByAgent: new Map<string, (symbol: string, text: string) => void>(),
        };
        write.agentIds.push(agentId);
        write.configs.push(configToApply.mcpServers);
        for (const name of ownedServers) {
          write.previouslyOwned.add(name);
        }
        write.desiredByAgent.set(
          agentId,
          new Set(
            Object.keys(configToApply.mcpServers).map((name) => (sanitize ? sanitize(name) : name))
          )
        );
        write.persistByAgent.set(agentId, persist);
        projectWrites.set(projectPath, write);
        continue;
      }

      const configPath = mcpHandler.configPath();
      const before = readFileSafe(configPath);
      mcpHandler.applyConfig(configToApply);
      const after = readFileSafe(configPath);
      const changed = before !== after;
      persist(chalk.green('✓'), `${chalk.cyan(agentId)} ${chalk.dim(shortenPath(configPath))}`);
      results.push({
        application: agentId,
        filePath: configPath,
        status: changed ? 'written' : 'skipped',
        reason: changed ? 'applied' : 'up-to-date',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      persist(chalk.yellow('⚠'), `${chalk.cyan(agentId)} - ${msg} (skipped)`);
      results.push({
        application: agentId,
        filePath: '(unknown)',
        status: 'error',
        error: `${msg} (skipped)`,
      });
    }
  }

  for (const [projectPath, write] of projectWrites) {
    const before = readFileSafe(projectPath);
    const mergedServers: Record<string, Omit<McpServer, 'enabled'>> = {};
    for (const config of write.configs) {
      for (const [serverName, server] of Object.entries(config)) {
        mergedServers[serverName] = server;
      }
    }

    try {
      const managedOpts: ManagedMcpOptions | undefined =
        options?.manifest && (options?.projectMode ?? 'exclusive') === 'managed'
          ? { previouslyOwned: write.previouslyOwned }
          : undefined;
      write.handler.applyProjectConfig?.(
        scope?.project ?? '',
        { mcpServers: mergedServers },
        managedOpts
      );

      if (
        options?.manifest &&
        scope?.project &&
        (options?.projectMode ?? 'exclusive') === 'managed'
      ) {
        const timestamp = new Date().toISOString();
        for (const agentId of write.agentIds) {
          const currentDesired = write.desiredByAgent.get(agentId) ?? new Set<string>();
          for (const serverName of currentDesired) {
            recordMcpEntry(options.manifest, serverName, {
              relativePath: write.relativePath,
              targetId: agentId,
              serverKey: serverName,
              updatedAt: timestamp,
            });
          }
          const toRemove = computeMcpCleanupSet(options.manifest, currentDesired, agentId);
          for (const name of toRemove) {
            removeMcpEntry(options.manifest, name);
          }
        }

        const inactiveOwnerKeys = getMcpEntryKeysForPath(
          options.manifest,
          write.relativePath,
          new Set(write.agentIds)
        );
        for (const key of inactiveOwnerKeys) {
          removeMcpEntry(options.manifest, key);
        }
      }

      const after = readFileSafe(projectPath);
      const changed = before !== after;
      for (const agentId of write.agentIds) {
        write.persistByAgent.get(agentId)?.(
          chalk.green('✓'),
          `${chalk.cyan(agentId)} ${chalk.dim(shortenPath(projectPath))}`
        );
        results.push({
          application: agentId,
          filePath: projectPath,
          status: changed ? 'written' : 'skipped',
          reason: changed ? 'applied' : 'up-to-date',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      for (const agentId of write.agentIds) {
        write.persistByAgent.get(agentId)?.(
          chalk.yellow('⚠'),
          `${chalk.cyan(agentId)} - ${msg} (skipped)`
        );
        results.push({
          application: agentId,
          filePath: projectPath,
          status: 'error',
          error: `${msg} (skipped)`,
        });
      }
    }
  }

  return results;
}
