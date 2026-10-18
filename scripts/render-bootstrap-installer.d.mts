export function renderBootstrapInstaller(input: Readonly<{
  teamId: string;
  publicKey: string;
  expectedFingerprint: string;
  commit: string;
  outputDirectory: string;
}>): Promise<Readonly<{ installerPath: string; trustPath: string; fingerprint: string }>>;
