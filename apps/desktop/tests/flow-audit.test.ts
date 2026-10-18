import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FlowAuditStore } from '../src/main/connections/flow-audit';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-audit-')); dirs.push(dir);
  const path = join(dir, 'audit.sqlite');
  return { path, store: new FlowAuditStore(path) };
}
const event = { botId: 'bot-a', deploymentId: 'deployment', version: 3, kind: 'evaluation' as const, details: { trace: [{ nodeId: 'condition', outputs: { passed: false } }], orders: [] } };

it('retains immutable no-order evaluations across reopen with bot-isolated pagination', () => {
  const { path, store } = setup();
  const first = structuredClone(event); store.append(first); first.details.trace[0].outputs.passed = true;
  store.append({ ...event, botId: 'other' }); store.append(event);
  const reopened = new FlowAuditStore(path);
  const page = reopened.list('bot-a', 0, 1);
  expect(page).toHaveLength(1);
  expect(page[0].details).toEqual(event.details);
  const next = reopened.list('bot-a', page[0].sequence, 1);
  expect(next).toHaveLength(1);
  expect(next[0].sequence).toBeGreaterThan(page[0].sequence);
  expect(reopened.list('bot-a', next[0].sequence)).toEqual([]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('redacts nested credentials before writing to disk', () => {
  const { path, store } = setup();
  const secret = 'sensitive-test-secret';
  store.append({ ...event, details: { api_key: secret, nested: [{ privateKey: secret }], error: 'Authorization: Bearer abc-secret-token', hex: '0x' + 'a'.repeat(64), price: 123 } });
  expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false);
  expect(JSON.stringify(store.list('bot-a'))).not.toContain('abc-secret-token');
  expect(JSON.stringify(store.list('bot-a'))).not.toContain('a'.repeat(64));
  expect(store.list('bot-a')[0].details).toMatchObject({ price: 123, api_key: '[REDACTED]' });
});

it('rejects invalid cursors, limits and oversized events instead of silently truncating evidence', () => {
  const { store } = setup();
  for (const [after, limit] of [[-1, 1], [0.5, 1], [0, 0], [0, 101], [0, NaN]])
    expect(() => store.list('bot-a', after, limit)).toThrow();
  expect(() => store.append({ ...event, details: { text: 'x'.repeat(2 * 1024 * 1024) } })).toThrow('AUDIT_EVENT_TOO_LARGE');
});
