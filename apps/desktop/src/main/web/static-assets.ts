import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

export type StaticAsset = Readonly<{
  body: Uint8Array;
  contentType: string;
}>;

export type StaticAssetCatalog = Readonly<{
  resolve(requestPath: string): Promise<StaticAsset>;
}>;

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export async function createStaticAssetCatalog(root: string): Promise<StaticAssetCatalog> {
  const canonicalRoot = await realpath(root);
  return {
    async resolve(requestPath) {
      const path = decodeRequestPath(requestPath);
      const requestedFile = path === '/' ? 'web.html' : path.slice(1);
      const candidate = resolve(canonicalRoot, requestedFile);
      if (!isInside(canonicalRoot, candidate)) throw new Error('ASSET_PATH_DENIED');

      const canonicalFile = await realpath(candidate);
      if (!isInside(canonicalRoot, canonicalFile)) throw new Error('ASSET_PATH_DENIED');
      const metadata = await stat(canonicalFile);
      if (!metadata.isFile()) throw new Error('ASSET_NOT_FOUND');

      return {
        body: await readFile(canonicalFile),
        contentType: contentTypes[extname(canonicalFile).toLowerCase()] ?? 'application/octet-stream',
      };
    },
  };
}

function decodeRequestPath(requestPath: string): string {
  const rawPath = requestPath.split(/[?#]/, 1)[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new Error('ASSET_PATH_DENIED');
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error('ASSET_PATH_DENIED');
  }
  const segments = decoded.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error('ASSET_PATH_DENIED');
  return decoded;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}
