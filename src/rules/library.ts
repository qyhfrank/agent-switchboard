import fs from 'node:fs';
import path from 'node:path';
import { getRulesDir } from '../config/paths.js';
import { parseRuleMarkdown } from './parser.js';
import type { RuleMetadata } from './schema.js';

export interface RuleSnippet {
  id: string;
  filePath: string;
  metadata: RuleMetadata;
  content: string;
}

function isMarkdownFile(fileName: string): boolean {
  const extension = path.extname(fileName).toLowerCase();
  return extension === '.md' || extension === '.markdown';
}

function toRuleId(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

export function ensureRulesDirectory(): string {
  const directory = getRulesDir();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return directory;
}

export function loadRuleLibrary(): RuleSnippet[] {
  const directory = ensureRulesDirectory();
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  const rules: RuleSnippet[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseRuleMarkdown(rawContent);
      rules.push({
        id: toRuleId(entry.name),
        filePath: absolutePath,
        metadata: parsed.metadata,
        content: parsed.content,
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to parse rule snippet "${entry.name}": ${error.message}`);
      }
      throw error;
    }
  }

  rules.sort((a, b) => a.id.localeCompare(b.id));
  return rules;
}
