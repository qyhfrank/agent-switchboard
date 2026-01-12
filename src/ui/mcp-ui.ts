/**
 * Interactive UI for managing MCP servers
 * Server definitions from mcp.json, enabled state from config.toml
 */

import { checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadMcpConfig } from '../config/mcp-config.js';
import type { CheckboxItem } from '../types.js';

export interface McpServerUIOptions {
  pageSize?: number;
  enabled: string[];
}

/**
 * Create checkbox items for MCP servers
 * @param enabled - List of enabled server names (from config.toml)
 * @returns Array of checkbox items sorted alphabetically
 */
export function createMcpServerItems(enabled: string[]): CheckboxItem[] {
  const config = loadMcpConfig();
  const items: CheckboxItem[] = [];
  const enabledSet = new Set(enabled);

  for (const [name] of Object.entries(config.mcpServers)) {
    const isEnabled = enabledSet.has(name);
    const icon = isEnabled ? chalk.green('✓') : chalk.red('✗');
    const status = isEnabled ? chalk.gray('(enabled)') : chalk.gray('(disabled)');

    items.push({
      name: `${icon} ${name} ${status}`,
      value: name,
      checked: isEnabled,
    });
  }

  return items.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Show interactive checkbox UI for MCP server selection
 * @param options.enabled - List of currently enabled server names
 * @returns Array of selected server names
 */
export async function showMcpServerUI(options: McpServerUIOptions): Promise<string[]> {
  const pageSize = options.pageSize ?? 15;
  const items = createMcpServerItems(options.enabled);

  if (items.length === 0) {
    console.log(chalk.yellow('⚠ No MCP servers found in ~/.agent-switchboard/mcp.json'));
    console.log();
    console.log('Please add servers manually to the config file:');
    console.log(chalk.dim('  ~/.agent-switchboard/mcp.json'));
    console.log();
    console.log('Example:');
    console.log(
      chalk.dim(`  {
    "mcpServers": {
      "my-server": {
        "command": "npx",
        "args": ["-y", "package"],
        "env": {}
      }
    }
  }`)
    );
    return [];
  }

  console.log(chalk.blue('MCP Server Management'));
  console.log(chalk.gray('Select which MCP servers should be enabled:'));
  console.log();

  const selectedServers = await checkbox({
    message: 'Toggle MCP servers (Space: toggle, a: all, i: invert, Enter: confirm):',
    choices: items,
    pageSize,
  });

  return selectedServers;
}
