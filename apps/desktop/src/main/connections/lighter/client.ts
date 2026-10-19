import { z } from 'zod';

export type LighterEnvironment = 'production' | 'testnet';
export const LIGHTER_HOSTS = {
  production: 'https://mainnet.zklighter.elliot.ai',
  testnet: 'https://testnet.zklighter.elliot.ai',
} as const;

export class LighterClient {
  constructor(readonly environment: LighterEnvironment, private readonly request: typeof fetch = fetch) {}

  async get(endpoint: string, params: Record<string, string | number>, auth?: string): Promise<unknown> {
    const url = this.url(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return this.send(url, { headers: auth ? { Authorization: auth } : {} });
  }

  async submit(txType: number, txInfo: string): Promise<unknown> {
    return this.send(this.url('sendTx'), {
      method: 'POST', body: new URLSearchParams({ tx_type: String(txType), tx_info: txInfo }),
    });
  }

  private url(endpoint: string) {
    if (!/^[A-Za-z]+$/.test(endpoint)) throw new Error('LIGHTER_ENDPOINT_INVALID');
    return new URL(`/api/v1/${endpoint}`, LIGHTER_HOSTS[this.environment]);
  }

  private async send(url: URL, options: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(url, { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error', credentials: 'omit' });
    } catch { throw new Error('LIGHTER_EXCHANGE_UNREACHABLE'); }
    if (response.status === 429) throw new Error('LIGHTER_RATE_LIMITED');
    if (!response.ok) throw new Error('LIGHTER_EXCHANGE_UNREACHABLE');
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error('LIGHTER_INVALID_RESPONSE'); }
    const envelope = z.object({ code: z.number() }).safeParse(value);
    if (!envelope.success) throw new Error('LIGHTER_INVALID_RESPONSE');
    if (envelope.data.code !== 200) throw new Error('LIGHTER_REQUEST_REJECTED');
    return value;
  }
}
