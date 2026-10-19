import { describe, expect, it } from 'vitest';
import { toUnits, clientOrderIndex } from '../src/main/connections/lighter/precision';
import { LighterClient } from '../src/main/connections/lighter/client';

describe('Lighter boundaries', () => {
  it('rounds decimal lots without floating point drift', () => {
    expect(toUnits('1.001', 3)).toBe(1001n);
    expect(toUnits('1.0019', 3)).toBe(1001n);
    expect(toUnits('1.0019', 3, 'up')).toBe(1002n);
    expect(() => toUnits('-1', 3)).toThrow();
    expect(() => toUnits('Infinity', 3)).toThrow();
  });
  it('uses a deterministic safe Lighter order index', () => {
    const id = clientOrderIndex('0x1234');
    expect(id).toBe(clientOrderIndex('0x1234'));
    expect(id).not.toBe(clientOrderIndex('0x1235'));
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(2 ** 48);
  });
  it('rejects HTTP-200 API errors without echoing secrets', async () => {
    const request = async () => new Response(JSON.stringify({ code: 400, message: 'secret-token' }));
    await expect(new LighterClient('testnet', request as typeof fetch).get('account', {})).rejects.toThrow('LIGHTER_REQUEST_REJECTED');
  });
  it('binds requests to the selected environment', async () => {
    let url = '';
    const request = async (input: unknown) => { url = String(input); return new Response('{"code":200}'); };
    await new LighterClient('testnet', request as typeof fetch).get('account', { by: 'index', value: 12 });
    expect(url).toBe('https://testnet.zklighter.elliot.ai/api/v1/account?by=index&value=12');
  });
});
