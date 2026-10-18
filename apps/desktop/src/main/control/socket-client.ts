import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { ControlCommand } from '../application/process-intent';
import {
  controlProtocolVersion,
  defaultMaximumControlFrameBytes,
  type ControlRequest,
  type ControlResponse,
} from './protocol';

export function createControlClient(options: Readonly<{
  socketPath: string;
  expectedInstanceId: string;
  protocolVersion?: number;
  maximumFrameBytes?: number;
}>) {
  const protocolVersion = options.protocolVersion ?? controlProtocolVersion;
  const maximum = options.maximumFrameBytes ?? defaultMaximumControlFrameBytes;
  return {
    execute: async (command: ControlCommand): Promise<unknown> => {
      const request: ControlRequest = { protocolVersion, requestId: randomUUID(), command };
      const frame = Buffer.from(`${JSON.stringify(request)}\n`);
      if (frame.byteLength > maximum) throw new Error('CONTROL_FRAME_TOO_LARGE');
      const response = await exchange(options.socketPath, frame, maximum);
      if (response.protocolVersion !== controlProtocolVersion) throw new Error('CONTROL_PROTOCOL_MISMATCH');
      if (response.instanceId !== options.expectedInstanceId) throw new Error('CONTROL_INSTANCE_MISMATCH');
      if (response.requestId !== request.requestId) throw new Error('CONTROL_REQUEST_MISMATCH');
      if (response.error) throw new Error(response.error);
      return response.result;
    },
  };
}

function exchange(socketPath: string, frame: Uint8Array, maximum: number): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let body = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.byteLength > maximum) socket.destroy(new Error('CONTROL_FRAME_TOO_LARGE'));
    });
    socket.once('connect', () => socket.write(frame));
    socket.once('end', () => {
      try {
        resolve(JSON.parse(body.toString('utf8')) as ControlResponse);
      } catch {
        reject(new Error('CONTROL_RESPONSE_INVALID'));
      }
    });
  });
}
