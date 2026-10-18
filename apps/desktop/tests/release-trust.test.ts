import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { assertReleaseTrust } from '../src/main/installer/release-trust';

describe('compiled release trust', () => {
  const publicKey = generateKeyPairSync('rsa', { modulusLength: 3072 }).publicKey
    .export({ type: 'spki', format: 'pem' }).toString();
  it('rejects every source sentinel before release input is read', () => {
    expect(() => assertReleaseTrust({ teamId: 'CATBOTS_TEAM_ID_REQUIRED', publicKey: 'valid-looking' }))
      .toThrow('RELEASE_TRUST_NOT_INJECTED');
    expect(() => assertReleaseTrust({ teamId: 'ABCDE12345', publicKey: 'CATBOTS_RELEASE_PUBLIC_KEY_REQUIRED' }))
      .toThrow('RELEASE_TRUST_NOT_INJECTED');
  });

  it('accepts only a syntactically pinned Team ID and PEM public key', () => {
    expect(assertReleaseTrust({
      teamId: 'ABCDE12345',
      publicKey,
    })).toEqual({
      teamId: 'ABCDE12345',
      publicKey,
    });
    expect(() => assertReleaseTrust({ teamId: 'bad', publicKey: 'pem' })).toThrow('RELEASE_TRUST_INVALID');
  });

  it.each([512, 1024, 2048])('rejects RSA-%i release roots below the 3072-bit minimum', (modulusLength) => {
    const weak = generateKeyPairSync('rsa', { modulusLength }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    expect(() => assertReleaseTrust({ teamId: 'ABCDE12345', publicKey: weak })).toThrow('RELEASE_TRUST_INVALID');
  });
});
