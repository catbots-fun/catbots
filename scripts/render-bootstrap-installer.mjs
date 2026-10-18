import { createHash, createPublicKey } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export async function renderBootstrapInstaller(input) {
  let keyType;
  let modulusLength;
  try {
    const key = createPublicKey(input.publicKey);
    keyType = key.asymmetricKeyType;
    modulusLength = key.asymmetricKeyDetails?.modulusLength;
  } catch { keyType = undefined; }
  if (!/^[A-Z0-9]{10}$/.test(input.teamId) || !/^[a-f0-9]{6,64}$/.test(input.commit) || keyType !== 'rsa'
    || modulusLength === undefined || modulusLength < 3072
    || !/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/.test(input.publicKey)) {
    throw new Error('RELEASE_TRUST_INVALID');
  }
  const fingerprint = createHash('sha256').update(input.publicKey).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint ?? '') || input.expectedFingerprint !== fingerprint) {
    throw new Error('RELEASE_TRUST_FINGERPRINT_MISMATCH');
  }
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const source = await readFile(join(root, 'scripts/install.sh'), 'utf8');
  const installer = source
    .replace("TEAM_ID='CATBOTS_TEAM_ID_REQUIRED'", `TEAM_ID='${input.teamId}'`)
    .replace("PUBLIC_KEY_PEM='CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED'", `PUBLIC_KEY_PEM='${input.publicKey.trim()}\n'`)
    .replace("PUBLIC_KEY_FINGERPRINT='CATBOTS_RELEASE_TRUST_FINGERPRINT_REQUIRED'", `PUBLIC_KEY_FINGERPRINT='${fingerprint}'`)
    .replace("RELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_NOT_INJECTED'", "RELEASE_TRUST_STATE='CATBOTS_RELEASE_TRUST_INJECTED'");
  if (installer.includes('CATBOTS_TEAM_ID_REQUIRED') || installer.includes('CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED')
    || installer.includes('CATBOTS_RELEASE_TRUST_FINGERPRINT_REQUIRED')
    || installer.includes('CATBOTS_RELEASE_TRUST_NOT_INJECTED')) {
    throw new Error('RELEASE_TRUST_INJECTION_FAILED');
  }
  const installerPath = join(outputDirectory, 'install.sh');
  const trustPath = join(outputDirectory, 'release-trust.json');
  await writeFile(installerPath, installer, { mode: 0o755 });
  await chmod(installerPath, 0o755);
  await writeFile(trustPath, `${JSON.stringify({
    schemaVersion: 1, teamId: input.teamId, publicKey: input.publicKey,
    commit: input.commit, fingerprint,
  })}\n`, { mode: 0o600 });
  return { installerPath, trustPath, fingerprint };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [teamId, publicKeyFile, expectedFingerprint, commit, outputDirectory] = process.argv.slice(2);
  if (!teamId || !publicKeyFile || !expectedFingerprint || !commit || !outputDirectory) {
    throw new Error('Usage: render-bootstrap-installer.mjs <team-id> <public-key-file> <expected-fingerprint> <commit> <output-directory>');
  }
  await renderBootstrapInstaller({ teamId, publicKey: await readFile(publicKeyFile, 'utf8'), expectedFingerprint, commit, outputDirectory });
}
