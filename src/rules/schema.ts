import { z } from 'zod';

export const ruleMetadataSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    tags: z.array(z.string().trim().min(1)).default([]),
    requires: z.array(z.string().trim().min(1)).default([]),
  })
  .passthrough();

const agentSyncEntrySchema = z
  .object({
    hash: z.string().trim().min(1).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .passthrough();

export const ruleStateSchema = z
  .object({
    active: z.array(z.string().trim().min(1)).default([]),
    agentSync: z.record(z.string(), agentSyncEntrySchema).default({}),
  })
  .passthrough();

export type RuleMetadata = z.infer<typeof ruleMetadataSchema>;
export type RuleState = z.infer<typeof ruleStateSchema>;
