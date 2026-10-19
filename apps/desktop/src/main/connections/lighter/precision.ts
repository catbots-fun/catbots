import { createHash } from 'node:crypto';

/** Convert human decimals to integer wire units without binary rounding. */
export function toUnits(value: string, decimals: number, rounding: 'down' | 'up' = 'down'): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || !/^\d+(\.\d+)?$/.test(value)) {
    throw new Error('LIGHTER_PRECISION_INVALID');
  }
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0');
  return units + (rounding === 'up' && /[1-9]/.test(fraction.slice(decimals)) ? 1n : 0n);
}

export function clientOrderIndex(identity: string): number {
  // Lighter accepts 48-bit client indices; remain exact in both JS and Go WASM.
  return Number(BigInt(`0x${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`) || 1n);
}
