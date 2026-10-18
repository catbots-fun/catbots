import { describe, expect, it } from 'vitest';
import { createServiceIdentity, createServiceReleaseIdentity } from '../src/main/service/runtime-identity';
import { serviceReleaseMatches } from '../src/main/web/service-identity';

describe('runtime service identity', () => {
  it('gives owner and client the same release identity while keeping each owner instance unique', () => {
    const release = createServiceReleaseIdentity({
      version: '0.1.0',
      commit: 'abc123',
      architecture: 'arm64',
      dataSchemaVersion: 7,
    });
    const owner = createServiceIdentity(release, 'instance-1', 'ready');

    expect(owner).toEqual({
      product: 'catbots',
      bundleId: 'com.catbots.desktop',
      releaseId: '0.1.0+abc123',
      version: '0.1.0',
      commit: 'abc123',
      architecture: 'arm64',
      protocolVersion: 1,
      dataSchemaVersion: 7,
      instanceId: 'instance-1',
      readiness: 'ready',
      resumePolicy: 'manual-only',
    });
    expect(serviceReleaseMatches(owner, release)).toBe(true);
  });

  it('rejects an unsupported runtime architecture', () => {
    expect(() => createServiceReleaseIdentity({
      version: '0.1.0',
      commit: 'abc123',
      architecture: 'ia32',
      dataSchemaVersion: 7,
    })).toThrow('UNSUPPORTED_ARCHITECTURE');
  });
});
