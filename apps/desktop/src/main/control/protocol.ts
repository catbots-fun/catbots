import type { ControlCommand } from '../application/process-intent';

export const controlProtocolVersion = 1;
export const defaultMaximumControlFrameBytes = 64 * 1024;

export type ControlRequest = Readonly<{
  protocolVersion: number;
  requestId: string;
  command: ControlCommand;
}>;

export type ControlResponse = Readonly<{
  protocolVersion: number;
  requestId: string;
  instanceId: string;
  result?: unknown;
  error?: string;
}>;
