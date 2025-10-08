import fs from 'node:fs';
import path from 'node:path';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { FRONTMATTER_PATTERN, slugify, stripYamlFrontmatter } from '../util/markdown.js';

export type CommandPlatform = 'claude-code' | 'codex' | 'gemini' | 'opencode';

function parseTomlString(content: string, key: string): string | null {
  // Naive TOML key = "value" or key = """multiline"""
  const triple = new RegExp(`^\\s*${key}\\s*=\\s*"""([\\s\\S]*?)"""`, 'm');
  const single = new RegExp(`^\\s*${key}\\s*=\\s*"([\\s\\S]*?)"`, 'm');
  const m3 = content.match(triple);
  if (m3) return m3[1] ?? '';
  const m1 = content.match(single);
  if (m1) return m1[1] ?? '';
  return null;
}

export interface ImportedCommand {
  slug: string;
  content: string; // Markdown with YAML frontmatter per library schema
}

// Using shared stripYamlFrontmatter from util/markdown

export function importCommandFromFile(
  platform: CommandPlatform,
  filePath: string
): ImportedCommand {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  const baseSlug = slugify(path.basename(filePath, path.extname(filePath)));

  switch (platform) {
    case 'claude-code':
    case 'opencode': {
      // Strip any existing frontmatter and wrap into library schema (description + extras.<platform>)
      const extracted = stripYamlFrontmatter(raw);
      let body = extracted.body;
      let meta = extracted.meta ?? {};
      if (!meta || typeof meta !== 'object') meta = {};
      // Attempt to strip accidental second frontmatter at body start
      const second = body.match(FRONTMATTER_PATTERN);
      if (second && second.index === 0) {
        const stripped = stripYamlFrontmatter(body);
        meta = { ...meta, ...(stripped.meta ?? {}) };
        body = stripped.body;
      }
      const metaRecord = meta as Record<string, unknown>;
      const description =
        typeof metaRecord.description === 'string' ? (metaRecord.description as string) : '';
      const rest = Object.fromEntries(
        Object.entries(metaRecord).filter(([k]) => k !== 'description')
      );
      const fm = { description, extras: { [platform]: rest } };
      const bodyNoFrontmatter = body.replace(/^\s*---\s*[\s\S]*?\r?\n---\s*\r?\n?/, '');
      return { slug: baseSlug, content: wrapFrontmatter(fm, bodyNoFrontmatter) };
    }

    case 'codex': {
      // Pure Markdown body; keep content and add minimal frontmatter
      const fm = { description: '', extras: { codex: {} } };
      return { slug: baseSlug, content: wrapFrontmatter(fm, raw) };
    }
    case 'gemini': {
      // Minimal parse: extract prompt and description; do not infer/rename other keys
      const prompt = parseTomlString(raw, 'prompt') ?? '';
      const description = parseTomlString(raw, 'description') ?? '';
      const fm = { description, extras: { gemini: {} } };
      return { slug: baseSlug, content: wrapFrontmatter(fm, prompt) };
    }
    default: {
      // biome-ignore lint/suspicious/noExplicitAny: exhaustive check fallback
      const never: any = platform;
      throw new Error(`Unsupported platform: ${never}`);
    }
  }
}
