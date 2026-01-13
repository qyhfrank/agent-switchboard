import fs from 'node:fs';
import path from 'node:path';
import { wrapFrontmatter } from '../util/frontmatter.js';
import { extractMergedFrontmatter, slugify } from '../util/markdown.js';
// no parser needed here; we only strip YAML when present

export type SubagentPlatform = 'claude-code' | 'opencode';

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
    case 'opencode': {
      // Minimal conversion: description + extras.<platform> = source frontmatter without description
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
    default: {
      // biome-ignore lint/suspicious/noExplicitAny: exhaustive check fallback
      const never: any = platform;
      throw new Error(`Unsupported platform: ${never}`);
    }
  }
}
