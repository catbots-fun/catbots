import { describe, expect, it } from 'vitest';
import rendererConfig from '../vite.renderer.config';

describe('production renderer build', () => {
  it('builds the native, wallet, and browser entry points', () => {
    const factory = rendererConfig as (environment: Readonly<{
      command: 'build';
      mode: string;
      isSsrBuild: boolean;
      isPreview: boolean;
    }>) => {
      base?: string;
      build?: { rollupOptions?: { input?: Record<string, string> } };
    };
    const config = factory({
      command: 'build',
      mode: 'production',
      isSsrBuild: false,
      isPreview: false,
    });

    expect(config.base).toBe('./');
    expect(Object.keys(config.build?.rollupOptions?.input ?? {}).sort()).toEqual([
      'main',
      'wallet',
      'web',
    ]);
    expect(config.build?.rollupOptions?.input?.web).toMatch(/src\/renderer\/web\.html$/);
  });
});
