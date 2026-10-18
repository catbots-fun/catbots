import { afterEach, describe, expect, it } from 'vitest';
import type { AgentToolActivity, LocalConfig } from '@catbots/contracts';

import { BotRepository } from '../src/main/bots/bot-repository';
import { migrateDatabase } from '../src/main/storage/migrations';
import { openDatabase } from '../src/main/storage/database';
import { WorkbenchRepository } from '../src/main/workbench/workbench-repository';
import { WorkbenchService } from '../src/main/workbench/workbench-service';

const runAgainstProvider = process.env.CATBOTS_PROVIDER_E2E === '1' ? describe : describe.skip;

function providerConfig(): LocalConfig['llm'] {
  const provider = process.env.CATBOTS_PROVIDER_KIND;
  const baseUrl = process.env.CATBOTS_PROVIDER_URL;
  const apiKey = process.env.CATBOTS_PROVIDER_API_KEY;
  const model = process.env.CATBOTS_PROVIDER_MODEL;
  if (provider !== 'openai-compatible' && provider !== 'anthropic-compatible') {
    throw new Error('CATBOTS_PROVIDER_KIND must be openai-compatible or anthropic-compatible');
  }
  if (!baseUrl || !apiKey || !model) throw new Error('Provider acceptance environment is incomplete');
  return {
    provider,
    baseUrl,
    apiKey,
    model,
    ...(provider === 'openai-compatible' ? { reasoningEffort: 'none' as const } : {}),
  };
}

runAgainstProvider('real provider workbench acceptance', () => {
  const databases: ReturnType<typeof openDatabase>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('creates, validates, and backtests a combined-condition strategy', async () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    migrateDatabase(database);
    const bot = new BotRepository(database).createDraft({
      name: 'Provider acceptance bot',
      dex: 'hyperliquid',
    });
    const repository = new WorkbenchRepository(database);
    const service = new WorkbenchService({
      repository,
      configRepository: {
        load: async () => ({
          profile: { name: 'Provider acceptance', telemetry: false },
          llm: providerConfig(),
          exchanges: {},
        }),
      },
    });
    const activities: AgentToolActivity[] = [];
    service.subscribeActivity((activity) => activities.push(activity));

    const state = await service.sendMessage({
      botId: bot.id,
      message: [
        'Create an ETH strategy and run its backtest.',
        'Every 15 minutes, open a 2x ETH-PERP long with 10% of equity only when the position is flat and RSI 14 is below 20.',
        'Close the whole ETH-PERP position when RSI 14 is above 80.',
        'Discover the available nodes first, validate the complete strategy, and use the bundled dataset for the backtest.',
      ].join(' '),
    }).catch((error: unknown) => {
      const completedTools = activities
        .filter(({ phase }) => phase === 'tool_completed')
        .map(({ tool, message }) => tool ?? message);
      throw new Error(`Provider acceptance failed after tools: ${completedTools.join(' -> ')}`, { cause: error });
    });

    expect(state.currentRevision).toMatchObject({ schemaVersion: '2.0' });
    expect(state.currentRevision?.nodes.some(({ type }) => type === 'trigger.interval')).toBe(true);
    expect(state.currentRevision?.nodes.some(({ summary }) => summary.includes('indicator.rsi.14.value'))).toBe(true);
    expect(state.currentRevision?.nodes.some(({ type }) => type === 'execution.open_position')).toBe(true);
    expect(state.currentRevision?.nodes.some(({ type }) => type === 'execution.close_position')).toBe(true);
    expect(state.backtests).toHaveLength(1);
    expect(state.backtests[0]).toMatchObject({ status: 'completed', revisionVersion: 1 });
    expect(state.backtests[0]?.traces.length).toBeGreaterThan(0);
  }, 360_000);
});
