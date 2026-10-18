// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StrategyRevision } from '@catbots/contracts';
vi.mock('../src/renderer/workbench/live-node-run', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/renderer/workbench/live-node-run')>();
  return { ...actual, loadMarket: vi.fn(async (_api, market) => ({ source: 'Hyperliquid mainnet', market, fetchedAt: '2026-01-01T00:00:00.000Z', price: 2500, funding: 0, candles: {} })) };
});
import { LegacyNodeConfiguration } from '../src/renderer/workbench/LegacyNodeConfiguration';
beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const node = { id: 'market', kind: 'condition' as const, type: 'predicate.compare', version: 1, title: 'Compare', summary: 'Market = ETH-PERP', config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } };
const revision = { nodes: [node], edges: [], version: 1 } as unknown as StrategyRevision;
it('edits the selected legacy node configuration and submits without changing its source revision', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<LegacyNodeConfiguration node={node} revision={revision} onSave={save} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Right · fixed value' }), { target: { value: 'BTC-PERP' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as new draft' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ ...node.config, right: { literal: 'BTC-PERP' } }));
  expect(node.config.right.literal).toBe('ETH-PERP');
});
it('debugs the screenshot market guard against fetched market input', async () => {
  render(<LegacyNodeConfiguration node={node} revision={revision} />);
  fireEvent.click(screen.getByRole('button', { name: 'Execute step' }));
  await waitFor(() => expect(screen.getByText("true")).toBeTruthy());
  fireEvent.change(screen.getByRole('textbox', { name: 'Market' }), { target: { value: 'BTC-PERP' } });
  fireEvent.click(screen.getByRole('button', { name: 'Execute step' }));
  await waitFor(() => expect(screen.getByText("false")).toBeTruthy());
});
