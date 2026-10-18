import type { CliCommand, ControlCommand } from '../application/process-intent';
import type { DesiredServiceState } from './desired-state';
import type { LaunchAgentStatus } from './launch-agent';
import { serviceIdentityMatches, type ServiceIdentity } from '../web/service-identity';

type MaintenanceBlocker = Readonly<{
  kind: string;
  route: string;
  [key: string]: unknown;
}>;

export type CliOutcome =
  | Readonly<{ kind: 'started'; identity: ServiceIdentity }>
  | Readonly<{ kind: 'stopped' }>
  | Readonly<{ kind: 'opened'; url: string }>
  | Readonly<{ kind: 'blocked'; blockers: readonly MaintenanceBlocker[]; action: string }>
  | Readonly<{
      kind: 'status';
      desired: DesiredServiceState;
      observed: 'running' | 'starting' | 'stopped';
      localUrl: string;
      identity?: ServiceIdentity;
      action?: string;
    }>;

export type CliDependencies = Readonly<{
  desiredState: {
    read(): Promise<DesiredServiceState>;
    write(state: DesiredServiceState): Promise<void>;
  };
  launchAgent: {
    start(): Promise<void>;
    stop(): Promise<void>;
    status(): Promise<LaunchAgentStatus>;
  };
  control: {
    execute(command: ControlCommand): Promise<unknown>;
  };
  health: {
    current(): Promise<ServiceIdentity | undefined>;
    waitForReady(): Promise<ServiceIdentity>;
  };
  expectedIdentity?: ServiceIdentity;
  acceptIdentity?: (identity: ServiceIdentity) => boolean;
  openExternal(url: string): Promise<void>;
  operationId(): string;
  origin: string;
}>;

export async function runCliCommand(
  command: CliCommand,
  dependencies: CliDependencies,
): Promise<CliOutcome> {
  if (command === 'status') return status(dependencies);
  if (command === 'start') return start(dependencies);
  if (command === 'stop') return stop(dependencies);
  return open(dependencies);
}

export function formatCliOutcome(outcome: CliOutcome): string {
  if (outcome.kind === 'opened') return 'Opened Catbots in your browser.';
  if (outcome.kind === 'started') return 'Catbots is running at http://127.0.0.1:5180.';
  if (outcome.kind === 'stopped') return 'Catbots is stopped.';
  if (outcome.kind === 'blocked') return `Catbots could not stop safely. ${outcome.action}`;
  const release = outcome.identity === undefined
    ? ''
    : ` Release ${outcome.identity.releaseId}.`;
  const action = outcome.action === undefined ? '' : ` ${outcome.action}`;
  return `Catbots is ${outcome.observed}; desired state is ${outcome.desired}.${release}${action}`;
}

async function start(dependencies: CliDependencies): Promise<CliOutcome> {
  await dependencies.desiredState.write('running');
  await dependencies.launchAgent.start();
  const identity = await dependencies.health.waitForReady();
  assertExpectedIdentity(identity, dependencies);
  return { kind: 'started', identity };
}

async function stop(dependencies: CliDependencies): Promise<CliOutcome> {
  const operationId = dependencies.operationId();
  const decision = parseMaintenanceDecision(await dependencies.control.execute({
    kind: 'prepare-maintenance',
    operationId,
    reason: 'stop',
  }));
  if (decision.kind === 'blocked') {
    const route = decision.blockers[0]?.route ?? '/#deploy';
    return {
      kind: 'blocked',
      blockers: decision.blockers,
      action: `Open ${dependencies.origin}${route} to resolve the blockers.`,
    };
  }
  if (decision.leaseId !== operationId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
  await dependencies.control.execute({ kind: 'shutdown', leaseId: decision.leaseId });
  await dependencies.launchAgent.stop();
  await dependencies.desiredState.write('stopped');
  return { kind: 'stopped' };
}

async function open(dependencies: CliDependencies): Promise<CliOutcome> {
  const observed = await dependencies.health.current();
  if (observed === undefined) await start(dependencies);
  else assertExpectedIdentity(observed, dependencies);

  const ticket = parseTicket(await dependencies.control.execute({ kind: 'mint-browser-ticket' }));
  const url = `${dependencies.origin}/api/session?ticket=${encodeURIComponent(ticket)}`;
  await dependencies.openExternal(url);
  return { kind: 'opened', url };
}

async function status(dependencies: CliDependencies): Promise<CliOutcome> {
  const [desired, agent, identity] = await Promise.all([
    dependencies.desiredState.read(),
    dependencies.launchAgent.status(),
    dependencies.health.current(),
  ]);
  if (identity !== undefined) {
    assertExpectedIdentity(identity, dependencies);
    return {
      kind: 'status',
      desired,
      observed: 'running',
      localUrl: dependencies.origin,
      identity,
      ...(desired === 'stopped'
        ? { action: 'Run catbots stop if you want the service to remain stopped.' }
        : {}),
    };
  }
  return {
    kind: 'status',
    desired,
    observed: agent.loaded ? 'starting' : 'stopped',
    localUrl: dependencies.origin,
    ...(desired === 'running'
      ? { action: 'Run catbots start to restore the local service.' }
      : {}),
  };
}

function assertExpectedIdentity(observed: ServiceIdentity, dependencies: CliDependencies): void {
  const accepted = dependencies.acceptIdentity?.(observed)
    ?? (dependencies.expectedIdentity !== undefined
      && serviceIdentityMatches(observed, dependencies.expectedIdentity));
  if (!accepted || observed.readiness !== 'ready') {
    throw new Error('SERVICE_IDENTITY_MISMATCH');
  }
}

function parseTicket(value: unknown): string {
  if (value === null || typeof value !== 'object') throw new Error('BROWSER_TICKET_INVALID');
  const ticket = (value as { ticket?: unknown }).ticket;
  if (typeof ticket !== 'string' || ticket.length === 0) throw new Error('BROWSER_TICKET_INVALID');
  return ticket;
}

function parseMaintenanceDecision(value: unknown):
  | Readonly<{ kind: 'ready'; leaseId: string }>
  | Readonly<{ kind: 'blocked'; blockers: readonly MaintenanceBlocker[] }> {
  if (value === null || typeof value !== 'object') throw new Error('MAINTENANCE_RESPONSE_INVALID');
  const candidate = value as {
    kind?: unknown;
    blockers?: unknown;
    lease?: { operationId?: unknown };
  };
  if (candidate.kind === 'blocked' && Array.isArray(candidate.blockers)
    && candidate.blockers.every(isMaintenanceBlocker)) {
    return { kind: 'blocked', blockers: candidate.blockers };
  }
  if (candidate.kind === 'ready' && typeof candidate.lease?.operationId === 'string') {
    return { kind: 'ready', leaseId: candidate.lease.operationId };
  }
  throw new Error('MAINTENANCE_RESPONSE_INVALID');
}

function isMaintenanceBlocker(value: unknown): value is MaintenanceBlocker {
  return value !== null && typeof value === 'object'
    && typeof (value as MaintenanceBlocker).kind === 'string'
    && typeof (value as MaintenanceBlocker).route === 'string';
}
