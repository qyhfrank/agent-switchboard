import fs from 'node:fs';
import path from 'node:path';
import { getRulesDir } from '../config/paths.js';
import { getSourcesRecord } from '../library/sources.js';
import { parseRuleMarkdown } from './parser.js';
import type { RuleMetadata } from './schema.js';

export interface RuleSnippet {
  id: string;
  bareId: string;
  namespace?: string;
  source: string;
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

/**
 * Load rules from a specific directory
 * @param directory - Directory to load rules from
 * @param namespace - Optional namespace prefix for IDs
 */
function loadRulesFromDirectory(directory: string, namespace?: string): RuleSnippet[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const rules: RuleSnippet[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isMarkdownFile(entry.name)) continue;

    const absolutePath = path.join(directory, entry.name);
    const rawContent = fs.readFileSync(absolutePath, 'utf-8');

    try {
      const parsed = parseRuleMarkdown(rawContent);
      const bareId = toRuleId(entry.name);
      const id = namespace ? `${namespace}:${bareId}` : bareId;

      rules.push({
        id,
        bareId,
        namespace,
        source: directory,
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

  return rules;
}

/**
 * Load all rules from default library and external sources
 */
export function loadRuleLibrary(): RuleSnippet[] {
  const rules: RuleSnippet[] = [];

  // Load from default library (no namespace)
  const defaultDir = ensureRulesDirectory();
  rules.push(...loadRulesFromDirectory(defaultDir));

  const sources = getSourcesRecord();
  for (const [namespace, basePath] of Object.entries(sources)) {
    const rulesDir = path.join(basePath, 'rules');
    rules.push(...loadRulesFromDirectory(rulesDir, namespace));
  }

  rules.sort((a, b) => a.id.localeCompare(b.id));
  return rules;
}
