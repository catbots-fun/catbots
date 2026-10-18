import { describe, expect, it } from 'vitest';
import mainConfig from '../vite.main.config';

describe('main process build', () => {
  it('emits the package main entry at .vite/build/main.js', () => {
    const config = mainConfig as {
      build?: {
        rollupOptions?: {
          output?: { entryFileNames?: string };
        };
      };
    };

    expect(config.build?.rollupOptions?.output?.entryFileNames).toBe('main.js');
  });
});
