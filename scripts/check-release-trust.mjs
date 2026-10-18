import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function assertReleaseTrustFile(path, expectedFingerprint) {
  if (path === undefined || path.length === 0) throw new Error('Production packaging requires CATBOTS_RELEASE_TRUST_FILE.');
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint ?? '')) {
    throw new Error('Production packaging requires CATBOTS_RELEASE_TRUST_FINGERPRINT.');
  }
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Production release trust file is unreadable or invalid JSON.'); }
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
  if (Object.keys(value).sort().join(',') !== 'commit,fingerprint,publicKey,schemaVersion,teamId'
    || value.schemaVersion !== 1 || !/^[A-Z0-9]{10}$/.test(value.teamId)
    || !/^[a-f0-9]{6,64}$/.test(value.commit) || keyType !== 'rsa'
    || modulusLength === undefined || modulusLength < 3072
    || !/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/.test(value.publicKey)
    || value.fingerprint !== fingerprint
    || JSON.stringify(value).includes('REQUIRED')) {
    throw new Error('Production release trust file contains invalid or sentinel trust roots.');
  }
  if (value.fingerprint !== expectedFingerprint) {
    throw new Error('Production release trust fingerprint does not match the independently pinned value.');
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await assertReleaseTrustFile(process.env.CATBOTS_RELEASE_TRUST_FILE, process.env.CATBOTS_RELEASE_TRUST_FINGERPRINT);
}
