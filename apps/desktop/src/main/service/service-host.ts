import { BrowserTicketStore } from '../control/browser-tickets';
import {
  createOwnerControlHandler,
  type OwnerControlDependencies,
} from '../control/owner-control';
import { startControlSocket } from '../control/socket-server';
import { startWebServer, type WebTransportOptions } from '../web/http-server';
import type { ServiceIdentity } from '../web/service-identity';

type ServiceHostOptions = Readonly<{
  port: number;
  socketPath: string;
  identity(): ServiceIdentity;
  invoke: WebTransportOptions['invoke'];
  subscribe: WebTransportOptions['subscribe'];
  asset: WebTransportOptions['asset'];
  maintenance: OwnerControlDependencies['maintenance'];
  shutdown: OwnerControlDependencies['shutdown'];
}>;

export async function startServiceHost(options: ServiceHostOptions) {
  const browserTickets = new BrowserTicketStore();
  const web = await startWebServer({
    port: options.port,
    identity: options.identity,
    browserTickets,
    invoke: options.invoke,
    subscribe: options.subscribe,
    asset: options.asset,
  });
  try {
    const control = await startControlSocket({
      socketPath: options.socketPath,
      instanceId: options.identity().instanceId,
      handle: createOwnerControlHandler({
        identity: options.identity,
        browserTickets,
        maintenance: options.maintenance,
        shutdown: options.shutdown,
      }),
    });
    return {
      origin: web.origin,
      close: async () => {
        await control.close();
        await web.close();
      },
    };
  } catch (error) {
    await web.close();
    throw error;
  }
}
