import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Cipher } from '../authorization';
import type { LighterCredentials } from './signer';
const credentials = z.object({ accountIndex: z.number().int().nonnegative(), apiKeyIndex: z.number().int().min(4).max(254), apiPrivateKey: z.string().regex(/^[a-fA-F0-9]{80}$/), environment: z.enum(['production','testnet']) }).strict();
export class LighterCredentialStore {
  constructor(private path: string, private cipher: Cipher) {}
  private load() {
    try { return existsSync(this.path) ? z.record(z.string(), credentials).parse(JSON.parse(this.cipher.decrypt(readFileSync(this.path)))) : {}; }
    catch { throw new Error('CONNECTION_KEYSTORE_UNAVAILABLE'); }
  }
  get(id: string) { const value = this.load()[id]; if (!value) throw new Error('LIGHTER_CREDENTIAL_UNAVAILABLE'); return value; }
  save(id: string, value: LighterCredentials & { environment: 'production'|'testnet' }) {
    const records = { ...this.load(), [id]: credentials.parse(value) };
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, this.cipher.encrypt(JSON.stringify(records)), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
