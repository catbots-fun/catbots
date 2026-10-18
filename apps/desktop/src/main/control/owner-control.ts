import type { ControlCommand } from '../application/process-intent';
import type { ServiceIdentity } from '../web/service-identity';

export type MaintenanceLease = Readonly<{
  operationId: string;
  reason: 'stop' | 'upgrade' | 'uninstall';
}>;

export type OwnerControlDependencies = Readonly<{
  identity(): ServiceIdentity;
  browserTickets: { issue(ttlMs: number): string };
  maintenance: {
    begin(request: MaintenanceLease): Promise<unknown>;
    current(): MaintenanceLease | undefined;
  };
  shutdown(leaseId: string): Promise<void>;
}>;

export function createOwnerControlHandler(dependencies: OwnerControlDependencies) {
  return async (command: ControlCommand): Promise<unknown> => {
    if (command.kind === 'status') return dependencies.identity();
    if (command.kind === 'mint-browser-ticket') {
      return { ticket: dependencies.browserTickets.issue(30_000) };
    }
    if (command.kind === 'prepare-maintenance') {
      if (command.reason === 'stop') {
        return dependencies.maintenance.begin({
          operationId: command.operationId,
          reason: command.reason,
        });
      }
      throw new Error('MAINTENANCE_OPERATION_ID_REQUIRED');
    }
    const lease = dependencies.maintenance.current();
    if (lease?.operationId !== command.leaseId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
    await dependencies.shutdown(command.leaseId);
    return { kind: 'stopping' };
  };
}
