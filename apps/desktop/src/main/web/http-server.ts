import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrowserTicketStore } from '../control/browser-tickets';
import type { ServiceIdentity } from './service-identity';

export type WebTransportOptions = {
  port: number;
  identity?: () => ServiceIdentity;
  browserTickets?: Pick<BrowserTicketStore, 'consume'>;
  invoke(method: string, input: unknown): Promise<unknown>;
  subscribe(send: (event: string, data: unknown) => void): () => void;
  asset(path: string): Promise<{ body: Uint8Array; contentType: string }>;
};

export async function startWebServer(options: WebTransportOptions) {
  let authority = `127.0.0.1:${options.port}`;
  let origin = `http://${authority}`;
  const token = randomBytes(32).toString('hex');
  const streams = new Set<ServerResponse>();
  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const hasSession = (request: IncomingMessage) => {
    const value = request.headers.cookie?.split('; ').find((part) => part.startsWith('catbots_session='))?.slice(16) ?? '';
    return value.length === token.length && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const site = request.headers['sec-fetch-site'];
    if (request.headers.host !== authority || (site !== undefined && site !== 'same-origin' && site !== 'none')
      || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      json(response, 403, { error: 'WEB_ORIGIN_DENIED' }); return;
    }
    const path = request.url ?? '/';
    const requestUrl = new URL(path, origin);
    if (path === '/api/health') {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        json(response, 405, { error: 'METHOD_NOT_ALLOWED' });
        return;
      }
      if (options.identity === undefined) {
        json(response, 404, { error: 'HEALTH_UNAVAILABLE' });
        return;
      }
      json(response, 200, options.identity());
      return;
    }
    if (requestUrl.pathname === '/api/session' && request.method === 'GET') {
      const authorized = options.browserTickets === undefined
        ? request.headers['x-catbots-client'] === '1'
        : options.browserTickets.consume(requestUrl.searchParams.get('ticket') ?? '');
      if (!authorized) {
        json(response, 401, { error: 'WEB_TICKET_REQUIRED' });
        return;
      }
      response.setHeader('Set-Cookie', `catbots_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      json(response, 200, { ready: true }); return;
    }
    if (path.startsWith('/api/')) {
      if (!hasSession(request)) { json(response, 401, { error: 'WEB_SESSION_REQUIRED' }); return; }
      if (path === '/api/events' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        response.write(': connected\n\n');
        streams.add(response);
        const unsubscribe = options.subscribe((event, data) => {
          if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        });
        const heartbeat = setInterval(() => { response.write(': heartbeat\n\n'); }, 15000);
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
        return;
      }
      if (path !== '/api/rpc' || request.method !== 'POST' || request.headers.origin !== origin
        || request.headers['x-catbots-client'] !== '1' || request.headers['content-type'] !== 'application/json') {
        json(response, 403, { error: 'WEB_REQUEST_DENIED' }); return;
      }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 1024 * 1024) { json(response, 413, { error: 'REQUEST_TOO_LARGE' }); return; }
          chunks.push(Buffer.from(chunk));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof payload?.method !== 'string') throw new Error('INVALID_REQUEST');
        const result = await options.invoke(payload.method, payload.input);
        json(response, 200, { result: result ?? null });
      } catch (error) {
        // Only deliberate API codes leave the backend. Never serialize provider errors or keys.
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'WEB_REQUEST_FAILED';
        json(response, 400, { error: code });
      }
      return;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      response.writeHead(405); response.end(); return;
    }
    if (!path.startsWith('/') || path.startsWith('//')) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const asset = await options.asset(path === '/' ? '/web.html' : path);
      response.writeHead(200, { 'content-type': asset.contentType }); response.end(asset.body);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address && typeof address === 'object') { authority = `127.0.0.1:${address.port}`; origin = `http://${authority}`; }
  return {
    origin,
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
