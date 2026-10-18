import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listPackage } from '@electron/asar';

const execute = promisify(execFile);
export function isForbidden(path) {
  const names = path.split(/[\\/]/);
  return names.some((name) => name === '.superpowers'
    || /^\.?local\.env\.yaml(?:\.|$)/.test(name)
    || /^review(?:[-_.]|$)/i.test(name)
    || /^visual(?:[-_.]|$)/i.test(name));
}

export async function findForbiddenEntries(directory, displayRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const findings = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const displayPath = relative(displayRoot, path);
    if (isForbidden(displayPath)) findings.push(displayPath);
    if (entry.isDirectory()) {
      findings.push(...await findForbiddenEntries(path, displayRoot));
    } else if (entry.isFile() && entry.name.endsWith('.asar')) {
      findings.push(...listPackage(path, { isPack: false })
        .filter((archivePath) => isForbidden(archivePath))
        .map((archivePath) => `${displayPath}:${archivePath}`));
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      findings.push(...await inspectZip(path, displayRoot));
    }
  }
  return findings;
}

export async function verifyPackageContents(artifactDirectory) {
  const findings = await findForbiddenEntries(artifactDirectory, artifactDirectory);
  if (findings.length > 0) throw new Error(`Forbidden packaged files: ${findings.join(', ')}`);
}

export async function verifyRequiredEntries(artifactDirectory, requiredEntries) {
  const entries = await collectPackagedEntries(artifactDirectory, artifactDirectory);
  for (const requirement of requiredEntries) {
    const expected = normalizeEntry(requirement.path);
    const found = entries.some((entry) => requirement.kind === 'exact'
      ? entry === expected || entry.endsWith(`/${expected}`)
      : entry.startsWith(expected) || entry.includes(`/${expected}`));
    if (!found) {
      const label = requirement.kind === 'exact'
        ? 'Missing required packaged entry'
        : 'Missing required packaged entry prefix';
      throw new Error(`${label}: ${expected}`);
    }
  }
}

export async function verifyProductionPackage(artifactDirectory) {
  await verifyPackageContents(artifactDirectory);
  await verifyRequiredEntries(artifactDirectory, [
    { kind: 'exact', path: '.vite/renderer/main_window/web.html' },
    { kind: 'exact', path: 'Resources/catbots' },
    { kind: 'exact', path: 'Resources/fun.catbots.web.plist.template' },
    { kind: 'exact', path: 'Resources/install.sh' },
    { kind: 'exact', path: 'Resources/release-trust.json' },
  ]);
  const sentinels = await findReleaseTrustSentinels(artifactDirectory);
  if (sentinels.length > 0) throw new Error(`Release trust sentinel remains in package: ${sentinels.join(', ')}`);
  const metadata = await findReleaseTrustMetadata(artifactDirectory);
  if (metadata === 0) throw new Error('Release trust metadata missing from package');
  await verifyReleaseTrustEquality(artifactDirectory);
}

async function verifyReleaseTrustEquality(directory) {
  const identities = await collectReleaseTrustIdentities(directory);
  const installers = identities.filter((value) => value.kind === 'installer');
  const metadata = identities.filter((value) => value.kind === 'metadata');
  if (installers.length === 0 || metadata.length === 0) throw new Error('Bootstrap release trust does not match signed-app metadata');
  const expected = trustIdentity(metadata[0]);
  if ([...installers, ...metadata].some((value) => trustIdentity(value) !== expected)) {
    throw new Error('Bootstrap release trust does not match signed-app metadata');
  }
}

async function collectReleaseTrustIdentities(directory) {
  const identities = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) identities.push(...await collectReleaseTrustIdentities(path));
    else if (entry.isFile() && entry.name === 'install.sh') {
      const source = await readFile(path, 'utf8');
      const teamId = /^TEAM_ID='([^']+)'$/m.exec(source)?.[1];
      const trust = /^PUBLIC_KEY_PEM='([\s\S]*?)'\nPUBLIC_KEY_FINGERPRINT='([a-f0-9]{64})'$/m.exec(source);
      if (teamId === undefined || trust === null
        || createHash('sha256').update(trust[1]).digest('hex') !== trust[2]) {
        throw new Error('Bootstrap release trust does not match signed-app metadata');
      }
      identities.push({ kind: 'installer', teamId, publicKey: trust[1], fingerprint: trust[2] });
    } else if (entry.isFile() && entry.name === 'release-trust.json') {
      const value = JSON.parse(await readFile(path, 'utf8'));
      identities.push({ kind: 'metadata', teamId: value.teamId, publicKey: value.publicKey, fingerprint: value.fingerprint });
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      const inspectionDirectory = await mkdtemp(join(tmpdir(), 'catbots-package-trust-equality-'));
      try {
        await execute('unzip', ['-qq', '-o', path, '-d', inspectionDirectory]);
        identities.push(...await collectReleaseTrustIdentities(inspectionDirectory));
      } finally {
        await rm(inspectionDirectory, { force: true, recursive: true });
      }
    }
  }
  return identities;
}

