export type ServiceReadiness = 'starting' | 'ready' | 'maintenance' | 'repair';

export type ServiceIdentity = Readonly<{
  product: 'catbots';
  bundleId: 'com.catbots.desktop';
  releaseId: string;
  version: string;
  commit: string;
  architecture: 'arm64' | 'x64';
  protocolVersion: number;
  dataSchemaVersion: number;
  instanceId: string;
  readiness: ServiceReadiness;
  resumePolicy: 'manual-only';
  maintenanceOperationId?: string;
}>;

export type ServiceReleaseIdentity = Readonly<Omit<
  ServiceIdentity,
  'instanceId' | 'readiness' | 'maintenanceOperationId'
>>;

const stableIdentityKeys = [
  'product',
  'bundleId',
  'releaseId',
  'version',
  'commit',
  'architecture',
  'protocolVersion',
  'dataSchemaVersion',
  'instanceId',
  'resumePolicy',
  'maintenanceOperationId',
] as const satisfies readonly (keyof ServiceIdentity)[];

export function serviceIdentityMatches(
  observed: unknown,
  expected: ServiceIdentity,
): observed is ServiceIdentity {
  if (observed === null || typeof observed !== 'object') return false;
  const candidate = observed as Record<string, unknown>;
  if (!['starting', 'ready', 'maintenance', 'repair'].includes(String(candidate.readiness))) {
    return false;
  }
  return stableIdentityKeys.every((key) => candidate[key] === expected[key]);
}

export function serviceReleaseMatches(
  observed: unknown,
  expected: ServiceReleaseIdentity,
): observed is ServiceIdentity {
  if (observed === null || typeof observed !== 'object') return false;
  const candidate = observed as Record<string, unknown>;
  if (typeof candidate.instanceId !== 'string' || candidate.instanceId.length === 0) return false;
  if (!['starting', 'ready', 'maintenance', 'repair'].includes(String(candidate.readiness))) return false;
  return Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

export function isServiceIdentity(value: unknown): value is ServiceIdentity {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.product === 'catbots'
    && candidate.bundleId === 'com.catbots.desktop'
    && typeof candidate.releaseId === 'string'
    && typeof candidate.version === 'string'
    && typeof candidate.commit === 'string'
    && (candidate.architecture === 'arm64' || candidate.architecture === 'x64')
    && Number.isSafeInteger(candidate.protocolVersion)
    && Number.isSafeInteger(candidate.dataSchemaVersion)
    && typeof candidate.instanceId === 'string'
    && candidate.instanceId.length > 0
    && ['starting', 'ready', 'maintenance', 'repair'].includes(String(candidate.readiness))
    && candidate.resumePolicy === 'manual-only'
    && (candidate.maintenanceOperationId === undefined
      || typeof candidate.maintenanceOperationId === 'string');
}
