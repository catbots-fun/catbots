import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const installer = resolve(import.meta.dirname, '../../../scripts/install.sh');

describe('public install script source trust boundary', () => {
  it('refuses source trust sentinels before attempting network access', async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolveRun) => {
      const child = spawn('/bin/sh', [installer], { env: { ...process.env } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolveRun({ code, stderr }));
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('release trust roots were not injected at build time');
    expect(result.stderr).not.toContain('curl:');
  });
});
