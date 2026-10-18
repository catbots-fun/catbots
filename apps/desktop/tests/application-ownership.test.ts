import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { bootstrapCatbots, type BootstrapPlatform } from '../src/main/application/bootstrap';
import type { ProcessIntent } from '../src/main/application/process-intent';

function platform(lock = true) {
  const calls: string[] = [];
  const value: BootstrapPlatform = {
    requestSingleInstanceLock: vi.fn(() => { calls.push('lock'); return lock; }),
    createApplicationOwner: vi.fn(async () => { calls.push('owner'); return { close: async () => undefined }; }),
    openUi: vi.fn(async () => { calls.push('open'); return 0; }),
    runControl: vi.fn(async () => { calls.push('control'); return 0; }),
    runInstaller: vi.fn(async () => { calls.push('installer'); return 0; }),
  };
  return { calls, platform: value };
}

describe('application ownership', () => {
  it('acquires the single-instance lock before constructing the application owner', async () => {
    const fixture = platform();

    expect(await bootstrapCatbots({ kind: 'serve-web', port: 5180, window: 'never' }, fixture.platform)).toBe(0);
    expect(fixture.calls).toEqual(['lock', 'owner']);
  });

  it.each([
    [{ kind: 'open-ui' }, 'open'],
    [{ kind: 'control', command: { kind: 'status' } }, 'control'],
    [{ kind: 'installer', command: { kind: 'uninstall', purgeData: false } }, 'installer'],
  ] as const)('routes %s without constructing product services', async (intent, expected) => {
    const fixture = platform();

    expect(await bootstrapCatbots(intent as ProcessIntent, fixture.platform)).toBe(0);
    expect(fixture.calls).toEqual([expected]);
    expect(fixture.platform.createApplicationOwner).not.toHaveBeenCalled();
  });

  it('allows only one concurrent service launch to construct an owner', async () => {
    let available = true;
    const fixture = platform();
    fixture.platform.requestSingleInstanceLock = vi.fn(() => {
      fixture.calls.push('lock');
      if (!available) return false;
      available = false;
      return true;
    });

    expect(await Promise.all([
      bootstrapCatbots({ kind: 'serve-web', port: 5180, window: 'never' }, fixture.platform),
      bootstrapCatbots({ kind: 'serve-web', port: 5180, window: 'never' }, fixture.platform),
    ])).toEqual([0, 0]);
    expect(fixture.platform.createApplicationOwner).toHaveBeenCalledOnce();
  });

  it('keeps client entry points free of product repository imports', async () => {
    const root = fileURLToPath(new URL('../src/main/application/', import.meta.url));
    const sources = await Promise.all([
      readFile(`${root}process-intent.ts`, 'utf8'),
      readFile(`${root}bootstrap.ts`, 'utf8'),
    ]);

    for (const source of sources) {
      expect(source).not.toMatch(/from ['"]\.\.\/(bots|config|connections|execution|storage|workbench)\//);
    }
  });
});
