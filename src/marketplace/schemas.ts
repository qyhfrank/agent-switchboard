/**
 * Zod schemas for Claude Code marketplace and plugin manifests.
 */

import { z } from 'zod';

export const pluginSourceSchema = z
  .object({
    github: z.string().optional(),
    git: z.string().optional(),
    npm: z.string().optional(),
    pip: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();

export const pluginEntrySchema = z
  .object({
    name: z.string().min(1),
    source: z.union([z.string(), pluginSourceSchema]),
    description: z.string().optional(),
    version: z.string().optional(),
    strict: z.boolean().default(true),
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    agents: z.union([z.string(), z.array(z.string())]).optional(),
    hooks: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
  })
  .passthrough();

export const marketplaceOwnerSchema = z
  .object({
    name: z.string(),
    email: z.string().optional(),
  })
  .passthrough();

export const marketplaceMetadataSchema = z
  .object({
    pluginRoot: z.string().optional(),
  })
  .passthrough();

export const marketplaceManifestSchema = z
  .object({
    name: z.string().min(1),
    owner: marketplaceOwnerSchema,
    metadata: marketplaceMetadataSchema.optional(),
    plugins: z.array(pluginEntrySchema).default([]),
  })
  .passthrough();

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.string().optional(),
    commands: z.union([z.string(), z.array(z.string())]).optional(),
    agents: z.union([z.string(), z.array(z.string())]).optional(),
    hooks: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
  })
  .passthrough();

export type PluginSource = z.infer<typeof pluginSourceSchema>;
export type PluginEntry = z.infer<typeof pluginEntrySchema>;
export type MarketplaceManifest = z.infer<typeof marketplaceManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
