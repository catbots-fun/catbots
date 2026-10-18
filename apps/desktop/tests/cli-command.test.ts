import { describe, expect, it, vi } from 'vitest';
import { runCliCommand, type CliDependencies } from '../src/main/service/cli-command';
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

function fixture(overrides: Partial<CliDependencies> = {}) {
  let desired: 'running' | 'stopped' = 'stopped';
  const calls: string[] = [];
  const dependencies: CliDependencies = {
    desiredState: {
      read: async () => desired,
      write: async (state) => { desired = state; calls.push(`desired:${state}`); },
    },
    launchAgent: {
      start: async () => { calls.push('agent:start'); },
      stop: async () => { calls.push('agent:stop'); },
      status: async () => ({ loaded: desired === 'running', executablePath: identity.releaseId }),
    },
    control: {
      execute: vi.fn(async (command) => {
        calls.push(`control:${command.kind}`);
        if (command.kind === 'mint-browser-ticket') return { ticket: 'one time/ticket' };
        if (command.kind === 'prepare-maintenance') {
          return { kind: 'ready', lease: { operationId: command.operationId, reason: 'stop' } };
        }
        return { kind: 'stopped' };
      }),
    },
    health: {
      current: async () => undefined,
      waitForReady: async () => { calls.push('health:wait'); return identity; },
    },
    expectedIdentity: identity,
    openExternal: async (url) => { calls.push(`open:${url}`); },
    operationId: () => 'operation-1',
    origin: 'http://127.0.0.1:5180',
    ...overrides,
  };
  return { calls, dependencies, desired: () => desired };
}

describe('runCliCommand', () => {
  it('persists running, loads the service, and waits for exact health on start', async () => {
    const value = fixture();

    await expect(runCliCommand('start', value.dependencies)).resolves.toEqual({
      kind: 'started',
      identity,
    });
    expect(value.calls).toEqual(['desired:running', 'agent:start', 'health:wait']);
  });

  it('fails closed when the started service reports another identity', async () => {
    const value = fixture({
      health: {
        current: async () => undefined,
        waitForReady: async () => ({ ...identity, releaseId: 'foreign-release' }),
      },
    });

    await expect(runCliCommand('start', value.dependencies)).rejects.toThrow('SERVICE_IDENTITY_MISMATCH');
  });

  it('returns every maintenance blocker without stopping or persisting stopped', async () => {
    const blockers = [
      { kind: 'active-deployment', deploymentId: 'deployment-1', mode: 'paper', route: '/#deploy' },
      { kind: 'unknown-order-outcome', clientOrderId: 'order-1', route: '/#deploy' },
    ] as const;
    const value = fixture({
      control: { execute: vi.fn(async () => ({ kind: 'blocked', blockers })) },
    });

    await expect(runCliCommand('stop', value.dependencies)).resolves.toEqual({
      kind: 'blocked',
      blockers,
      action: 'Open http://127.0.0.1:5180/#deploy to resolve the blockers.',
    });
    expect(value.calls).not.toContain('agent:stop');
    expect(value.desired()).toBe('stopped');
  });

  it('shuts down a leased owner before unloading and persisting stopped', async () => {
    const value = fixture();

    await expect(runCliCommand('stop', value.dependencies)).resolves.toEqual({ kind: 'stopped' });
    expect(value.dependencies.control.execute).toHaveBeenNthCalledWith(1, {
      kind: 'prepare-maintenance',
      operationId: 'operation-1',
      reason: 'stop',
    });
    expect(value.dependencies.control.execute).toHaveBeenNthCalledWith(2, {
      kind: 'shutdown',
      leaseId: 'operation-1',
    });
    expect(value.calls).toEqual([
      'control:prepare-maintenance',
      'control:shutdown',
      'agent:stop',
      'desired:stopped',
    ]);
  });

  it('rejects a maintenance lease issued for another operation', async () => {
    const value = fixture({
      control: {
        execute: vi.fn(async () => ({
          kind: 'ready',
          lease: { operationId: 'another-operation', reason: 'stop' },
        })),
      },
    });

    await expect(runCliCommand('stop', value.dependencies))
      .rejects.toThrow('MAINTENANCE_LEASE_MISMATCH');
    expect(value.calls).toEqual([]);
  });

  it('starts when necessary and opens a one-time browser-ticket URL', async () => {
    const value = fixture();

    await expect(runCliCommand('open', value.dependencies)).resolves.toEqual({
      kind: 'opened',
      url: 'http://127.0.0.1:5180/api/session?ticket=one%20time%2Fticket',
    });
    expect(value.calls).toEqual([
      'desired:running',
      'agent:start',
      'health:wait',
      'control:mint-browser-ticket',
      'open:http://127.0.0.1:5180/api/session?ticket=one%20time%2Fticket',
    ]);
  });

  it('reports desired and observed state without mutating either', async () => {
    const value = fixture({
      health: { current: async () => identity, waitForReady: async () => identity },
    });

    await expect(runCliCommand('status', value.dependencies)).resolves.toEqual({
      kind: 'status',
      desired: 'stopped',
      observed: 'running',
      localUrl: 'http://127.0.0.1:5180',
      identity,
      action: 'Run catbots stop if you want the service to remain stopped.',
    });
    expect(value.calls).toEqual([]);
  });
});
