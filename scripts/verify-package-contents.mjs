import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
  ]);
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
