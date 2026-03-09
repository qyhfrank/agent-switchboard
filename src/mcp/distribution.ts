import fs from 'node:fs';
import chalk from 'chalk';
import ora from 'ora';
import { resolveScopedSectionConfig } from '../config/application-config.js';
import { loadMcpConfigWithPlugins } from '../config/mcp-config.js';
import type { McpServer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { scopeToLayerOptions } from '../config/scope.js';
import { loadSwitchboardConfig } from '../config/switchboard-config.js';
import { loadMcpEnabledState } from '../library/state.js';
import { initTargets } from '../targets/init.js';
import { getTargetById } from '../targets/registry.js';
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
  const mcpConfig = loadMcpConfigWithPlugins(scope);
  const switchboardConfig = loadSwitchboardConfig(scopeToLayerOptions(scope));
  await initTargets(switchboardConfig);
  const useSpinner = options?.useSpinner ?? true;
  const assumeInstalled =
    options?.assumeInstalled ?? new Set(switchboardConfig.applications.assume_installed);
  const results: McpDistributionResult[] = [];

  if (switchboardConfig.applications.enabled.length === 0) {
    if (useSpinner) {
      console.log(chalk.yellow('\n⚠ No applications found in the enabled configuration stack.'));
      console.log();
      console.log('Add applications under the relevant TOML layer (user, profile, or project).');
      console.log(chalk.dim('  Example: [applications]\n  enabled = ["claude-code", "cursor"]'));
    }
    return results;
  }

  const globalMcpServers = enabledServerNames ?? loadMcpEnabledState(scope);

  for (const agentId of switchboardConfig.applications.enabled) {
    const spinner = useSpinner ? ora({ indent: 2 }).start(`Applying to ${agentId}...`) : null;
    const persist = (symbol: string, text: string) => {
      if (!spinner) return;
      spinner.stopAndPersist({ symbol: `  ${symbol}`, text });
    };

    try {
      const agentMcpConfig = resolveScopedSectionConfig('mcp', agentId, scope);
      const agentActiveServers = enabledServerNames
        ? agentMcpConfig.enabled.filter((serverName) => globalMcpServers.includes(serverName))
        : agentMcpConfig.enabled;
      const activeSet = new Set(agentActiveServers);
      const enabledServers: Record<string, Omit<McpServer, 'enabled'>> = {};
      for (const [serverName, server] of Object.entries(mcpConfig.mcpServers)) {
        if (activeSet.has(serverName)) {
          enabledServers[serverName] = server;
        }
      }
      const configToApply = { mcpServers: enabledServers };

      const target = getTargetById(agentId);
      if (!assumeInstalled.has(agentId) && target?.isInstalled?.() === false) {
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
        const before = readFileSafe(projectPath);
        mcpHandler.applyProjectConfig(scope.project, configToApply);
        const after = readFileSafe(projectPath);
        const changed = before !== after;
        persist(chalk.green('✓'), `${chalk.cyan(agentId)} ${chalk.dim(shortenPath(projectPath))}`);
        results.push({
          application: agentId,
          filePath: projectPath,
          status: changed ? 'written' : 'skipped',
          reason: changed ? 'applied' : 'up-to-date',
        });
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
      if (error instanceof Error) {
        persist(chalk.yellow('⚠'), `${chalk.cyan(agentId)} - ${error.message} (skipped)`);
        results.push({
          application: agentId,
          filePath: '(unknown)',
          status: 'error',
          error: `${error.message} (skipped)`,
        });
      }
    }
  }

  return results;
}
