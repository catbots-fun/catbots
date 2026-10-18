export type ReleaseArchitecture = 'arm64' | 'x64';

export type ReleaseArtifact = Readonly<{
  url: string;
  sha256: string;
  bytes: number;
}>;

export type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  releaseId: string;
  version: string;
  commit: string;
  publishedAt: string;
  minimumMacOS: string;
  bundleId: 'com.catbots.desktop';
  teamId: string;
  protocolVersion: number;
  dataSchemaVersion: number;
  artifacts: Readonly<Record<ReleaseArchitecture, ReleaseArtifact>>;
}>;

export type ManagedPaths = Readonly<{
  home: string;
  application: string;
  command: string;
  launchAgent: string;
  installerState: string;
  productData: string;
}>;

export type VerifiedRelease = Readonly<{
  releaseId: string;
  version: string;
  commit: string;
  architecture: ReleaseArchitecture;
  artifact: ReleaseArtifact;
  protocolVersion: number;
  dataSchemaVersion: number;
  stagedAppPath: string;
}>;

export type InstallPhase =
  | 'prepared'
  | 'release-verified'
  | 'maintenance-prepared'
  | 'data-snapshotted'
  | 'old-app-staged'
  | 'new-app-installed'
  | 'launch-agent-written'
  | 'candidate-verifying'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'complete';

export type PreviousInstallationState =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
      kind: 'installed';
      releaseId: string;
      desiredService: 'running' | 'stopped';
    }>;

export type InstallJournal = Readonly<{
  schemaVersion: 1;
  operationId: string;
  phase: InstallPhase;
  rollbackFromPhase?: InstallPhase;
  desiredReleaseId: string;
  previousInstallation: PreviousInstallationState;
  desiredService: 'running' | 'stopped';
  preserveData: boolean;
  paths: ManagedPaths;
  createdAt: string;
  updatedAt: string;
}>;
