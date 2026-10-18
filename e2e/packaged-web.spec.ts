import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createControlClient } from '../apps/desktop/src/main/control/socket-client';
import type { ServiceIdentity } from '../apps/desktop/src/main/web/service-identity';

const origin = 'http://127.0.0.1:5180';

type RunningService = Readonly<{
  child: ChildProcess;
  dataDirectory: string;
  identity: ServiceIdentity;
  logs: string[];
}>;

type FakeProvider = Readonly<{
  baseUrl: string;
  requests: Array<{ authorization?: string; body?: unknown; path?: string }>;
  server: Server;
}>;

const ethRsiStrategy = {
  schemaVersion: '2.0',
  strategy: { id: 'eth-rsi', name: 'ETH RSI', version: 1 },
  marketScope: { type: 'dex_universe' },
  nodes: [
    { id: 'entry-clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '15m', alignment: 'utc' } },
    { id: 'entry-symbol', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
    { id: 'entry-rsi', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'lt', right: { literal: 20 } } },
    { id: 'entry-all', kind: 'condition', type: 'combine.all', version: 1, config: {} },
    { id: 'entry-long', kind: 'action', type: 'execution.open_position', version: 1, config: { side: 'long', size: { type: 'quote', value: 1000 } } },
    { id: 'exit-clock', kind: 'trigger', type: 'trigger.interval', version: 1, config: { every: '15m', alignment: 'utc' } },
    { id: 'exit-symbol', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'market.symbol' }, operator: 'eq', right: { literal: 'ETH-PERP' } } },
    { id: 'exit-rsi', kind: 'condition', type: 'predicate.compare', version: 1, config: { left: { ref: 'indicator.rsi.14', field: 'value' }, operator: 'gt', right: { literal: 80 } } },
    { id: 'exit-long', kind: 'condition', type: 'predicate.position_state', version: 2, config: { state: 'long' } },
    { id: 'exit-all', kind: 'condition', type: 'combine.all', version: 1, config: {} },
    { id: 'exit-close', kind: 'action', type: 'execution.close_position', version: 1, config: { side: 'long', percent: 100 } },
  ],
  edges: [
    { id: 'e1', source: 'entry-clock', sourcePort: 'activation', target: 'entry-symbol', targetPort: 'activation' },
    { id: 'e2', source: 'entry-clock', sourcePort: 'activation', target: 'entry-rsi', targetPort: 'activation' },
    { id: 'e3', source: 'entry-symbol', sourcePort: 'result', target: 'entry-all', targetPort: 'conditions' },
    { id: 'e4', source: 'entry-rsi', sourcePort: 'result', target: 'entry-all', targetPort: 'conditions' },
    { id: 'e5', source: 'entry-all', sourcePort: 'result', target: 'entry-long', targetPort: 'condition' },
    { id: 'e6', source: 'exit-clock', sourcePort: 'activation', target: 'exit-symbol', targetPort: 'activation' },
    { id: 'e7', source: 'exit-clock', sourcePort: 'activation', target: 'exit-rsi', targetPort: 'activation' },
    { id: 'e8', source: 'exit-clock', sourcePort: 'activation', target: 'exit-long', targetPort: 'activation' },
    { id: 'e9', source: 'exit-symbol', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
    { id: 'e10', source: 'exit-rsi', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
    { id: 'e11', source: 'exit-long', sourcePort: 'result', target: 'exit-all', targetPort: 'conditions' },
    { id: 'e12', source: 'exit-all', sourcePort: 'result', target: 'exit-close', targetPort: 'condition' },
  ],
};

async function packagedExecutable(): Promise<string> {
  const executable = join(
    resolve('apps/desktop/out'),
    `Catbots-darwin-${process.arch}`,
    'Catbots.app',
    'Contents',
    'MacOS',
    'Catbots',
  );
  await access(executable);
  return executable;
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

async function readIdentity(): Promise<ServiceIdentity | undefined> {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() as ServiceIdentity : undefined;
  } catch {
    return undefined;
  }
}

async function startService(dataDirectory: string): Promise<RunningService> {
  const child = spawn(await packagedExecutable(), ['--serve-web'], {
    env: {
      ...process.env,
      CATBOTS_E2E_DATA_DIR: dataDirectory,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  let identity: ServiceIdentity | undefined;
  try {
    await expect.poll(async () => {
      identity = await readIdentity();
      return identity?.readiness;
    }, { timeout: 20_000, message: 'packaged service becomes ready' }).toBe('ready');
  } catch (error) {
    if (!await waitForExit(child, 0)) child.kill('SIGKILL');
    await waitForExit(child);
    throw error;
  }
  return { child, dataDirectory, identity: identity!, logs };
}

function controlFor(service: RunningService) {
  return createControlClient({
    socketPath: join(service.dataDirectory, 'control', 'catbots.sock'),
    expectedInstanceId: service.identity.instanceId,
  });
}

async function openAuthenticatedPage(service: RunningService, page: Page) {
  const result = await controlFor(service).execute({ kind: 'mint-browser-ticket' }) as { ticket: string };
  await page.goto(`${origin}/api/session?ticket=${encodeURIComponent(result.ticket)}`);
  await expect(page).toHaveURL(`${origin}/`);
}

async function stopService(service: RunningService): Promise<void> {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return;
  const operationId = randomUUID();
  const control = controlFor(service);
  await control.execute({ kind: 'prepare-maintenance', reason: 'stop', operationId });
  await control.execute({ kind: 'shutdown', leaseId: operationId });
  if (!await waitForExit(service.child)) {
    service.child.kill('SIGKILL');
    if (!await waitForExit(service.child)) throw new Error('Packaged service did not stop');
  }
}

async function startFakeProvider(secret: string): Promise<FakeProvider> {
  const requests: FakeProvider['requests'] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText.length === 0 ? undefined : JSON.parse(bodyText) as unknown;
      requests.push({ authorization: request.headers.authorization, body, path: request.url });
      if (requests.length === 1) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = requests.length === 2
        ? { tool_calls: [{ index: 0, id: 'eth-rsi', type: 'function', function: { name: 'validate_strategy', arguments: JSON.stringify({ strategy: ethRsiStrategy }) } }] }
        : { content: 'Draft v1 is valid and ready to backtest.' };
      const finishReason = requests.length === 2 ? 'tool_calls' : 'stop';
      response.end([
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fake provider did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, server };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
}

test('packaged background service completes Strategy Lab and persists it across a clean restart', async ({ page }) => {
  test.setTimeout(120_000);
  const dataDirectory = await mkdtemp(join(await realpath(tmpdir()), 'catbots-e2e-'));
  const secret = 'packaged-web-provider-secret';
  const provider = await startFakeProvider(secret);
  const allLogs: string[][] = [];
  let service: RunningService | undefined;
  try {
    service = await startService(dataDirectory);
    allLogs.push(service.logs);
    await openAuthenticatedPage(service, page);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain('localhost');
    expect(csp).not.toContain('127.0.0.1');
    await expect(page.getByRole('heading', { name: 'Connect your AI provider' })).toBeVisible();

    await page.getByLabel('Profile name').fill('Packaged Web Trader');
    await page.getByLabel('Base URL').fill(provider.baseUrl);
    await page.getByLabel('API key').fill(secret);
    await page.getByLabel('Model').fill('e2e-fixture-model');
    await page.getByRole('button', { name: 'Connect & continue' }).click();
    await expect(page.getByRole('heading', { name: 'Bots', exact: true })).toBeVisible();
    expect(provider.requests).toMatchObject([{
      authorization: `Bearer ${secret}`,
      path: '/v1/chat/completions',
    }]);

    await page.getByRole('button', { name: 'Create new bot' }).first().click();
    await page.getByLabel('Bot name').fill('Persistent Strategy Lab Bot');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page.getByRole('heading', { name: 'Persistent Strategy Lab Bot' })).toBeVisible();

    await page.getByLabel('Message Catbots AI').fill('For ETH, open a long below RSI 20 and close that long above RSI 80.');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Draft v1 is valid', { exact: false })).toBeVisible();
    await expect(page.locator('[aria-label^="trigger: Interval"]')).toHaveCount(2);
    await expect(page.getByText('ETH-PERP', { exact: false }).first()).toBeVisible();

    await page.getByRole('tab', { name: 'Backtest' }).click();
    await page.getByRole('button', { name: 'Run backtest' }).click();
    await page.getByRole('button', { name: 'Use dataset date range' }).click();
    await page.getByRole('button', { name: 'Run backtest' }).click();
    await expect(page.getByRole('heading', { name: 'By market' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Backtest results by market' }).getByRole('row', { name: /ETH-PERP/ })).toBeVisible();

    await page.getByRole('button', { name: 'Approve v1' }).click();
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await expect(page.locator('.workbench-header').getByText('Approved', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run Paper' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review Live' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Deploy' })).toHaveCount(0);

    await stopService(service);
    service = undefined;
    await page.context().clearCookies();

    service = await startService(dataDirectory);
    allLogs.push(service.logs);
    await openAuthenticatedPage(service, page);
    await expect(page.getByText('Persistent Strategy Lab Bot')).toBeVisible();
    await page.getByText('Persistent Strategy Lab Bot').click();
    await expect(page.locator('.workbench-header').getByText('Approved', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Backtest' }).click();
    await expect(page.getByRole('table', { name: 'Backtest results by market' }).getByRole('row', { name: /ETH-PERP/ })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByLabel('Profile name')).toHaveValue('Packaged Web Trader');
    await page.getByRole('button', { name: 'Show compatible API' }).click();
    await expect(page.getByLabel('API key')).toHaveValue('');
    await expect(page.getByText('Stored key: ••••••••')).toBeVisible();
  } finally {
    if (service !== undefined) await stopService(service).catch(() => service?.child.kill('SIGKILL'));
    await closeServer(provider.server);
    await rm(dataDirectory, { recursive: true, force: true });
    expect(allLogs.flat().join('')).not.toContain(secret);
  }
});
