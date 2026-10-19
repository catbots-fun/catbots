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
