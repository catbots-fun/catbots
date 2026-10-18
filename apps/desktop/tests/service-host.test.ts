import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createControlClient } from '../src/main/control/socket-client';
import { startServiceHost } from '../src/main/service/service-host';
import type { ServiceIdentity } from '../src/main/web/service-identity';

const identity: ServiceIdentity = {
  product: 'catbots',
  bundleId: 'com.catbots.desktop',
  releaseId: 'release-0.1.0',
  version: '0.1.0',
  commit: 'abc123',
  architecture: 'arm64',
  protocolVersion: 1,
  dataSchemaVersion: 7,
  instanceId: 'instance-1',
  readiness: 'ready',
  resumePolicy: 'manual-only',
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((task) => task())));

describe('service host', () => {
  it('serves exact health and exchanges a control-minted ticket for the browser UI', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'catbots-service-host-'));
    const socketPath = join(directory, 'control.sock');
    const host = await startServiceHost({
      port: 0,
      socketPath,
      identity: () => identity,
      invoke: vi.fn(),
      subscribe: () => () => undefined,
      asset: async () => ({
        body: new TextEncoder().encode('<!doctype html><title>Catbots</title>'),
        contentType: 'text/html; charset=utf-8',
      }),
      maintenance: { begin: vi.fn(), current: () => undefined },
      shutdown: vi.fn(),
    });
    cleanup.push(async () => { await host.close(); await rm(directory, { force: true, recursive: true }); });

    await expect((await fetch(`${host.origin}/api/health`)).json()).resolves.toEqual(identity);
    const client = createControlClient({ socketPath, expectedInstanceId: identity.instanceId });
    const minted = await client.execute({ kind: 'mint-browser-ticket' }) as { ticket: string };
    const exchanged = await fetch(`${host.origin}/api/session?ticket=${minted.ticket}`, { redirect: 'manual' });

    expect(exchanged.status).toBe(303);
    expect(exchanged.headers.get('location')).toBe('/');
    expect(exchanged.headers.get('set-cookie')).toContain('HttpOnly');
  });
});
