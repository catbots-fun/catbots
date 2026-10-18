// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../src/renderer/App';
import { NodeValue } from '../src/renderer/workbench/NodeValue';
import type { CatbotsDesktopApi } from '@catbots/contracts';
vi.mock('../src/renderer/screens/FirstLaunchScreen', () => ({ FirstLaunchScreen: () => <p>Setup reached</p> }));
afterEach(cleanup);
it('offers retry for transport failure without diagnosing database corruption', async () => {
  const getDatabaseState = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ status: 'ready' });
  const api = {
    app: {
      getCapabilities: vi.fn().mockResolvedValue({
        release: 'strategy-lab-beta',
        strategyResearch: true,
        paperExecution: false,
        liveExecution: false,
        exchangeConnections: false,
      }),
    },
    runtime: { getDatabaseState },
    config: { getBootstrapState: vi.fn().mockResolvedValue({ state: 'first-launch' }) },
  } as unknown as CatbotsDesktopApi;
  render(<App api={api} />);
  await screen.findByText('Cannot reach local workspace');
  expect(screen.queryByText('Local database needs repair')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
  await screen.findByText('Setup reached');
  expect(getDatabaseState).toHaveBeenCalledTimes(2);
});
it('summarizes large data while preserving access to the full JSON', async () => {
  const value = Array.from({ length: 200 }, (_, i) => ({ close: i }));
  render(<NodeValue value={value} />);
  expect(screen.getByText('200 records · latest 5 shown')).toBeTruthy();
  expect(screen.getAllByRole('row')).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: 'Show JSON' }));
  await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('"close": 0'));
});
