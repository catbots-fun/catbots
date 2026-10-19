import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { z } from 'zod';
import type { LighterEnvironment } from './client';

export type LighterCredentials = { accountIndex: number; apiKeyIndex: number; apiPrivateKey: string };
export interface LighterSignerPort {
  publicKey(): Promise<string>;
  authToken(): Promise<string>;
  signOrder(input: { market: number; clientIndex: number; amount: string; price: string; sell: boolean; reduceOnly: boolean; nonce: number }): Promise<string>;
}

/** Each connection gets its own Go VM: the upstream signer keys clients by account index only. */
export class LighterSigner implements LighterSignerPort {
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
}
