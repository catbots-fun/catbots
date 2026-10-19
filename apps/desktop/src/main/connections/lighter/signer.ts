import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { z } from 'zod';
import type { LighterEnvironment } from './client';
import { isExchangeOrderId } from './precision';

export type LighterCredentials = { accountIndex: number; apiKeyIndex: number; apiPrivateKey: string };
export interface LighterSignerPort {
  publicKey(): Promise<string>;
  authToken(): Promise<string>;
  signOrder(input: { market: number; clientIndex: number; amount: string; price: string; sell: boolean; reduceOnly: boolean; nonce: number }): Promise<string>;
}

export interface LighterProtectionSignerPort extends LighterSignerPort {
  signProtection(input: { market: number; clientIndex: number; amount: string; price: string; sell: boolean; nonce: number; kind: 'sl' | 'tp'; triggerPrice: string; expiresAt: number }): Promise<string>;
  signCancel(input: { market: number; orderIndex: string; nonce: number }): Promise<string>;
}

const wireInteger = (value: string, max: bigint) => /^\d+$/.test(value) && BigInt(value) > 0n && BigInt(value) <= max;
const safeInteger = (value: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** Each connection gets its own Go VM: the upstream signer keys clients by account index only. */
export class LighterSigner implements LighterProtectionSignerPort {
  private ready: Promise<void> | undefined;
  private context: ReturnType<typeof createContext> | undefined;
  private key = '';
  constructor(private readonly assets: string, private readonly environment: LighterEnvironment, private readonly credentials: LighterCredentials) {}

  private initialize(): Promise<void> {
    return this.ready ??= this.load();
  }
  private async load() {
    const wasm = readFileSync(join(this.assets, 'signer.wasm'));
    const runtime = readFileSync(join(this.assets, 'wasm_exec.js'));
    if (createHash('sha256').update(wasm).digest('hex') !== '2ffff0374b06ada9586b3bf5d6b3bd1b979df8d0064e8422a50fee5fe03a5a50'
      || createHash('sha256').update(runtime).digest('hex') !== '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14') throw new Error('LIGHTER_SIGNER_INTEGRITY');
    const context = createContext({ WebAssembly, crypto: webcrypto, performance, TextEncoder, TextDecoder, setTimeout, clearTimeout, console: { log() {}, error() {} } });
    runInContext(runtime.toString('utf8'), context);
    const go = runInContext('new Go()', context) as { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
    const module = await WebAssembly.instantiate(wasm, go.importObject);
    void go.run(module.instance).catch(() => { this.context = undefined; });
    this.context = context;
    const result = await this.invoke('_createClientByPrv', this.credentials.apiPrivateKey, this.environment === 'production' ? 304 : 300, this.credentials.accountIndex, 0, this.credentials.apiKeyIndex);
    this.key = z.object({ success: z.literal(true), pk: z.string().regex(/^[a-fA-F0-9]{80}$/) }).parse(result).pk;
  }
  private async invoke(name: string, ...args: (number | string)[]): Promise<unknown> {
    const fn = this.context?.[name];
    if (typeof fn !== 'function') throw new Error('LIGHTER_SIGNER_UNAVAILABLE');
    const result: unknown = await fn(...args)();
    if (typeof result !== 'object' || result === null || 'error' in result) throw new Error('LIGHTER_SIGNING_FAILED');
    return result;
  }
  async publicKey() { await this.initialize(); return this.key; }
  async authToken() {
    await this.initialize();
    return z.object({ token: z.string().min(1) }).parse(await this.invoke('_createAuthToken', this.credentials.accountIndex, this.credentials.apiKeyIndex)).token;
  }
  async signOrder(input: Parameters<LighterSignerPort['signOrder']>[0]) {
    await this.initialize();
    return z.object({ txInfo: z.string().min(1) }).parse(await this.invoke('_signCreateOrder',
      this.credentials.accountIndex, input.market, input.clientIndex, input.amount, input.price,
      input.sell ? 1 : 0, 1, 0, input.reduceOnly ? 1 : 0, '0', 0, input.nonce,
    )).txInfo;
  }
  async signProtection(input: Parameters<LighterProtectionSignerPort['signProtection']>[0]) {
    const now = Date.now();
    if (!safeInteger(input.market, 32767) || !safeInteger(input.clientIndex, 2 ** 48 - 1) || input.clientIndex === 0 ||
      !safeInteger(input.nonce) || !wireInteger(input.amount, BigInt(Number.MAX_SAFE_INTEGER)) ||
      !wireInteger(input.price, 4294967295n) || !wireInteger(input.triggerPrice, 4294967295n) ||
      !safeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 28 * 86400000 ||
      !['sl', 'tp'].includes(input.kind) || typeof input.sell !== 'boolean') throw new Error('LIGHTER_PROTECTION_INVALID');
    await this.initialize();
    return z.object({ txInfo: z.string().min(1) }).parse(await this.invoke('_signCreateOrder',
      this.credentials.accountIndex, input.market, input.clientIndex, input.amount, input.price,
      input.sell ? 1 : 0, input.kind === 'sl' ? 2 : 4, 0, 1, input.triggerPrice, input.expiresAt, input.nonce,
    )).txInfo;
  }
  async signCancel(input: Parameters<LighterProtectionSignerPort['signCancel']>[0]) {
    if (!safeInteger(input.market, 32767) || !safeInteger(input.nonce) || !isExchangeOrderId(input.orderIndex)) throw new Error('LIGHTER_CANCEL_INVALID');
    await this.initialize();
    return z.object({ txInfo: z.string().min(1) }).parse(await this.invoke('_signCancelOrder',
      this.credentials.accountIndex, input.market, input.orderIndex, input.nonce,
    )).txInfo;
  }
}
