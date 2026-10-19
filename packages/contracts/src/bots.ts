import { z } from 'zod';

export const BotStatusSchema = z.enum([
  'draft', 'paper', 'live', 'paused', 'stopped', 'error', 'recovering',
]);

export type BotStatus = z.infer<typeof BotStatusSchema>;

export const DexIdSchema = z.enum(['hyperliquid', 'lighter']);

export type DexId = z.infer<typeof DexIdSchema>;

export const CreateDraftBotInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  dex: DexIdSchema,
}).strict();

export type CreateDraftBotInput = z.infer<typeof CreateDraftBotInputSchema>;

export const BotSummarySchema = CreateDraftBotInputSchema.extend({
  id: z.string().uuid(),
  status: BotStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type BotSummary = z.infer<typeof BotSummarySchema>;
