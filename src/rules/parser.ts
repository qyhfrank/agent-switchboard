import { parseMarkdownWithSchema } from '../util/markdown.js';
import { type RuleMetadata, ruleMetadataSchema } from './schema.js';

export interface ParsedRule {
  metadata: RuleMetadata;
  content: string;
}

export function parseRuleMarkdown(source: string): ParsedRule {
  return parseMarkdownWithSchema(source, ruleMetadataSchema, {
    label: 'Rule',
    missingDelimiterError: 'Rule frontmatter is missing a closing delimiter (---)',
    parseErrorPrefix: 'Failed to parse rule frontmatter',
  });
}
