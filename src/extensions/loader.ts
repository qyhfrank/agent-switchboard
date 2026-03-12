/**
 * Extension module loader.
 *
 * Auto-discovers `.mjs`/`.js` modules from `~/.asb/extensions/`.
 * The `[extensions]` config section is a `Record<string, boolean>` map
 * that controls which modules are loaded:
 *   - absent  = enabled (opt-out model)
 *   - `true`  = enabled (explicit)
 *   - `false` = disabled
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfigDir } from '../config/paths.js';
import type { ExtensionsSection, SwitchboardConfig } from '../config/schemas.js';
import { createStagingExtensionApi, type ExtensionModule } from './api.js';

function getExtensionsDir(): string {
  return path.join(getConfigDir(), 'extensions');
}

/** Derive extension ID from filename: `my-ext.mjs` → `my-ext` */
function extId(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

/**
 * Auto-discover extension modules from `~/.asb/extensions/`.
 * Returns `{ id, absolutePath }` for each `.mjs`/`.js` file, sorted by name.
 */
function discoverModules(): Array<{ id: string; absolutePath: string }> {
  const extDir = getExtensionsDir();
  if (!fs.existsSync(extDir)) return [];

  const result: Array<{ id: string; absolutePath: string }> = [];
  for (const entry of fs.readdirSync(extDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === '.mjs' || ext === '.js') {
      result.push({ id: extId(entry.name), absolutePath: path.join(extDir, entry.name) });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Load and activate enabled extension modules.
 * Auto-discovers from `~/.asb/extensions/`, then filters by the
 * `[extensions]` enable/disable map.
 * Uses staged registration: targets registered during activate() are only
 * committed to the global registry if activate() succeeds.
 */
export async function loadExtensions(config: SwitchboardConfig): Promise<void> {
  const enableMap: ExtensionsSection =
    ((config as Record<string, unknown>).extensions as ExtensionsSection | undefined) ?? {};

  const discovered = discoverModules();
  const toLoad = discovered.filter((m) => enableMap[m.id] !== false);

  if (toLoad.length === 0) return;

  for (const { id, absolutePath } of toLoad) {
    try {
      await loadSingleExtension(absolutePath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[extensions] Failed to load ${id}: ${msg}`);
    }
  }
}

async function loadSingleExtension(absolutePath: string): Promise<void> {
  const fileUrl = pathToFileURL(absolutePath).href;
  const mod = (await import(fileUrl)) as ExtensionModule | { default: ExtensionModule };
  const ext = 'activate' in mod ? mod : (mod as { default: ExtensionModule }).default;

  if (typeof ext.activate !== 'function') {
    throw new Error('Extension must export an activate(api) function');
  }

  // Stage registrations; only commit on success
  const staging = createStagingExtensionApi();
  await ext.activate(staging.api);
  staging.commit();
}
