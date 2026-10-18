import { describe, expect, it, vi } from 'vitest';
import {
  MaintenanceCoordinator,
  type MaintenanceObservation,
} from '../src/main/maintenance/maintenance-coordinator';

const allUnsafe = {
  deployments: [
    { id: 'paper-1', mode: 'paper' as const },
    { id: 'live-1', mode: 'live' as const },
  ],
  inFlightOrderIds: ['order-1'],
  unknownOrderIds: ['order-2'],
  databaseRepairRequired: true,
  runtime: { state: 'ready', activeBots: 1 },
};

function fixture(observation: MaintenanceObservation = { ...allUnsafe, deployments: [], inFlightOrderIds: [], unknownOrderIds: [], databaseRepairRequired: false, runtime: { state: 'ready', activeBots: 0 } }) {
  const release = vi.fn(async () => undefined);
  const dependencies = {
    blockNewWork: vi.fn(async () => release),
    inspect: vi.fn(async () => observation),
    stopRuntime: vi.fn(async () => undefined),
    checkpointWal: vi.fn(() => ({ busyFrames: 0, logFrames: 0, checkpointedFrames: 0 })),
  };
  return { coordinator: new MaintenanceCoordinator(dependencies), dependencies, release };
}

describe('MaintenanceCoordinator', () => {
  it('returns every blocker with an exact resolution route', async () => {
    const f = fixture(allUnsafe);
    const result = await f.coordinator.begin({ operationId: 'op-1', reason: 'upgrade' });
    expect(result).toEqual({
      kind: 'blocked',
      blockers: [
        { kind: 'active-deployment', deploymentId: 'paper-1', mode: 'paper', route: '/#deploy' },
        { kind: 'active-deployment', deploymentId: 'live-1', mode: 'live', route: '/#deploy' },
        { kind: 'in-flight-order', clientOrderId: 'order-1', route: '/#deploy' },
        { kind: 'unknown-order-outcome', clientOrderId: 'order-2', route: '/#deploy' },
        { kind: 'database-repair-required', route: '/#repair' },
        { kind: 'runtime-not-quiescent', state: 'ready:1', route: '/#deploy' },
      ],
    });
    expect(f.dependencies.blockNewWork.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.inspect.mock.invocationCallOrder[0]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('stops runtime and grants an idempotent lease only after a zero-frame checkpoint', async () => {
    const f = fixture();
    const first = await f.coordinator.begin({ operationId: 'op-1', reason: 'upgrade' });
    const repeated = await f.coordinator.begin({ operationId: 'op-1', reason: 'upgrade' });
    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ kind: 'ready', lease: { operationId: 'op-1' } });
    expect(f.dependencies.stopRuntime).toHaveBeenCalledOnce();
    expect(f.dependencies.checkpointWal).toHaveBeenCalledOnce();
    await expect(f.coordinator.begin({ operationId: 'op-2', reason: 'upgrade' })).rejects.toThrow('MAINTENANCE_CONFLICT');
  });

  it('rejects a busy WAL and releases the application gate', async () => {
    const f = fixture();
    f.dependencies.checkpointWal.mockReturnValue({ busyFrames: 1, logFrames: 2, checkpointedFrames: 1 });
    await expect(f.coordinator.begin({ operationId: 'op-1', reason: 'upgrade' })).rejects.toThrow('DATABASE_CHECKPOINT_BUSY');
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('commits or rolls back only the current lease and releases the gate once', async () => {
    const f = fixture();
    await f.coordinator.begin({ operationId: 'op-1', reason: 'uninstall' });
    await expect(f.coordinator.commit('wrong')).rejects.toThrow('MAINTENANCE_LEASE_MISMATCH');
    await f.coordinator.rollback('op-1');
    await f.coordinator.rollback('op-1');
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.coordinator.current()).toBeUndefined();
  });
});
