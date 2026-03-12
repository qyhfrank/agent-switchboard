import chalk from 'chalk';
import type { PluginComponentSection, PluginDescriptor } from '../plugins/index.js';

function pluginComponentSummary(plugin: PluginDescriptor): string {
  return (['commands', 'agents', 'skills', 'hooks', 'rules', 'mcp'] as const)
    .filter((s) => plugin.components[s].length > 0)
    .map((s) => `${plugin.components[s].length} ${s}`)
    .join(', ');
}

function sourceKindTag(plugin: PluginDescriptor): string {
  switch (plugin.meta.sourceKind) {
    case 'marketplace':
      return chalk.magenta('[marketplace]');
    default:
      return chalk.green('[plugin]');
  }
}

export function printPluginInfo(plugin: PluginDescriptor): void {
  console.log(`${chalk.cyan.bold(plugin.id)} ${sourceKindTag(plugin)}`);
  if (plugin.meta.description) {
    console.log(`  ${chalk.dim(plugin.meta.description)}`);
  }
  if (plugin.meta.version) {
    console.log(`  ${chalk.dim(`version: ${plugin.meta.version}`)}`);
  }
  if (plugin.meta.owner) {
    console.log(`  ${chalk.dim(`owner: ${plugin.meta.owner}`)}`);
  }
  console.log(
    `  ${chalk.dim(`source: ${plugin.meta.sourceName} (${plugin.meta.sourceKind}) @ ${plugin.meta.sourcePath}`)}`
  );
  const summary = pluginComponentSummary(plugin);
  if (summary) {
    console.log(`  ${chalk.dim(summary)}`);
  }
  console.log();

  const sections: PluginComponentSection[] = [
    'commands',
    'agents',
    'skills',
    'hooks',
    'rules',
    'mcp',
  ];
  for (const section of sections) {
    const ids = plugin.components[section];
    if (ids.length > 0) {
      console.log(`  ${chalk.blue(section)} (${ids.length})`);
      for (const id of ids) {
        console.log(`    ${id}`);
      }
    }
  }
}

export function printPluginList(plugins: PluginDescriptor[], enabledList: string[]): void {
  if (plugins.length === 0) {
    console.log(chalk.yellow('No plugins discovered from configured sources.'));
    console.log(chalk.dim('Use: asb plugin marketplace add <path-or-url>'));
    return;
  }

  const enabledSet = new Set(enabledList);
  for (const p of plugins) {
    const ref = p.id;
    const isEnabled = p.refs.some((candidate) => enabledSet.has(candidate));
    const statusIcon = isEnabled ? chalk.green('●') : chalk.gray('○');
    const statusLabel = isEnabled ? chalk.green('enabled') : chalk.gray('available');

    console.log(`  ${statusIcon} ${chalk.cyan(ref)} ${sourceKindTag(p)} ${chalk.dim(statusLabel)}`);
    const summary = pluginComponentSummary(p);
    if (summary) {
      console.log(`    ${chalk.dim(summary)}`);
    }
  }
}
