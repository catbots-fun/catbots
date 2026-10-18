export type MaintenanceObservation = Readonly<{
  deployments: readonly Readonly<{ id: string; mode: 'paper' | 'live' }>[];
  inFlightOrderIds: readonly string[];
  unknownOrderIds: readonly string[];
  databaseRepairRequired: boolean;
  runtime: Readonly<{ state: string; activeBots: number }>;
}>;

import type { WalCheckpoint } from '../storage/database';

type Dependencies = Readonly<{
  blockNewWork(operationId: string): Promise<() => Promise<void>>;
  inspect(): Promise<MaintenanceObservation>;
  stopRuntime(): Promise<void>;
  checkpointWal(): WalCheckpoint;
}>;

type Lease = Readonly<{ operationId: string; reason: 'stop' | 'upgrade' | 'uninstall' }>;

export class MaintenanceCoordinator {
  private active: { lease: Lease; checkpoint: WalCheckpoint; release: () => Promise<void> } | undefined;
  private completed = new Set<string>();

  constructor(private readonly dependencies: Dependencies) {}

  async begin(request: Lease) {
    if (this.active?.lease.operationId === request.operationId) {
      return { kind: 'ready' as const, lease: this.active.lease, checkpoint: this.active.checkpoint };
    }
    if (this.active) throw new Error('MAINTENANCE_CONFLICT');
    const release = await this.dependencies.blockNewWork(request.operationId);
    try {
      const blockers = blockersFor(await this.dependencies.inspect());
      if (blockers.length > 0) {
        await release();
        return { kind: 'blocked' as const, blockers };
      }
      await this.dependencies.stopRuntime();
      const checkpoint = this.dependencies.checkpointWal();
      if (checkpoint.busyFrames !== 0 || checkpoint.logFrames !== 0) throw new Error('DATABASE_CHECKPOINT_BUSY');
      this.active = { lease: request, checkpoint, release };
      return { kind: 'ready' as const, lease: request, checkpoint };
    } catch (error) {
      await release();
      throw error;
    }
  }

  current(): Lease | undefined {
    return this.active?.lease;
  }

  async commit(operationId: string): Promise<void> {
    await this.finish(operationId);
  }

  async rollback(operationId: string): Promise<void> {
    await this.finish(operationId);
  }

  private async finish(operationId: string): Promise<void> {
    if (this.completed.has(operationId)) return;
    if (!this.active || this.active.lease.operationId !== operationId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
    const release = this.active.release;
    this.active = undefined;
    this.completed.add(operationId);
    await release();
  }
}

function blockersFor(observation: MaintenanceObservation) {
  return [
    ...observation.deployments.map(({ id, mode }) => ({ kind: 'active-deployment' as const, deploymentId: id, mode, route: '/#deploy' as const })),
    ...observation.inFlightOrderIds.map((clientOrderId) => ({ kind: 'in-flight-order' as const, clientOrderId, route: '/#deploy' as const })),
    ...observation.unknownOrderIds.map((clientOrderId) => ({ kind: 'unknown-order-outcome' as const, clientOrderId, route: '/#deploy' as const })),
    ...(observation.databaseRepairRequired ? [{ kind: 'database-repair-required' as const, route: '/#repair' as const }] : []),
    ...(observation.runtime.activeBots > 0 || !['ready', 'stopped'].includes(observation.runtime.state)
      ? [{ kind: 'runtime-not-quiescent' as const, state: `${observation.runtime.state}:${observation.runtime.activeBots}`, route: '/#deploy' as const }]
      : []),
  ];
}
