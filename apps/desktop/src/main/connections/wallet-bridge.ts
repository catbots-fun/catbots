import { startWebServer, type WebTransportOptions } from '../web/http-server';

/** A short-lived, connection-scoped signing window; never exposes workspace RPC. */
export async function startWalletBridge(options: {
  challenge: unknown;
  complete(signature: string): Promise<void>;
  asset: WebTransportOptions['asset'];
}) {
  let completed = false;
  let submitting = false;
  const server = await startWebServer({
    port: 0,
    subscribe: () => () => {},
    asset: path => options.asset(path === '/web.html' ? '/wallet.html' : path),
    invoke: async (method, input) => {
      if (method === 'wallet:challenge') return { challenge: options.challenge, completed };
      if (method !== 'wallet:complete' || completed || submitting ||
          typeof input !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(input))
        throw Object.assign(new Error('WALLET_REQUEST_DENIED'), { code: 'WALLET_REQUEST_DENIED' });
      submitting = true;
      try { await options.complete(input); completed = true; return { completed }; }
      finally { submitting = false; }
    },
  });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; clearTimeout(timer); await server.close(); };
  const timer = setTimeout(() => void close(), 10 * 60 * 1000);
  timer.unref();
  return { origin: server.origin, close };
}
