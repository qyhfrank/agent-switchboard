import { parse as parseYaml } from 'yaml';
import { type RuleMetadata, ruleMetadataSchema } from './schema.js';

const FRONTMATTER_PATTERN = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

export interface ParsedRule {
  metadata: RuleMetadata;
  content: string;
}

function removeByteOrderMark(input: string): string {
  return input.replace(/^\uFEFF/, '');
}

function normalizeContent(content: string): string {
  if (content.startsWith('\r\n')) {
    return content.slice(2);
  }
  if (content.startsWith('\n')) {
    return content.slice(1);
  }
  return content;
}

function ensureRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Rule frontmatter must evaluate to an object');
}

export function parseRuleMarkdown(source: string): ParsedRule {
  const sanitized = removeByteOrderMark(source);
  const match = sanitized.match(FRONTMATTER_PATTERN);

  if (sanitized.trimStart().startsWith('---') && !match) {
    throw new Error('Rule frontmatter is missing a closing delimiter (---)');
  }

  let metadataInput: Record<string, unknown> = {};
  let bodyStartIndex = 0;

  if (match) {
    try {
      metadataInput = ensureRecord(parseYaml(match[1] ?? '') ?? {});
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse rule frontmatter: ${error.message}`);
      }
      throw error;
    }
    bodyStartIndex = match[0].length;
  }

  const metadata = ruleMetadataSchema.parse(metadataInput);
  const body = sanitized.slice(bodyStartIndex);

  return {
    metadata,
    content: normalizeContent(body),
  };
}
