import { describe, expect, it, vi } from 'vitest';
import { createOwnerControlHandler } from '../src/main/control/owner-control';
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

describe('owner control handler', () => {
  it('returns exact status and mints a short-lived ticket', async () => {
    const issue = vi.fn(() => 'ticket-1');
    const handle = createOwnerControlHandler({
      identity: () => identity,
      browserTickets: { issue },
      maintenance: { begin: vi.fn(), current: vi.fn(), rollback: vi.fn() },
      shutdown: vi.fn(),
    });

    await expect(handle({ kind: 'status' })).resolves.toEqual(identity);
    await expect(handle({ kind: 'mint-browser-ticket' })).resolves.toEqual({ ticket: 'ticket-1' });
    expect(issue).toHaveBeenCalledWith(30_000);
  });

  it('uses the caller operation ID for a trading-safe stop lease', async () => {
    const decision = {
      kind: 'ready' as const,
      lease: { operationId: 'operation-1', reason: 'stop' as const },
      checkpoint: { busyFrames: 0, logFrames: 0, checkpointedFrames: 0 },
    };
    const begin = vi.fn(async () => decision);
    const shutdown = vi.fn(async () => undefined);
    const handle = createOwnerControlHandler({
      identity: () => identity,
      browserTickets: { issue: vi.fn() },
      maintenance: { begin, current: () => decision.lease, rollback: vi.fn() },
      shutdown,
    });

    await expect(handle({
      kind: 'prepare-maintenance',
      operationId: 'operation-1',
      reason: 'stop',
    })).resolves.toEqual(decision);
    await expect(handle({ kind: 'shutdown', leaseId: 'operation-1' }))
      .resolves.toEqual({ kind: 'stopping' });
    expect(begin).toHaveBeenCalledWith({ operationId: 'operation-1', reason: 'stop' });
    expect(shutdown).toHaveBeenCalledWith('operation-1');
  });

  it('rejects shutdown without the active maintenance lease', async () => {
    const shutdown = vi.fn();
    const handle = createOwnerControlHandler({
      identity: () => identity,
      browserTickets: { issue: vi.fn() },
      maintenance: { begin: vi.fn(), current: () => undefined, rollback: vi.fn() },
      shutdown,
    });

    await expect(handle({ kind: 'shutdown', leaseId: 'stale' }))
      .rejects.toThrow('MAINTENANCE_LEASE_MISMATCH');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('uses the caller operation ID for uninstall and can cancel that lease', async () => {
    const lease = { operationId: 'uninstall-1', reason: 'uninstall' as const };
    const begin = vi.fn(async () => ({ kind: 'ready' as const, lease }));
    const rollback = vi.fn(async () => undefined);
    const handle = createOwnerControlHandler({
      identity: () => identity,
      browserTickets: { issue: vi.fn() },
      maintenance: { begin, current: () => lease, rollback },
      shutdown: vi.fn(),
    });

    await expect(handle({
      kind: 'prepare-maintenance',
      operationId: 'uninstall-1',
      reason: 'uninstall',
    })).resolves.toEqual({ kind: 'ready', lease });
    await expect(handle({ kind: 'cancel-maintenance', leaseId: 'uninstall-1' }))
      .resolves.toEqual({ kind: 'cancelled' });
    expect(begin).toHaveBeenCalledWith(lease);
    expect(rollback).toHaveBeenCalledWith('uninstall-1');
  });
});
