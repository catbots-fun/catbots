export const releaseTeamIdSentinel = 'CATBOTS_TEAM_ID_REQUIRED';
export const releasePublicKeySentinel = 'CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED';

declare const __CATBOTS_RELEASE_TEAM_ID__: string | undefined;
declare const __CATBOTS_RELEASE_PUBLIC_KEY__: string | undefined;
declare const __CATBOTS_RELEASE_COMMIT__: string | undefined;

export type ReleaseTrust = Readonly<{ teamId: string; publicKey: string }>;

export function assertReleaseTrust(input: ReleaseTrust): ReleaseTrust {
  if (input.teamId === releaseTeamIdSentinel || input.publicKey === releasePublicKeySentinel) {
    throw new Error('RELEASE_TRUST_NOT_INJECTED');
  }
  let keyType: string | undefined;
  let modulusLength: number | undefined;
  try {
    const key = createPublicKey(input.publicKey);
    keyType = key.asymmetricKeyType;
    modulusLength = key.asymmetricKeyDetails?.modulusLength;
  } catch { keyType = undefined; }
  if (!/^[A-Z0-9]{10}$/.test(input.teamId) || keyType !== 'rsa'
    || modulusLength === undefined || modulusLength < 3072
    || !/^-----BEGIN PUBLIC KEY-----\n[\s\S]+\n-----END PUBLIC KEY-----\n?$/.test(input.publicKey)) {
    throw new Error('RELEASE_TRUST_INVALID');
  }
  return Object.freeze({ ...input });
}

export function compiledReleaseTrust(): ReleaseTrust {
  return assertReleaseTrust({
    teamId: typeof __CATBOTS_RELEASE_TEAM_ID__ === 'string'
      ? __CATBOTS_RELEASE_TEAM_ID__
      : releaseTeamIdSentinel,
    publicKey: typeof __CATBOTS_RELEASE_PUBLIC_KEY__ === 'string'
      ? __CATBOTS_RELEASE_PUBLIC_KEY__
      : releasePublicKeySentinel,
  });
}

export function compiledReleaseCommit(): string {
  const value = typeof __CATBOTS_RELEASE_COMMIT__ === 'string' ? __CATBOTS_RELEASE_COMMIT__ : 'CATBOTS_RELEASE_COMMIT_REQUIRED';
  if (!/^[a-f0-9]{6,64}$/.test(value)) throw new Error('RELEASE_COMMIT_NOT_INJECTED');
  return value;
}
import { createPublicKey } from 'node:crypto';

