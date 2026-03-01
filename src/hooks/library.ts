/**
 * Hook library: loads hook entries from ~/.asb/hooks/ and marketplace sources.
 *
 * Two storage formats are supported:
 * - **Bundle**: a directory containing `hook.json` + script files
 *   e.g. `~/.asb/hooks/memorize/hook.json` + `memorize/*.mjs`
 * - **Single file**: a standalone JSON file (no scripts)
 *   e.g. `~/.asb/hooks/auto-lint.json`
 */

import fs from 'node:fs';
import path from 'node:path';
import { getHooksDir } from '../config/paths.js';
import type { BundleFile } from '../library/distribute-bundle.js';
import { loadEntriesFromSources } from '../marketplace/source-loader.js';
import type { HookFile } from './schema.js';
import { hookFileSchema } from './schema.js';

const HOOK_JSON = 'hook.json';

export interface HookEntry {
  id: string;
  bareId: string;
  namespace?: string;
  source: string;
  filePath: string;
  name?: string;
  description?: string;
  hooks: HookFile['hooks'];
  /** True when the hook is a directory bundle with script files */
  isBundle: boolean;
  /** Absolute path to the bundle directory (only set for bundles) */
  dirPath?: string;
}

function isJsonFile(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === '.json';
}

function toId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

export function ensureHooksDirectory(): string {
  const directory = getHooksDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

/**
 * Load a single-file hook entry from a .json file.
 */
function loadSingleFileHook(
  absolutePath: string,
  bareId: string,
  directory: string,
  namespace?: string
): HookEntry {
  const rawContent = fs.readFileSync(absolutePath, 'utf-8');
  const parsed = hookFileSchema.parse(JSON.parse(rawContent));
  const id = namespace ? `${namespace}:${bareId}` : bareId;

  return {
    id,
    bareId,
    namespace,
    source: directory,
    filePath: absolutePath,
    name: parsed.name,
    description: parsed.description,
    hooks: parsed.hooks,
    isBundle: false,
  };
}

/**
 * Load a bundle hook entry from a directory containing hook.json.
 */
function loadBundleHook(
  bundleDir: string,
  bareId: string,
  parentDir: string,
  namespace?: string
): HookEntry {
  const hookJsonPath = path.join(bundleDir, HOOK_JSON);
  const rawContent = fs.readFileSync(hookJsonPath, 'utf-8');
  const parsed = hookFileSchema.parse(JSON.parse(rawContent));
  const id = namespace ? `${namespace}:${bareId}` : bareId;

  return {
    id,
    bareId,
    namespace,
    source: parentDir,
    filePath: hookJsonPath,
    name: parsed.name,
    description: parsed.description,
    hooks: parsed.hooks,
    isBundle: true,
    dirPath: bundleDir,
  };
}

/**
 * Load hook entries from a single directory.
 * Scans for both bundle directories (containing hook.json) and standalone .json files.
 */
export function loadHooksFromDirectory(directory: string, namespace?: string): HookEntry[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const dirEntries = fs.readdirSync(directory, { withFileTypes: true });
  const result: HookEntry[] = [];

  for (const entry of dirEntries) {
    try {
      if (entry.isDirectory()) {
        const hookJsonPath = path.join(directory, entry.name, HOOK_JSON);
        if (fs.existsSync(hookJsonPath)) {
          result.push(
            loadBundleHook(path.join(directory, entry.name), entry.name, directory, namespace)
          );
        }
      } else if (entry.isFile() && isJsonFile(entry.name)) {
        const bareId = toId(entry.name);
        const absolutePath = path.join(directory, entry.name);
        result.push(loadSingleFileHook(absolutePath, bareId, directory, namespace));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse hook "${entry.name}": ${msg}`);
    }
  }

  return result;
}

/**
 * List all files in a hook bundle for distribution.
 * Excludes hook.json itself (config is merged into settings.json, not copied).
 */
export function listHookBundleFiles(entry: HookEntry): BundleFile[] {
  if (!entry.isBundle || !entry.dirPath) return [];

  const files: BundleFile[] = [];
  collectFiles(entry.dirPath, entry.dirPath, files);
  return files;
}

function collectFiles(baseDir: string, currentDir: string, files: BundleFile[]): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(baseDir, fullPath, files);
    } else {
      // Include all files (scripts, hook.json, anything else in the bundle)
      files.push({
        sourcePath: fullPath,
        relativePath: path.relative(baseDir, fullPath),
      });
    }
  }
}

/**
 * Load all hooks from the default library, flat sources, and marketplace sources.
 */
export function loadHookLibrary(): HookEntry[] {
  const result: HookEntry[] = [];

  const defaultDir = ensureHooksDirectory();
  result.push(...loadHooksFromDirectory(defaultDir));

  const { flatSources, marketplaceEntries } = loadEntriesFromSources();

  for (const { namespace, basePath } of flatSources) {
    const hooksDir = path.join(basePath, 'hooks');
    result.push(...loadHooksFromDirectory(hooksDir, namespace));
  }

  result.push(...marketplaceEntries.hooks);

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
