import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { LighterSigner } from '../src/main/connections/lighter/signer';

it('signs locally with the pinned official WASM and binds account/network', async () => {
  const signer = new LighterSigner(resolve('assets/lighter'), 'testnet', { accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: '01'.padStart(80, '0') });
  expect(await signer.publicKey()).toMatch(/^[a-f0-9]{80}$/);
  expect(await signer.authToken()).toMatch(/^\d+:12:4:/);
  const signed = JSON.parse(await signer.signOrder({ market: 0, clientIndex: 123, amount: '100', price: '240000', sell: false, reduceOnly: false, nonce: 0 }));
  expect(signed).toMatchObject({ AccountIndex: 12, ApiKeyIndex: 4, MarketIndex: 0, ClientOrderIndex: 123, BaseAmount: 100, Price: 240000, Nonce: 0 });
}, 15000);

const credentials = { accountIndex: 12, apiKeyIndex: 4, apiPrivateKey: '01'.padStart(80, '0') };
const nativeInput = () => ({ market: 0, clientIndex: 124, amount: '100', price: '230000', sell: true, nonce: 1, kind: 'sl' as const, triggerPrice: '232000', expiresAt: Date.now() + 86400000 });

it.each([['sl', 2], ['tp', 4]] as const)('signs %s as a reduce-only IOC trigger with explicit expiry', async (kind, type) => {
  const signer = new LighterSigner(resolve('assets/lighter'), 'testnet', credentials);
  const input = { ...nativeInput(), kind };
  const signed = JSON.parse(await signer.signProtection(input));
  expect(signed).toMatchObject({ AccountIndex: 12, ApiKeyIndex: 4, MarketIndex: 0, ClientOrderIndex: 124, BaseAmount: 100, Price: 230000, IsAsk: 1, Type: type, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 232000, OrderExpiry: input.expiresAt, Nonce: 1 });
}, 15000);

it('signs individual cancellation with exact string order identity', async () => {
  const signer = new LighterSigner(resolve('assets/lighter'), 'testnet', credentials);
  const signed = JSON.parse(await signer.signCancel({ market: 0, orderIndex: '281474976710657', nonce: 2 }));
  expect(signed).toMatchObject({ AccountIndex: 12, ApiKeyIndex: 4, MarketIndex: 0, Index: 281474976710657, Nonce: 2 });
}, 15000);

it.each([{ triggerPrice: '4294967296' }, { amount: '1.5' }, { amount: '0' }, { price: '0' }, { market: 32768 }, { nonce: -1 }, { clientIndex: 2 ** 48 }, { expiresAt: 0 }])('rejects invalid native wire values before signing: %j', async invalid => {
  const signer = new LighterSigner('/no-assets', 'testnet', credentials);
  await expect(signer.signProtection({ ...nativeInput(), ...invalid })).rejects.toThrow('LIGHTER_PROTECTION_INVALID');
});

it.each(['0', '1', '281474976710655', '-1', '1.1', '1152921504606846976', '9223372036854775808'])('rejects unsafe cancellation identity %s before signing', async orderIndex => {
  const signer = new LighterSigner('/no-assets', 'testnet', credentials);
  await expect(signer.signCancel({ market: 0, orderIndex, nonce: 1 })).rejects.toThrow('LIGHTER_CANCEL_INVALID');
});

it.each(['281474976710656', '1152921504606846975', '9007199254740993'])('preserves valid exchange cancellation identity %s exactly in signed JSON', async orderIndex => {
  const signer = new LighterSigner(resolve('assets/lighter'), 'testnet', credentials);
  const signed = await signer.signCancel({ market: 0, orderIndex, nonce: 1 });
  expect(signed).toMatch(new RegExp(`"Index":\\s*${orderIndex}(?:,|})`));
}, 15000);
