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
