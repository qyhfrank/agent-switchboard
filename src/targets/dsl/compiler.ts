/**
 * Compiles a config-driven TargetSpec (from [targets.<id>] in config.toml)
 * into a fully functional ApplicationTarget.
 *
 * The spec is intentionally permissive at the Zod schema level (passthrough);
 * structural validation happens here at compile time with clear error messages.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { ConfigScope } from '../../config/scope.js';
import { wrapFrontmatter } from '../../util/frontmatter.js';
import { extractMdId, resolveProjectRoot, wrapMdcFrontmatter } from '../builtin/common.js';
import type {
  ApplicationTarget,
  GenericLibraryEntry,
  TargetLibraryHandler,
  TargetMcpHandler,
  TargetRulesHandler,
  TargetSkillsHandler,
} from '../types.js';
import {
  type FrontmatterTransformSpec,
  type McpTransformPipeline,
  transformFrontmatter,
  transformMcpServers,
} from './transforms.js';

function expandPath(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function requireString(obj: Record<string, unknown>, key: string, context: string): string {
  const val = obj[key];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new Error(`[targets.${context}] missing required string field "${key}"`);
  }
  return val.trim();
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function optionalRecord(
  obj: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const val = obj[key];
  return typeof val === 'object' && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : undefined;
}

function optionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const val = obj[key];
  if (!Array.isArray(val)) return undefined;
  return val.filter((v): v is string => typeof v === 'string');
}

function parseFrontmatterSpec(
  spec: Record<string, unknown> | undefined
): FrontmatterTransformSpec | undefined {
  if (!spec) return undefined;
  return {
    rename: optionalRecord(spec, 'rename') as Record<string, string> | undefined,
    omit: optionalStringArray(spec, 'omit'),
    include: optionalStringArray(spec, 'include'),
    join: optionalRecord(spec, 'join') as Record<string, string> | undefined,
    defaults: optionalRecord(spec, 'defaults'),
  };
}

function compileMcpHandler(id: string, spec: Record<string, unknown>): TargetMcpHandler {
  const format = requireString(spec, 'format', `${id}.mcp`) as 'json' | 'yaml';
  const configPath = requireString(spec, 'config_path', `${id}.mcp`);
  const projectConfigPath = optionalString(spec, 'project_config_path');
  const rootKey = optionalString(spec, 'root_key') ?? 'mcpServers';
  const structure = (optionalString(spec, 'structure') ?? 'record') as 'record' | 'keyed-array';
  const keyField = optionalString(spec, 'key_field') ?? 'name';

  const pipeline: McpTransformPipeline = {
    structure,
    keyField,
    defaults: optionalRecord(spec, 'defaults'),
  };

  const envSpec = optionalRecord(spec, 'env_transform');
  if (envSpec) {
    pipeline.envTransform = {
      keyName: optionalString(envSpec, 'key_name'),
      valueName: optionalString(envSpec, 'value_name'),
    };
  }

  const serialize =
    format === 'yaml'
      ? (data: unknown) => toYaml(data, { lineWidth: 0 })
      : (data: unknown) => `${JSON.stringify(data, null, 2)}\n`;

  const parseRaw =
    format === 'yaml'
      ? (content: string) => parseYaml(content) as unknown
      : (content: string) => JSON.parse(content) as unknown;

  function writeConfig(
    filePath: string,
    config: { mcpServers: Record<string, Record<string, unknown>> }
  ): void {
    const resolved = expandPath(filePath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(resolved)) {
      let raw: unknown;
      try {
        raw = parseRaw(fs.readFileSync(resolved, 'utf-8'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[targets.${id}.mcp] Cannot parse ${resolved}: ${msg}`);
      }

      if (raw == null) {
        existing = {};
      } else if (typeof raw === 'object' && !Array.isArray(raw)) {
        existing = raw as Record<string, unknown>;
      } else {
        const kind = Array.isArray(raw) ? 'array' : typeof raw;
        throw new Error(
          `[targets.${id}.mcp] Config root must be an object, got ${kind} in ${resolved}`
        );
      }
    }

    const transformed = transformMcpServers(config.mcpServers, pipeline);
    existing[rootKey] = transformed;
    fs.writeFileSync(resolved, serialize(existing), 'utf-8');
  }

  return {
    configPath: () => expandPath(configPath),
    ...(projectConfigPath
      ? {
          projectConfigPath: (root: string) =>
            path.join(path.resolve(root), expandPath(projectConfigPath)),
        }
      : {}),
    applyConfig: (config) =>
      writeConfig(configPath, config as { mcpServers: Record<string, Record<string, unknown>> }),
    ...(projectConfigPath
      ? {
          applyProjectConfig: (root: string, config) => {
            const p = path.join(path.resolve(root), expandPath(projectConfigPath));
            writeConfig(p, config as { mcpServers: Record<string, Record<string, unknown>> });
          },
        }
      : {}),
  };
}

function compileRulesHandler(id: string, spec: Record<string, unknown>): TargetRulesHandler {
  const format = (optionalString(spec, 'format') ?? 'markdown') as 'markdown' | 'mdc';
  const filePath = requireString(spec, 'file_path', `${id}.rules`);
  const projectFilePath = optionalString(spec, 'project_file_path');

  return {
    resolveFilePath: (scope?: ConfigScope) => {
      const root = resolveProjectRoot(scope);
      if (root && projectFilePath) return path.join(root, expandPath(projectFilePath));
      return expandPath(filePath);
    },
    render: format === 'mdc' ? wrapMdcFrontmatter : (content) => content,
  };
}

function compileLibraryHandler(
  id: string,
  section: string,
  spec: Record<string, unknown>
): TargetLibraryHandler {
  const targetDir = requireString(spec, 'target_dir', `${id}.${section}`);
  const projectTargetDir = optionalString(spec, 'project_target_dir');
  const filenamePattern = optionalString(spec, 'filename_pattern') ?? '{id}.md';
  const platformKey = optionalString(spec, 'platform_key') ?? id;
  const fmSpec = parseFrontmatterSpec(optionalRecord(spec, 'frontmatter'));

  return {
    resolveTargetDir: (scope?: ConfigScope) => {
      const root = resolveProjectRoot(scope);
      if (root && projectTargetDir) return path.join(root, expandPath(projectTargetDir));
      return expandPath(targetDir);
    },
    getFilename: (entryId: string) => filenamePattern.replace('{id}', entryId),
    render: (entry: GenericLibraryEntry) => {
      const baseFm: Record<string, unknown> = {};
      if (entry.metadata.description) baseFm.description = entry.metadata.description;
      const extras = entry.metadata.extras;
      if (extras && typeof extras[platformKey] === 'object' && extras[platformKey] !== null) {
        Object.assign(baseFm, extras[platformKey]);
      }
      const fm = fmSpec ? transformFrontmatter(baseFm, fmSpec) : baseFm;
      return wrapFrontmatter(fm, entry.content);
    },
    extractIdFromFilename: extractMdId,
  };
}

function compileSkillsHandler(id: string, spec: Record<string, unknown>): TargetSkillsHandler {
  const parentDir = requireString(spec, 'parent_dir', `${id}.skills`);
  const projectParentDir = optionalString(spec, 'project_parent_dir');

  return {
    resolveParentDir: (scope?: ConfigScope) => {
      const root = resolveProjectRoot(scope);
      if (root && projectParentDir) return path.join(root, expandPath(projectParentDir));
      return expandPath(parentDir);
    },
    resolveTargetDir: (entryId: string, scope?: ConfigScope) => {
      const root = resolveProjectRoot(scope);
      if (root && projectParentDir) return path.join(root, expandPath(projectParentDir), entryId);
      return path.join(expandPath(parentDir), entryId);
    },
  };
}

/**
 * Compile a TargetSpec into a fully functional ApplicationTarget.
 * Throws descriptive errors on invalid specs.
 */
