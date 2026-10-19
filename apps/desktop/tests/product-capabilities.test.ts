import { expect, it } from 'vitest';
import * as capabilities from '../src/shared/product-capabilities';

it('exposes real exchange connections without enabling execution or simulated preview connections', () => {
  expect(capabilities).toHaveProperty('localAppCapabilities.exchangeConnections', true);
  expect(capabilities).toHaveProperty('localAppCapabilities.liveExecution', false);
  expect(capabilities).toHaveProperty('localAppCapabilities.paperExecution', false);
  expect(capabilities.strategyLabCapabilities.exchangeConnections).toBe(false);
});
