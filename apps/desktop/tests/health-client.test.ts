import { describe, expect, it } from 'vitest';
import { createHealthClient } from '../src/main/service/health-client';
import type { ServiceIdentity } from '../src/main/web/service-identity';

const identity: ServiceIdentity = {
  product: 'catbots',
  bundleId: 'com.catbots.desktop',
  releaseId: 'release-0.1.0',
  version: '0.1.0',
  commit: 'abc123',
  architecture: 'arm64',
  protocolVersion: 1,
  dataSchemaVersion: 1,
  instanceId: 'instance-1',
  readiness: 'ready',
  resumePolicy: 'manual-only',
};

describe('health client', () => {
  it('returns undefined when no local service is listening', async () => {
    const health = createHealthClient({
      origin: 'http://127.0.0.1:5180',
      fetch: async () => { throw new TypeError('fetch failed'); },
    });

    await expect(health.current()).resolves.toBeUndefined();
  });

  it('returns the complete observed identity without trusting it', async () => {
    const health = createHealthClient({
      origin: 'http://127.0.0.1:5180',
      fetch: async () => new Response(JSON.stringify(identity), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    await expect(health.current()).resolves.toEqual(identity);
  });

  it('waits through starting state and returns only ready health', async () => {
    const responses = [{ ...identity, readiness: 'starting' as const }, identity];
    const health = createHealthClient({
      origin: 'http://127.0.0.1:5180',
      fetch: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      delay: async () => undefined,
      timeoutMs: 100,
      pollMs: 1,
    });

    await expect(health.waitForReady()).resolves.toEqual(identity);
  });

  it('waits for an exact maintenance candidate instead of accepting ready health', async () => {
    const maintenance = {
      ...identity,
      readiness: 'maintenance' as const,
      maintenanceOperationId: 'operation-1',
    };
    const responses = [identity, { ...maintenance, maintenanceOperationId: 'operation-other' }, maintenance];
    const health = createHealthClient({
      origin: 'http://127.0.0.1:5180',
      fetch: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }),
      delay: async () => undefined,
      timeoutMs: 100,
      pollMs: 1,
    });

    await expect(health.waitFor((observed) => observed.readiness === 'maintenance'
      && observed.maintenanceOperationId === 'operation-1')).resolves.toEqual(maintenance);
  });

  it('fails with a stable timeout instead of accepting an occupied port', async () => {
    let now = 0;
    const health = createHealthClient({
      origin: 'http://127.0.0.1:5180',
      fetch: async () => new Response(JSON.stringify({ product: 'another-app' }), { status: 200 }),
      now: () => { now += 10; return now; },
      delay: async () => undefined,
      timeoutMs: 20,
      pollMs: 1,
    });

    await expect(health.waitForReady()).rejects.toThrow('SERVICE_START_TIMEOUT');
  });
});
