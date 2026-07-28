import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Scratch homes for 0.5 engine tests. Every environment root the engine
 * resolves (library, agents home, cache, state) points into one disposable
 * temp tree; the real user homes are never read or written. Git fixtures are
 * real repositories built under the same scratch root and reached over
 * file:// or plain paths, so no test needs the network.
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

export interface GitFixture {
  /** Push target: a bare repository usable as a clone URL. */
  bareRepo: string;
  /** Checkout used to author commits. */
  workDir: string;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

/** A bare repo plus a work clone, both under the scratch root. */
export function createGitFixture(root: string, name: string): GitFixture {
  const bareRepo = path.join(root, `${name}.git`);
  const workDir = path.join(root, `${name}-work`);
  git(['init', '--bare', '--initial-branch=main', bareRepo]);
  git(['clone', bareRepo, workDir]);
  git(['config', 'user.email', 'test@example.com'], workDir);
  git(['config', 'user.name', 'Test'], workDir);
  return { bareRepo, workDir };
}

/** Commit everything in the work tree and push it to the bare repo. */
export function commitAndPush(fixture: GitFixture, message: string): string {
  git(['add', '-A'], fixture.workDir);
  git(['commit', '-m', message], fixture.workDir);
  git(['push', 'origin', 'refs/heads/main'], fixture.workDir);
  return git(['rev-parse', 'HEAD'], fixture.workDir);
}

/** Write a file into the work tree, creating parents. */
export function writeFixtureFile(fixture: GitFixture, relative: string, content: string): string {
  const filePath = path.join(fixture.workDir, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export const gitFixtureCommand = git;

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

/** Global-scope skills parent directory per app (frozen 0.4.35 table values). */
export function skillsParentDir(homes: ScratchHomes, app: RuleAppId | 'agents'): string {
  const home = homes.agentsHome;
  switch (app) {
    case 'claude-code':
      return path.join(home, '.claude', 'skills');
    case 'codex':
      return path.join(home, '.codex', 'skills');
    case 'gemini':
      return path.join(home, '.gemini', 'skills');
    case 'opencode':
      return path.join(opencodeRoot(home), 'skills');
    case 'cursor':
      return path.join(home, '.cursor', 'skills');
    case 'trae':
      return path.join(home, '.trae', 'skills');
    case 'trae-cn':
      return path.join(home, '.trae-cn', 'skills');
    case 'agents':
      return path.join(home, '.agents', 'skills');
  }
}

export interface SeedSkillOptions {
  name?: string;
  description?: string;
  body?: string;
  /** Extra files inside the bundle, keyed by relative path. */
  files?: Record<string, string | Buffer>;
}

/** Seed a library skill bundle at <asbHome>/skills/<dirName>/ with a valid SKILL.md. */
export function seedSkill(
  homes: ScratchHomes,
  dirName: string,
  opts: SeedSkillOptions = {}
): string {
  const dir = path.join(homes.asbHome, 'skills', dirName);
  fs.mkdirSync(dir, { recursive: true });
  const doc = [
    '---',
    `name: ${opts.name ?? dirName}`,
    `description: ${opts.description ?? `${dirName} does a thing`}`,
    '---',
    '',
    opts.body ?? `Use ${dirName} when the trigger holds.`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), doc, 'utf-8');
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return dir;
}
