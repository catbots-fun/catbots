import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import {
  controlProtocolVersion,
  defaultMaximumControlFrameBytes,
  type ControlRequest,
  type ControlResponse,
} from './protocol';
import type { ControlCommand } from '../application/process-intent';

export async function startControlSocket(options: Readonly<{
  socketPath: string;
  instanceId: string;
  maximumFrameBytes?: number;
  handle(command: ControlCommand): Promise<unknown>;
}>) {
  const maximum = options.maximumFrameBytes ?? defaultMaximumControlFrameBytes;
  const parent = dirname(options.socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const metadata = await lstat(parent);
  if (metadata.uid !== process.getuid?.()) throw new Error('CONTROL_DIRECTORY_OWNER_MISMATCH');
  await rm(options.socketPath, { force: true });

  const server = createServer((socket) => {
    let body = Buffer.alloc(0);
    socket.on('data', async (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.byteLength > maximum) {
        socket.destroy(new Error('CONTROL_FRAME_TOO_LARGE'));
        return;
      }
      const newline = body.indexOf(10);
      if (newline < 0) return;
      const request = parseRequest(body.subarray(0, newline));
      const response: ControlResponse = request.protocolVersion !== controlProtocolVersion
        ? responseFor(request, options.instanceId, undefined, 'CONTROL_PROTOCOL_MISMATCH')
        : responseFor(request, options.instanceId, await options.handle(request.command));
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, resolve);
  });
  await chmod(options.socketPath, 0o600);
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}

function parseRequest(value: Uint8Array): ControlRequest {
  const request = JSON.parse(Buffer.from(value).toString('utf8')) as ControlRequest;
  if (!request || typeof request.requestId !== 'string' || !request.command || typeof request.command.kind !== 'string') {
    throw new Error('CONTROL_REQUEST_INVALID');
  }
  return request;
}

function responseFor(
  request: ControlRequest,
  instanceId: string,
  result?: unknown,
  error?: string,
): ControlResponse {
  return { protocolVersion: controlProtocolVersion, requestId: request.requestId, instanceId, result, error };
}