const trustIdentity = (value) => JSON.stringify({
  teamId: value.teamId,
  publicKey: value.publicKey,
  fingerprint: value.fingerprint,
});

async function findReleaseTrustSentinels(directory) {
  const findings = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findings.push(...await findReleaseTrustSentinels(path));
    else if (entry.isFile() && entry.name === 'install.sh') {
      if (containsReleaseSentinel(await readFile(path, 'utf8'))) findings.push(path);
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      const inspectionDirectory = await mkdtemp(join(tmpdir(), 'catbots-package-trust-'));
      try {
        await execute('unzip', ['-qq', '-o', path, '-d', inspectionDirectory]);
        findings.push(...await findReleaseTrustSentinels(inspectionDirectory));
      } finally {
        await rm(inspectionDirectory, { force: true, recursive: true });
      }
    }
  }
  return findings;
}

async function findReleaseTrustMetadata(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await findReleaseTrustMetadata(path);
    else if (entry.isFile() && entry.name === 'release-trust.json') {
      let value;
      try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Release trust metadata invalid'); }
      const keys = Object.keys(value).sort().join(',');
      const fingerprint = typeof value.publicKey === 'string'
        ? createHash('sha256').update(value.publicKey).digest('hex')
        : '';
      let keyType;
      let modulusLength;
      try {
        const key = createPublicKey(value.publicKey);
        keyType = key.asymmetricKeyType;
        modulusLength = key.asymmetricKeyDetails?.modulusLength;
      } catch { keyType = undefined; }
      if (keys !== 'commit,fingerprint,publicKey,schemaVersion,teamId' || value.schemaVersion !== 1
        || !/^[A-Z0-9]{10}$/.test(value.teamId) || !/^[a-f0-9]{6,64}$/.test(value.commit) || keyType !== 'rsa'
        || modulusLength === undefined || modulusLength < 3072
        || value.fingerprint !== fingerprint || containsReleaseSentinel(JSON.stringify(value))) {
        throw new Error('Release trust metadata invalid');
      }
      count += 1;
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      const inspectionDirectory = await mkdtemp(join(tmpdir(), 'catbots-package-trust-metadata-'));
      try {
        await execute('unzip', ['-qq', '-o', path, '-d', inspectionDirectory]);
        count += await findReleaseTrustMetadata(inspectionDirectory);
      } finally {
        await rm(inspectionDirectory, { force: true, recursive: true });
      }
    }
  }
  return count;
}

function containsReleaseSentinel(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
  return text.includes('CATBOTS_TEAM_ID_REQUIRED')
    || text.includes('CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED')
    || text.includes('CATBOTS_RELEASE_COMMIT_REQUIRED')
    || text.includes('CATBOTS_RELEASE_TRUST_NOT_INJECTED')
    || text.includes('CATBOTS_RELEASE_TRUST_FINGERPRINT_REQUIRED');
}

async function collectPackagedEntries(directory, displayRoot) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const displayPath = normalizeEntry(relative(displayRoot, path));
    if (entry.isDirectory()) {
      entries.push(...await collectPackagedEntries(path, displayRoot));
    } else if (entry.isFile() && entry.name.endsWith('.asar')) {
      entries.push(displayPath);
      entries.push(...listPackage(path, { isPack: false }).map(normalizeEntry));
    } else if (entry.isFile() && entry.name.endsWith('.zip')) {
      entries.push(displayPath);
      entries.push(...await collectZipEntries(path));
    } else if (entry.isFile()) {
      entries.push(displayPath);
    }
  }
  return entries;
}

async function collectZipEntries(zipPath) {
  const inspectionDirectory = await mkdtemp(join(tmpdir(), 'catbots-package-required-'));
  try {
    await execute('unzip', ['-qq', '-o', zipPath, '-d', inspectionDirectory]);
    return await collectPackagedEntries(inspectionDirectory, inspectionDirectory);
  } finally {
    await rm(inspectionDirectory, { force: true, recursive: true });
  }
}

function normalizeEntry(path) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

async function inspectZip(zipPath, displayRoot) {
  const inspectionDirectory = await mkdtemp(join(tmpdir(), 'catbots-package-inspect-'));
  try {
    await execute('unzip', ['-qq', '-o', zipPath, '-d', inspectionDirectory]);
    const findings = await findForbiddenEntries(inspectionDirectory, inspectionDirectory);
    return findings.map((finding) => `${relative(displayRoot, zipPath)}:${finding}`);
  } finally {
    await rm(inspectionDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifactDirectory = process.argv[2];
  if (artifactDirectory === undefined) throw new Error('Usage: verify-package-contents.mjs <artifact-directory>');
  await verifyProductionPackage(artifactDirectory);
}
