import { parse as parseYaml } from 'yaml';
import type { ZodTypeAny, z } from 'zod';

// Shared YAML frontmatter pattern: ---\n...\n---\n(optional newline)
export const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export function removeByteOrderMark(input: string): string {
  return input.replace(/^\uFEFF/, '');
}

export function normalizeBody(content: string): string {
  if (content.startsWith('\r\n')) return content.slice(2);
  if (content.startsWith('\n')) return content.slice(1);
  return content;
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} frontmatter must evaluate to an object`);
}

export interface ParsedFrontmatter<T> {
  metadata: T;
  content: string;
}

/**
 * Parse a Markdown document with an optional YAML frontmatter block and validate via zod schema.
 */
export function parseMarkdownWithSchema<T extends ZodTypeAny>(
  source: string,
  schema: T,
  opts: { label: string; missingDelimiterError: string; parseErrorPrefix: string }
): ParsedFrontmatter<z.infer<T>> {
  const sanitized = removeByteOrderMark(source);
  const match = sanitized.match(FRONTMATTER_PATTERN);

  if (sanitized.trimStart().startsWith('---') && !match) {
    throw new Error(opts.missingDelimiterError);
  }

  let metadataInput: Record<string, unknown> = {};
  let bodyStartIndex = 0;

  if (match) {
    try {
      metadataInput = ensureObject(parseYaml(match[1] ?? '') ?? {}, opts.label);
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`${opts.parseErrorPrefix}: ${error.message}`);
      }
      throw error;
    }
    bodyStartIndex = match[0].length;
  }

  const metadata = schema.parse(metadataInput);
  const body = sanitized.slice(bodyStartIndex);
  return { metadata, content: normalizeBody(body) };
}

export interface StrippedFrontmatter {
  meta: Record<string, unknown> | null;
  body: string;
}

/** Strip YAML frontmatter from a Markdown string (returns metadata object when possible). */
export function stripYamlFrontmatter(source: string): StrippedFrontmatter {
  const sanitized = removeByteOrderMark(source);
  const match = sanitized.match(FRONTMATTER_PATTERN);
  if (!match) return { meta: null, body: sanitized };
  try {
    const meta = (parseYaml(match[1] ?? '') ?? {}) as Record<string, unknown>;
    const body = sanitized.slice(match[0].length);
    return { meta, body };
  } catch {
    return { meta: null, body: sanitized };
  }
}

/** Slugify a filename or title to a stable id. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-');
}
