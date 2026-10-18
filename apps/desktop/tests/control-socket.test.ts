import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createControlClient } from '../src/main/control/socket-client';
import { startControlSocket } from '../src/main/control/socket-server';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((close) => close())));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-control-'));
  const socketPath = join(directory, 'control.sock');
  const server = await startControlSocket({
    socketPath,
    instanceId: 'instance-1',
    handle: async (command) => ({ kind: 'ok', command: command.kind }),
  });
  cleanup.push(async () => { await server.close(); await rm(directory, { force: true, recursive: true }); });
  return { directory, socketPath };
}

describe('local control socket', () => {
  it('uses a private directory and isolates concurrent requests', async () => {
    const { directory, socketPath } = await fixture();
    const client = createControlClient({ socketPath, expectedInstanceId: 'instance-1' });

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(Promise.all([client.execute({ kind: 'status' }), client.execute({ kind: 'mint-browser-ticket' })]))
      .resolves.toEqual([{ kind: 'ok', command: 'status' }, { kind: 'ok', command: 'mint-browser-ticket' }]);
  });

  it('rejects stale identity and unsupported protocol versions', async () => {
    const { socketPath } = await fixture();
    await expect(createControlClient({ socketPath, expectedInstanceId: 'stale' }).execute({ kind: 'status' }))
      .rejects.toThrow('CONTROL_INSTANCE_MISMATCH');
    await expect(createControlClient({ socketPath, expectedInstanceId: 'instance-1', protocolVersion: 2 }).execute({ kind: 'status' }))
      .rejects.toThrow('CONTROL_PROTOCOL_MISMATCH');
  });

  it('rejects an oversized frame and removes the socket on close', async () => {
    const { socketPath } = await fixture();
    const client = createControlClient({ socketPath, expectedInstanceId: 'instance-1', maximumFrameBytes: 32 });
    await expect(client.execute({ kind: 'shutdown', leaseId: 'x'.repeat(100) })).rejects.toThrow('CONTROL_FRAME_TOO_LARGE');
    await cleanup[0]();
    cleanup.length = 0;
    await expect(stat(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
