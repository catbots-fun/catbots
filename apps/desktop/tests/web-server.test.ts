import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStaticAssetCatalog } from '../src/main/web/static-assets';
import { startWebServer } from '../src/main/web/http-server';
import type { ServiceIdentity } from '../src/main/web/service-identity';

const identity: ServiceIdentity = {
  product: 'catbots',
  bundleId: 'com.catbots.desktop',
  releaseId: '0.2.0+abc123',
  version: '0.2.0',
  commit: 'abc123',
  architecture: 'arm64',
  protocolVersion: 1,
  dataSchemaVersion: 6,
  instanceId: 'instance-123',
  readiness: 'ready',
  resumePolicy: 'manual-only',
};

const closeTasks: Array<() => Promise<void>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(closeTasks.splice(0).map((close) => close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'catbots-static-assets-'));
  temporaryDirectories.push(parent);
  const root = join(parent, 'renderer');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'web.html'), '<!doctype html><title>Catbots</title>');
  await writeFile(join(root, 'assets', 'web-main-CATBOTS.js'), 'export const app = true;');
  await writeFile(join(parent, 'outside.txt'), 'provider-secret');
  await symlink(join(parent, 'outside.txt'), join(root, 'assets', 'escape.txt'));
  const catalog = await createStaticAssetCatalog(root);
  const server = await startWebServer({
    port: 0,
    identity: () => identity,
    invoke: vi.fn(),
    subscribe: () => () => undefined,
    asset: (path) => catalog.resolve(path),
  });
  closeTasks.push(server.close);
  return server;
}

describe('production web server', () => {
  it('returns the exact service identity without requiring a browser session', async () => {
    const server = await fixture();

    const response = await fetch(`${server.origin}/api/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(identity);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves web.html and emitted assets with strict response headers', async () => {
    const server = await fixture();

    const root = await fetch(server.origin);
    const asset = await fetch(`${server.origin}/assets/web-main-CATBOTS.js`);

    expect(await root.text()).toContain('<title>Catbots</title>');
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(root.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await asset.text()).toContain('app = true');
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('rejects traversal, symlink escape, and unsupported static methods', async () => {
    const server = await fixture();

    expect((await fetch(`${server.origin}/%2e%2e/outside.txt`)).status).toBe(404);
    expect((await fetch(`${server.origin}/assets/escape.txt`)).status).toBe(404);
    const post = await fetch(server.origin, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});
