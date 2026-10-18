import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWebServer } from '../src/main/web/http-server';
import {
  serviceReleaseMatches,
  serviceIdentityMatches,
  type ServiceIdentity,
} from '../src/main/web/service-identity';

const identity: ServiceIdentity = {
  product: 'catbots',
  bundleId: 'com.catbots.desktop',
  releaseId: '0.2.0+abc123',
  version: '0.2.0',
  commit: 'abc123',
  architecture: 'arm64',
  protocolVersion: 1,
  dataSchemaVersion: 6,
  instanceId: 'instance-123',
  readiness: 'ready',
  resumePolicy: 'manual-only',
};

const closeTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

async function occupyPort(response: unknown): Promise<{ port: number; origin: string }> {
  const server = createServer((_request, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  closeTasks.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TEST_PORT_UNAVAILABLE');
  return { port: address.port, origin: `http://127.0.0.1:${address.port}` };
}

describe('web service startup', () => {
  it('fails closed when the requested port is occupied and never kills its listener', async () => {
    const foreign = await occupyPort({ product: 'another-app' });
    const kill = vi.spyOn(process, 'kill');

    await expect(startWebServer({
      port: foreign.port,
      identity: () => identity,
      invoke: vi.fn(),
      subscribe: () => () => undefined,
      asset: vi.fn(),
    })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not accept a foreign health response as the expected Catbots owner', async () => {
    const foreign = await occupyPort({
      ...identity,
      bundleId: 'fun.attacker.desktop',
      instanceId: 'foreign-instance',
    });
    const kill = vi.spyOn(process, 'kill');

    const observed = await (await fetch(`${foreign.origin}/api/health`)).json();

    expect(serviceIdentityMatches(observed, identity)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it('compares every stable identity field while allowing readiness to change', () => {
    expect(serviceIdentityMatches({ ...identity, readiness: 'starting' }, identity)).toBe(true);
    expect(serviceIdentityMatches({ ...identity, commit: 'different' }, identity)).toBe(false);
    expect(serviceIdentityMatches({ ...identity, protocolVersion: 2 }, identity)).toBe(false);
    expect(serviceIdentityMatches({ ...identity, dataSchemaVersion: 7 }, identity)).toBe(false);
    expect(serviceIdentityMatches({ ...identity, maintenanceOperationId: 'foreign-operation' }, identity)).toBe(false);
  });

  it('accepts a fresh instance only when the installed release identity matches', () => {
    const expected = {
      product: 'catbots' as const,
      bundleId: 'com.catbots.desktop' as const,
      releaseId: identity.releaseId,
      version: identity.version,
      commit: identity.commit,
      architecture: identity.architecture,
      protocolVersion: identity.protocolVersion,
      dataSchemaVersion: identity.dataSchemaVersion,
      resumePolicy: 'manual-only' as const,
    };

    expect(serviceReleaseMatches({ ...identity, instanceId: 'fresh-instance' }, expected)).toBe(true);
    expect(serviceReleaseMatches({ ...identity, releaseId: 'foreign-release' }, expected)).toBe(false);
    expect(serviceReleaseMatches({ ...identity, instanceId: '' }, expected)).toBe(false);
  });
});
