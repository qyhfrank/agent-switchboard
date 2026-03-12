/**
 * Interactive UI for managing MCP servers
 * Server definitions from mcp.json, enabled state from config.toml
 */

import chalk from 'chalk';
import { loadMcpConfigWithPlugins } from '../config/mcp-config.js';
import type { McpServer } from '../config/schemas.js';
import type { ConfigScope } from '../config/scope.js';
import { type FuzzyMultiSelectChoice, fuzzyMultiSelect } from './fuzzy-multi-select.js';

export interface McpServerUIOptions {
  pageSize?: number;
  enabled: string[];
  scope?: ConfigScope;
}

function buildMcpChoices(enabled: string[], scope?: ConfigScope): FuzzyMultiSelectChoice[] {
  const config = loadMcpConfigWithPlugins(scope);
  const enabledSet = new Set(enabled);
  const choices: FuzzyMultiSelectChoice[] = [];

  // Enabled servers first (in enabled order), then remaining alphabetically
  const remaining = Object.keys(config.mcpServers)
    .filter((name) => !enabledSet.has(name))
    .sort();

  for (const name of [...enabled, ...remaining]) {
    const server = config.mcpServers[name];
    if (!server) continue;

    const keywords = [name];
    const raw = server as McpServer & Record<string, unknown>;
    if (raw.command) keywords.push(String(raw.command));
    if (raw.url) keywords.push(String(raw.url));
    if (raw.type) keywords.push(String(raw.type));

    const hint = raw.type ?? (raw.url ? 'http' : raw.command ? 'stdio' : undefined);

    choices.push({
      value: name,
      label: name,
      hint: hint ? String(hint) : undefined,
      keywords,
    });
  }

  return choices;
}

/**
 * Show interactive fuzzy-filterable UI for MCP server selection
 */
export async function showMcpServerUI(options: McpServerUIOptions): Promise<string[]> {
  const pageSize = options.pageSize ?? 15;
  const choices = buildMcpChoices(options.enabled, options.scope);

  if (choices.length === 0) {
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

  return fuzzyMultiSelect({
    message: 'Select MCP servers to enable',
    choices,
    initialSelected: options.enabled,
    pageSize,
    allowEmpty: true,
  });
}
