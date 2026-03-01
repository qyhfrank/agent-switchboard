/**
 * Marketplace-aware source loading. For each configured source, detects whether
 * it's a Claude Code marketplace or a flat library directory, and loads the
 * appropriate components from each.
 */

import type { CommandEntry } from '../commands/library.js';
import type { HookEntry } from '../hooks/library.js';
import { getSourcesRecord } from '../library/sources.js';
import type { SubagentEntry } from '../subagents/library.js';
import { loadPluginComponents, type SkillEntryFromPlugin } from './plugin-loader.js';
import { isMarketplace, readMarketplace } from './reader.js';

export interface MarketplaceSourceEntries {
  commands: CommandEntry[];
  agents: SubagentEntry[];
  skills: SkillEntryFromPlugin[];
  hooks: HookEntry[];
}

/**
 * Load library entries from all configured sources, handling both flat directory
 * sources and marketplace sources transparently.
 *
 * For flat sources: returns `{ namespace, basePath, isMarketplace: false }` so the
 * caller can load from `basePath/<type>/`.
 *
 * For marketplace sources: parses the marketplace, loads all plugin components,
 * and returns them directly.
 */
export function loadEntriesFromSources(): {
  flatSources: Array<{ namespace: string; basePath: string }>;
  marketplaceEntries: MarketplaceSourceEntries;
} {
  const sources = getSourcesRecord();
  const flatSources: Array<{ namespace: string; basePath: string }> = [];
  const marketplaceEntries: MarketplaceSourceEntries = {
    commands: [],
    agents: [],
    skills: [],
    hooks: [],
  };

  for (const [namespace, basePath] of Object.entries(sources)) {
    if (isMarketplace(basePath)) {
      const result = readMarketplace(basePath);
      for (const plugin of result.plugins) {
        const components = loadPluginComponents(plugin);
        marketplaceEntries.commands.push(...components.commands);
        marketplaceEntries.agents.push(...components.agents);
        marketplaceEntries.skills.push(...components.skills);
        marketplaceEntries.hooks.push(...components.hooks);
      }
    } else {
      flatSources.push({ namespace, basePath });
    }
  }

  return { flatSources, marketplaceEntries };
}
