import { controlProtocolVersion } from '../control/protocol';
import type {
  ServiceIdentity,
  ServiceReadiness,
  ServiceReleaseIdentity,
} from '../web/service-identity';

type ReleaseIdentityInput = Readonly<{
  version: string;
  commit: string;
  architecture: string;
  dataSchemaVersion: number;
}>;

export function createServiceReleaseIdentity(input: ReleaseIdentityInput): ServiceReleaseIdentity {
  if (input.architecture !== 'arm64' && input.architecture !== 'x64') {
    throw new Error('UNSUPPORTED_ARCHITECTURE');
  }
  return Object.freeze({
    product: 'catbots',
    bundleId: 'com.catbots.desktop',
    releaseId: `${input.version}+${input.commit}`,
    version: input.version,
    commit: input.commit,
    architecture: input.architecture,
    protocolVersion: controlProtocolVersion,
    dataSchemaVersion: input.dataSchemaVersion,
    resumePolicy: 'manual-only',
  });
}

export function createServiceIdentity(
  release: ServiceReleaseIdentity,
  instanceId: string,
  readiness: ServiceReadiness,
  maintenanceOperationId?: string,
): ServiceIdentity {
  if (instanceId.length === 0) throw new Error('SERVICE_INSTANCE_ID_REQUIRED');
  return Object.freeze({
    ...release,
    instanceId,
    readiness,
    ...(maintenanceOperationId === undefined ? {} : { maintenanceOperationId }),
  });
}
