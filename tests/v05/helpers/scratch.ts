import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Scratch homes for 0.5 engine tests. Every environment root the engine
 * resolves (library, agents home, cache, state) points into one disposable
 * temp tree; the real user homes are never read or written.
 */

const MANAGED_ENV = [
  'ASB_HOME',
  'ASB_AGENTS_HOME',
  'ASB_CACHE_HOME',
  'ASB_STATE_HOME',
  'ASB_CONFIG',
  'ASB_PROFILE',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
] as const;

export interface ScratchHomes {
  root: string;
  asbHome: string;
  agentsHome: string;
  cacheHome: string;
  stateHome: string;
}

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

export async function withScratchHomes<T>(fn: (homes: ScratchHomes) => T | Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb05-'));
  const homes: ScratchHomes = {
    root,
    asbHome: path.join(root, 'asb-home'),
    agentsHome: path.join(root, 'agents-home'),
    cacheHome: path.join(root, 'cache'),
    stateHome: path.join(root, 'state'),
  };
  fs.mkdirSync(homes.asbHome, { recursive: true });
  fs.mkdirSync(homes.agentsHome, { recursive: true });
  const previous = new Map<string, string | undefined>(
    MANAGED_ENV.map((key) => [key, process.env[key]])
  );
  process.env.ASB_HOME = homes.asbHome;
  process.env.ASB_AGENTS_HOME = homes.agentsHome;
  process.env.ASB_CACHE_HOME = homes.cacheHome;
  process.env.ASB_STATE_HOME = homes.stateHome;
  delete process.env.ASB_CONFIG;
  delete process.env.ASB_PROFILE;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    return await fn(homes);
  } finally {
    for (const [key, value] of previous) setEnv(key, value);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export type RuleAppId =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'trae'
  | 'trae-cn';

export const RULE_APPS: readonly RuleAppId[] = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'trae',
  'trae-cn',
];

/** Apps whose rules render wraps the composed body in mdc frontmatter. */
export const FRONTMATTER_APPS: ReadonlySet<RuleAppId> = new Set(['cursor', 'trae', 'trae-cn']);

function opencodeRoot(agentsHome: string): string {
  return process.platform === 'win32'
    ? path.join(agentsHome, 'AppData', 'Roaming', 'opencode')
    : path.join(agentsHome, '.config', 'opencode');
}

function vendorDataDir(agentsHome: string, appName: string): string {
  switch (os.platform()) {
    case 'darwin':
      return path.join(agentsHome, 'Library', 'Application Support', appName);
    case 'win32':
      return path.join(agentsHome, 'AppData', 'Roaming', appName);
    default:
      return path.join(agentsHome, '.config', appName);
  }
}

type DetectableAppId = RuleAppId | 'claude-desktop';

/** The directory whose existence marks an app as installed (frozen 0.4.35 probes). */
export function detectDir(homes: ScratchHomes, app: DetectableAppId): string {
  const home = homes.agentsHome;
  switch (app) {
    case 'claude-code':
      return path.join(home, '.claude');
    case 'codex':
      return path.join(home, '.codex');
    case 'gemini':
      return path.join(home, '.gemini');
    case 'cursor':
      return path.join(home, '.cursor');
    case 'opencode':
      return opencodeRoot(home);
    case 'trae':
      return vendorDataDir(home, 'Trae');
    case 'trae-cn':
      return vendorDataDir(home, 'Trae CN');
    case 'claude-desktop':
      return vendorDataDir(home, 'Claude');
  }
}

export function installApps(homes: ScratchHomes, ...apps: DetectableAppId[]): void {
  const ids = apps.length > 0 ? apps : [...RULE_APPS];
  for (const app of ids) {
    fs.mkdirSync(detectDir(homes, app), { recursive: true });
  }
}

/** Global-scope rules target path per app (frozen 0.4.35 table values). */
export function ruleFilePath(homes: ScratchHomes, app: RuleAppId): string {
  const home = homes.agentsHome;
  switch (app) {
    case 'claude-code':
      return path.join(home, '.claude', 'CLAUDE.md');
    case 'codex':
      return path.join(home, '.codex', 'AGENTS.md');
    case 'gemini':
      return path.join(home, '.gemini', 'AGENTS.md');
    case 'opencode':
      return path.join(opencodeRoot(home), 'AGENTS.md');
    case 'cursor':
      return path.join(home, '.cursor', 'rules', 'asb-rules.mdc');
    case 'trae':
      return path.join(home, '.trae', 'user_rules', 'asb-rules.md');
    case 'trae-cn':
      return path.join(home, '.trae-cn', 'user_rules', 'asb-rules.md');
  }
}

/** Frozen mdc frontmatter render used by cursor/trae/trae-cn rules targets. */
export function mdcWrap(body: string): string {
  const lines = ['---', 'description: Agent Switchboard Rules', 'alwaysApply: true', '---', ''];
  if (body.length > 0) lines.push(body);
  return lines.join('\n');
}

/** Expected on-disk bytes for an app's rules target given the composed body. */
export function renderedRules(app: RuleAppId, composed: string): string {
  return FRONTMATTER_APPS.has(app) ? mdcWrap(composed) : composed;
}

export function writeUserConfig(homes: ScratchHomes, toml: string): void {
  fs.writeFileSync(path.join(homes.asbHome, 'config.toml'), toml, 'utf-8');
}

export function seedRule(homes: ScratchHomes, fileName: string, body: string): string {
  const rulesDir = path.join(homes.asbHome, 'rules');
  fs.mkdirSync(rulesDir, { recursive: true });
  const filePath = path.join(rulesDir, fileName);
  fs.writeFileSync(filePath, body, 'utf-8');
  return filePath;
}