export function compileTargetSpec(id: string, spec: Record<string, unknown>): ApplicationTarget {
  const target: ApplicationTarget & {
    mcp?: TargetMcpHandler;
    rules?: TargetRulesHandler;
    commands?: TargetLibraryHandler;
    agents?: TargetLibraryHandler;
    skills?: TargetSkillsHandler;
  } = { id };

  const mcpSpec = optionalRecord(spec, 'mcp');
  if (mcpSpec) {
    (target as { mcp: TargetMcpHandler }).mcp = compileMcpHandler(id, mcpSpec);
  }

  const rulesSpec = optionalRecord(spec, 'rules');
  if (rulesSpec) {
    (target as { rules: TargetRulesHandler }).rules = compileRulesHandler(id, rulesSpec);
  }

  const commandsSpec = optionalRecord(spec, 'commands');
  if (commandsSpec) {
    (target as { commands: TargetLibraryHandler }).commands = compileLibraryHandler(
      id,
      'commands',
      commandsSpec
    );
  }

  const agentsSpec = optionalRecord(spec, 'agents');
  if (agentsSpec) {
    (target as { agents: TargetLibraryHandler }).agents = compileLibraryHandler(
      id,
      'agents',
      agentsSpec
    );
  }

  const skillsSpec = optionalRecord(spec, 'skills');
  if (skillsSpec) {
    (target as { skills: TargetSkillsHandler }).skills = compileSkillsHandler(id, skillsSpec);
  }

  return target;
}
