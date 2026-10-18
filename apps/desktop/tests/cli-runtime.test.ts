import { describe, expect, it, vi } from 'vitest';
import { createCliRuntimeDependencies } from '../src/main/service/cli-runtime';
import type { ServiceIdentity, ServiceReleaseIdentity } from '../src/main/web/service-identity';

const release: ServiceReleaseIdentity = {
  product: 'catbots',
  bundleId: 'com.catbots.desktop',
  releaseId: 'release-0.1.0',
  version: '0.1.0',
  commit: 'abc123',
  architecture: 'arm64',
  protocolVersion: 1,
  dataSchemaVersion: 1,
  resumePolicy: 'manual-only',
};

const identity: ServiceIdentity = {
  ...release,
  instanceId: 'instance-1',
  readiness: 'ready',
};

describe('CLI runtime composition', () => {
  it('binds each control request to the instance observed from exact health', async () => {
    const execute = vi.fn(async () => ({ ticket: 'ticket-1' }));
    const createControl = vi.fn(() => ({ execute }));
    const dependencies = createCliRuntimeDependencies({
      desiredState: { read: async () => 'running', write: async () => undefined },
      launchAgent: { start: async () => undefined, stop: async () => undefined, status: async () => ({ loaded: true }) },
      health: { current: async () => identity, waitForReady: async () => identity },
      expectedRelease: release,
      socketPath: '/Users/cat/Library/Application Support/Catbots/control.sock',
      createControl,
      openExternal: async () => undefined,
      operationId: () => 'operation-1',
      origin: 'http://127.0.0.1:5180',
    });

    await expect(dependencies.control.execute({ kind: 'mint-browser-ticket' }))
      .resolves.toEqual({ ticket: 'ticket-1' });
    expect(createControl).toHaveBeenCalledWith({
      socketPath: '/Users/cat/Library/Application Support/Catbots/control.sock',
      expectedInstanceId: 'instance-1',
    });
  });

  it('rejects a control request when no exact owner is healthy', async () => {
    const dependencies = createCliRuntimeDependencies({
      desiredState: { read: async () => 'stopped', write: async () => undefined },
      launchAgent: { start: async () => undefined, stop: async () => undefined, status: async () => ({ loaded: false }) },
      health: { current: async () => undefined, waitForReady: async () => identity },
      expectedRelease: release,
      socketPath: '/tmp/control.sock',
      createControl: vi.fn(),
      openExternal: async () => undefined,
      operationId: () => 'operation-1',
      origin: 'http://127.0.0.1:5180',
    });

    await expect(dependencies.control.execute({ kind: 'status' }))
      .rejects.toThrow('SERVICE_UNAVAILABLE');
  });
});
