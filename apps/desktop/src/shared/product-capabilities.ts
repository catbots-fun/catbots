import { ProductCapabilitiesSchema, type ProductCapabilities } from '@catbots/contracts';

export const strategyLabCapabilities: ProductCapabilities = ProductCapabilitiesSchema.parse({
  release: 'strategy-lab-beta',
  strategyResearch: true,
  paperExecution: false,
  liveExecution: false,
  exchangeConnections: false,
});
