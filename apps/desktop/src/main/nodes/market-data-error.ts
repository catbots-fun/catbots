/** Fixed safe error shared by market readers and runtime classification. */
export class StaleMarketDataError extends Error {
  constructor() { super('Closed candles missing or stale'); this.name = 'StaleMarketDataError'; }
}
