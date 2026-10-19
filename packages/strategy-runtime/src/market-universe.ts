export type MarketUniverseMarket = Readonly<{
  symbol: string;
  active: boolean;
  sizeDecimals: number;
  maximumLeverage: number;
}>;

export type MarketUniverseSnapshot = Readonly<{
  dex: 'hyperliquid' | 'lighter';
  revision: string;
  observedAt: string;
  markets: readonly MarketUniverseMarket[];
}>;

export function normalizeMarketSymbol(symbol: string): string {
  const normalized = symbol.trim();
  if (normalized.length === 0) throw new Error('Market symbol must be non-empty');
  return normalized;
}

export function orderedActiveMarkets(universe: MarketUniverseSnapshot): readonly MarketUniverseMarket[] {
  return orderedMarkets(universe).filter(({ active }) => active);
}

export function orderedMarkets(universe: MarketUniverseSnapshot): readonly MarketUniverseMarket[] {
  const normalized = universe.markets
    .map((market) => Object.freeze({ ...market, symbol: normalizeMarketSymbol(market.symbol) }));
  const symbols = new Set<string>();
  for (const { symbol } of normalized) {
    if (symbols.has(symbol)) throw new Error('Duplicate normalized market symbol.');
    symbols.add(symbol);
  }
  return Object.freeze(normalized
    .sort((left, right) => left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0));
}
