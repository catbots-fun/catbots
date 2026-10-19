import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ExchangeConnection, ExecutionTarget, ExchangeActivity, AdapterDescriptor } from '@catbots/contracts';
import type { ExchangeAdapter } from '../adapters';
import { LighterClient, type LighterEnvironment } from './client';
import { LighterSigner, type LighterSignerPort, type LighterCredentials } from './signer';
import { LighterCredentialStore } from './credentials';
import { account } from './accounts';
import { LighterFlowVenue, ordersSchema } from './venue';
import { markets } from './accounts';

export class LighterAdapter implements ExchangeAdapter {
  private signers = new Map<string, LighterSignerPort>();
  descriptor: AdapterDescriptor = { id: 'lighter', name: 'Lighter', environments: ['testnet','production'], authentication: ['api-key'], capabilities: { accountDiscovery: true, markets: ['perpetual'], trading: true } };
  constructor(private store: LighterCredentialStore, private assets: string, private request: typeof fetch = fetch,
    private signerFactory = (environment: LighterEnvironment, credentials: LighterCredentials): LighterSignerPort => new LighterSigner(this.assets, environment, credentials)) {}
  normalizeOwner(value: string) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= 2 ** 48) throw new Error('LIGHTER_ACCOUNT_INVALID');
    return String(Number(value));
  }
  async discover(owner: string, environment: LighterEnvironment) {
    const id = this.normalizeOwner(owner);
    const value = await account(new LighterClient(environment, this.request), Number(id));
    return [{ id, address: id, name: `Account ${id}`, kind: 'main' as const, equity: value.total_asset_value, withdrawable: value.available_balance, usdcBalance: value.collateral, accountMode: 'perpetual', positions: value.positions.filter(item => Number(item.position) !== 0).length }];
  }
  private async check(environment: LighterEnvironment, credentials: LighterCredentials) {
    const identity = `${environment}:${credentials.accountIndex}:${credentials.apiKeyIndex}:${createHash('sha256').update(credentials.apiPrivateKey).digest('hex')}`;
    let signer = this.signers.get(identity);
    if (!signer) {
      if (this.signers.size >= 100) throw new Error('LIGHTER_SIGNER_LIMIT');
      signer = this.signerFactory(environment, credentials);
      this.signers.set(identity, signer);
    }
    const client = new LighterClient(environment, this.request);
    const keys = z.object({ api_keys: z.array(z.object({ account_index: z.number(), api_key_index: z.number(), public_key: z.string() })) }).parse(await client.get('apikeys', { account_index: credentials.accountIndex, api_key_index: credentials.apiKeyIndex }));
    const key = await signer.publicKey();
    if (!keys.api_keys.some(item => item.account_index === credentials.accountIndex && item.api_key_index === credentials.apiKeyIndex && item.public_key.replace(/^0x/, '').toLowerCase() === key.toLowerCase())) throw new Error('LIGHTER_CREDENTIAL_INVALID');
    await client.get('accountActiveOrders', { account_index: credentials.accountIndex }, await signer.authToken());
    return { client, signer };
  }
  async connectApiKey(input: Parameters<NonNullable<ExchangeAdapter['connectApiKey']>>[0]): Promise<ExchangeConnection> {
    const credentials = { accountIndex: input.accountIndex, apiKeyIndex: input.apiKeyIndex, apiPrivateKey: input.apiPrivateKey.replace(/^0x/, '') };
    await this.check(input.environment, credentials);
    const accounts = await this.discover(String(input.accountIndex), input.environment);
    this.store.save(input.id, { ...credentials, environment: input.environment });
    return { id: input.id, name: input.name, adapterId: 'lighter', owner: String(input.accountIndex), apiKeyIndex: input.apiKeyIndex, environment: input.environment, permission: 'trading-authorized', authorizationCheckedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), accounts };
  }
  private credentials(connection: ExchangeConnection) {
    const key = this.store.get(connection.id);
    if (key.environment !== connection.environment || String(key.accountIndex) !== connection.owner || key.apiKeyIndex !== connection.apiKeyIndex) throw new Error('LIGHTER_ACCOUNT_MISMATCH');
    return key;
  }
  async verify(connection: ExchangeConnection) { await this.check(connection.environment, this.credentials(connection)); return true; }
  async createVenue(connection: ExchangeConnection, target: ExecutionTarget) {
    if (target.accountId !== connection.owner) throw new Error('LIGHTER_ACCOUNT_MISMATCH');
    const credentials = this.credentials(connection);
    const { client, signer } = await this.check(connection.environment, credentials);
    return new LighterFlowVenue(client, signer, credentials, target);
  }
  async activity(owner: string, environment: LighterEnvironment, connection?: ExchangeConnection): Promise<ExchangeActivity> {
    if (!connection || connection.owner !== this.normalizeOwner(owner) || connection.environment !== environment) throw new Error('LIGHTER_ACCOUNT_MISMATCH');
    const { client, signer } = await this.check(environment, this.credentials(connection));
    const value = await account(new LighterClient(environment, this.request), Number(this.normalizeOwner(owner)));
    const catalog = await markets(client);
    const orders = ordersSchema.parse(await client.get('accountActiveOrders', { account_index: Number(owner) }, await signer.authToken())).orders;
    return { fetchedAt: new Date().toISOString(), positions: value.positions.filter(p => Number(p.position) !== 0).map(p => ({ market: `${p.symbol}-PERP`, size: String(Number(p.position) * p.sign), entryPrice: p.avg_entry_price, unrealizedPnl: p.unrealized_pnl })), orders: orders.map(o => ({ id: o.order_id, market: `${catalog.find(m => m.market_id === o.market_index)?.symbol ?? o.market_index}-PERP`, side: o.is_ask ? 'Sell' : 'Buy', size: o.initial_base_amount, price: o.price })) };
  }
}
