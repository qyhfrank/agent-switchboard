import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from '@iarna/toml';
import { getCodexConfigPath } from '../config/paths.js';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { extractMergedFrontmatter, slugify } from '../util/markdown.js';

export type SubagentPlatform = 'claude-code' | 'opencode' | 'cursor' | 'codex';

export interface ImportedSubagent {
  slug: string;
  content: string; // Markdown with YAML frontmatter per library schema
}

export function importSubagentFromFile(
  platform: SubagentPlatform,
  filePath: string
): ImportedSubagent {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const baseSlug = slugify(path.basename(filePath, path.extname(filePath)));

  switch (platform) {
    case 'claude-code':
    case 'opencode':
    case 'cursor': {
      const extracted = extractMergedFrontmatter(raw, { trimBodyStart: true });
      const metaRecord = extracted.meta;
      const description =
        typeof metaRecord.description === 'string' ? (metaRecord.description as string) : '';
      const rest = Object.fromEntries(
        Object.entries(metaRecord).filter(([k]) => k !== 'description')
      );
      const fm = { description, extras: { [platform]: rest } };
      const bodyNoFrontmatter = extracted.body.replace(/^\s*---\s*[\s\S]*?\r?\n---\s*\r?\n?/, '');
      return { slug: baseSlug, content: wrapFrontmatter(fm, bodyNoFrontmatter) };
    }
    case 'codex': {
      return importCodexAgentRole(baseSlug, raw, filePath);
    }
    default: {
      // biome-ignore lint/suspicious/noExplicitAny: exhaustive check fallback
      const never: any = platform;
      throw new Error(`Unsupported platform: ${never}`);
    }
  }
}

/**
 * Import a Codex agent role from its TOML config file.
 * Reads the TOML content and converts to ASB library format.
 */
function importCodexAgentRole(slug: string, raw: string, filePath: string): ImportedSubagent {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse TOML file: ${filePath}`);
  }

  // Also try to read the description from config.toml's [agents.<slug>] entry
  let description = '';
  try {
    const configPath = getCodexConfigPath();
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf-8');
      const configParsed = parseToml(configContent) as Record<string, unknown>;
      const agents = configParsed.agents as Record<string, unknown> | undefined;
      if (agents) {
        const entry = agents[slug] as Record<string, unknown> | undefined;
        if (entry && typeof entry.description === 'string') {
          description = entry.description;
        }
      }
    }
  } catch {
    // Best-effort: description may be empty
  }

  // Extract Codex-specific fields for extras.codex
  const codexFields: Record<string, unknown> = {};
  const IMPORTABLE_FIELDS = [
    'model',
    'model_reasoning_effort',
    'model_reasoning_summary',
    'model_verbosity',
    'sandbox_mode',
  ];
  for (const field of IMPORTABLE_FIELDS) {
    if (parsed[field] !== undefined) {
      codexFields[field] = parsed[field];
    }
  }

  // developer_instructions becomes the Markdown body
  const devInstructions =
    typeof parsed.developer_instructions === 'string' ? parsed.developer_instructions : '';

  const fm: Record<string, unknown> = { description };
  if (Object.keys(codexFields).length > 0) {
    fm.extras = { codex: codexFields };
  }

  return {
    slug,
    content: wrapFrontmatter(fm, devInstructions.trim() ? `\n${devInstructions}` : '\n'),
  };
}
