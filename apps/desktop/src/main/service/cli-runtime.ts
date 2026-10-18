import type { ControlCommand } from '../application/process-intent';
import type { CliDependencies } from './cli-command';
import {
  serviceReleaseMatches,
  type ServiceIdentity,
  type ServiceReleaseIdentity,
} from '../web/service-identity';

type CliRuntimeOptions = Readonly<{
  desiredState: CliDependencies['desiredState'];
  launchAgent: CliDependencies['launchAgent'];
  health: CliDependencies['health'];
  expectedRelease: ServiceReleaseIdentity;
  socketPath: string;
  createControl(options: Readonly<{
    socketPath: string;
    expectedInstanceId: string;
  }>): Readonly<{ execute(command: ControlCommand): Promise<unknown> }>;
  openExternal: CliDependencies['openExternal'];
  operationId: CliDependencies['operationId'];
  origin: string;
}>;

export function createCliRuntimeDependencies(options: CliRuntimeOptions): CliDependencies {
  const acceptIdentity = (identity: ServiceIdentity) => serviceReleaseMatches(
    identity,
    options.expectedRelease,
  );
  return {
    desiredState: options.desiredState,
    launchAgent: options.launchAgent,
    health: options.health,
    acceptIdentity,
    openExternal: options.openExternal,
    operationId: options.operationId,
    origin: options.origin,
    control: {
      execute: async (command) => {
        const identity = await options.health.current();
        if (identity === undefined) throw new Error('SERVICE_UNAVAILABLE');
        if (!acceptIdentity(identity)) throw new Error('SERVICE_IDENTITY_MISMATCH');
        return options.createControl({
          socketPath: options.socketPath,
          expectedInstanceId: identity.instanceId,
        }).execute(command);
      },
    },
  };
}
