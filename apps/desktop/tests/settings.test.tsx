// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatbotsDesktopApi, ConnectionTestResult, RedactedLocalConfig } from '@catbots/contracts';
import { SettingsScreen } from '../src/renderer/screens/SettingsScreen';

const redactedConfig: RedactedLocalConfig = {
  profile: { name: 'My Trading', telemetry: false },
  llm: {
    provider: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '••••••••',
    model: 'provider/model',
  },
  exchanges: {},
};

function makeApi(): CatbotsDesktopApi['config'] {
  return {
    getBootstrapState: vi.fn().mockResolvedValue({ state: 'ready', config: redactedConfig }),
    patchSettings: vi.fn().mockResolvedValue(redactedConfig),
    testLlmConnection: vi.fn().mockResolvedValue({ ok: true, model: 'provider/model' }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('SettingsScreen', () => {
  afterEach(cleanup);

  it('keeps optional exchange credentials out of the first-launch provider flow', () => {
    render(<SettingsScreen api={makeApi()} onboarding />);

    expect(screen.queryByRole('switch', { name: /Enable Hyperliquid testnet/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect & continue' })).toBeTruthy();
  });

  it('does not resubmit stored exchange settings when the release hides exchange configuration', async () => {
    const user = userEvent.setup();
    const configWithExchange: RedactedLocalConfig = {
      ...redactedConfig,
      exchanges: {
        hyperliquid: {
          network: 'testnet',
          accountAddress: '0x0123456789abcdef0123456789abcdef01234567',
          agentPrivateKey: '••••••••',
        },
      },
    };
    const api = makeApi();
    render(<SettingsScreen api={api} config={configWithExchange} showExchangeSettings={false} />);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(api.testLlmConnection).toHaveBeenCalledWith(expect.not.objectContaining({ exchanges: expect.anything() }));
    expect(api.patchSettings).toHaveBeenCalledWith(expect.not.objectContaining({ exchanges: expect.anything() }));
  });

  it('saves an explicit reasoning effort as part of the tested provider configuration', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    await user.click(await screen.findByRole('option', { name: 'Off' }));
    await user.type(screen.getByLabelText('API key'), 'replacement-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(api.testLlmConnection).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ reasoningEffort: 'none' }),
    }));
    expect(api.patchSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ reasoningEffort: 'none' }),
    }));
  });

  it('shows accessible settings fields and never submits the redacted key mask', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    expect((screen.getByLabelText('Profile name') as HTMLInputElement).value).toBe('My Trading');
    expect(screen.getByLabelText('Provider')).toBeTruthy();
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://api.example.com/v1');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Stored key: ••••••••')).toBeTruthy();

    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'http://api.example.com/v1');
    await user.type(screen.getByLabelText('API key'), 'replacement-secret');
    await user.type(screen.getByLabelText('Model'), '{Enter}');

    expect(await screen.findByText('Use HTTPS, or HTTP only for a provider on this computer.')).toBeTruthy();
    expect(api.testLlmConnection).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it('invalidates a passed connection test when provider values change and accepts keyboard submit through the same path', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'replacement-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Connection successful')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);

    await user.type(screen.getByLabelText('Model'), '-new');
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await user.type(screen.getByLabelText('Model'), '{Enter}');

    expect(await screen.findByText('Settings saved')).toBeTruthy();
    expect(api.patchSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ apiKey: 'replacement-secret', model: 'provider/model-new' }),
    }));
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });

  it('preserves provider approval for profile and telemetry edits but invalidates it for provider edits', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.type(screen.getByLabelText('Profile name'), ' updated');
    expect(save.disabled).toBe(false);
    await user.click(screen.getByRole('switch', { name: /Anonymous telemetry/ }));
    expect(save.disabled).toBe(false);

    await user.type(screen.getByLabelText('Model'), '-provider-change');
    expect(save.disabled).toBe(true);
  });

  it('renders only safe bootstrap repair paths', () => {
    const api = makeApi();
    render(<SettingsScreen
      api={api}
      repairIssues={[
        { path: 'llm.apiKey', message: 'Invalid configuration value' },
        { path: 'llm.api_key', message: 'secret should not render' },
        { path: 'profile.name', message: 'Invalid configuration value' },
      ]}
    />);

    expect(screen.getByText('Configuration repair')).toBeTruthy();
    expect(screen.getByText('llm.apiKey')).toBeTruthy();
    expect(screen.getByText('profile.name')).toBeTruthy();
    expect(screen.queryByText('llm.api_key')).toBeNull();
    expect(screen.queryByText('secret should not render')).toBeNull();
  });

  it('keeps only the latest successful connection check after values change', async () => {
    const user = userEvent.setup();
    const first = deferred<ConnectionTestResult>();
    const second = deferred<ConnectionTestResult>();
    const testLlmConnection = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const api = { ...makeApi(), testLlmConnection };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(testLlmConnection).toHaveBeenCalledTimes(1);

    await user.type(screen.getByLabelText('Model'), '-second');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await act(async () => second.resolve({ ok: true, model: 'dependency-model-sentinel' }));
    expect(await screen.findByText('Connection successful')).toBeTruthy();
    expect(document.body.textContent).not.toContain('dependency-model-sentinel');

    await act(async () => first.resolve({ ok: true, model: 'stale-dependency-model-sentinel' }));
    expect(document.body.textContent).not.toContain('stale-dependency-model-sentinel');
    expect(testLlmConnection).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears an existing approval while a replacement connection test is pending', async () => {
    const user = userEvent.setup();
    const replacement = deferred<ConnectionTestResult>();
    const api = {
      ...makeApi(),
      testLlmConnection: vi.fn()
        .mockResolvedValueOnce({ ok: true, model: 'ignored-first-model' })
        .mockReturnValueOnce(replacement.promise),
    };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => replacement.resolve({ ok: true, model: 'ignored-second-model' }));
  });

  it('does not render connection dependency messages or mutate after unmount', async () => {
    const user = userEvent.setup();
    const pending = deferred<ConnectionTestResult>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = { ...makeApi(), testLlmConnection: vi.fn().mockReturnValue(pending.promise) };
    const view = render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    view.unmount();
    await act(async () => pending.resolve({ ok: false, code: 'UPSTREAM_SECRET', message: 'dependency-message-sentinel renderer-only-secret' }));

    expect(document.body.textContent).not.toContain('dependency-message-sentinel');
    expect(document.body.textContent).not.toContain('renderer-only-secret');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('guards duplicate saves, blocks edits while saving, and retains the key after a failed save', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<RedactedLocalConfig>();
    const patchSettings = vi.fn().mockReturnValue(pendingSave.promise);
    const api = { ...makeApi(), patchSettings };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'save-retention-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    const form = document.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(patchSettings).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('API key') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'newer-secret' } });
    await act(async () => pendingSave.reject(new Error('save dependency error')));

    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('save-retention-secret');
    expect(screen.getByText('Settings could not be saved. Review the local values and try again.')).toBeTruthy();
  });

  it('does not call onSaved or update the screen after an in-flight save unmounts', async () => {
    const user = userEvent.setup();
    const pendingSave = deferred<RedactedLocalConfig>();
    const onSaved = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = { ...makeApi(), patchSettings: vi.fn().mockReturnValue(pendingSave.promise) };
    const view = render(<SettingsScreen api={api} config={redactedConfig} onSaved={onSaved} />);

    await user.type(screen.getByLabelText('API key'), 'unmount-save-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    fireEvent.submit(document.querySelector('form')!);
    view.unmount();
    await act(async () => pendingSave.resolve(redactedConfig));

    expect(onSaved).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('uses only fixed safe connection failure copy', async () => {
    const user = userEvent.setup();
    const api = {
      ...makeApi(),
      testLlmConnection: vi.fn().mockResolvedValue({
        ok: false,
        code: 'DEPENDENCY_ERROR',
        message: 'dependency-message-sentinel renderer-only-secret',
      }),
    };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('We could not verify this provider. Review the values and try again.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('dependency-message-sentinel');
    expect(document.body.textContent).not.toContain('renderer-only-secret');
  });

  it('maps a Main scope revalidation failure to fixed replacement-key guidance', async () => {
    const user = userEvent.setup();
    const api = {
      ...makeApi(),
      testLlmConnection: vi.fn().mockResolvedValue({
        ok: false,
        code: 'LLM_CREDENTIAL_REPLACEMENT_REQUIRED',
        message: 'dependency-message-sentinel stored-secret-sentinel',
      }),
    };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Enter a new API key for this provider location, then test again.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('dependency-message-sentinel');
    expect(document.body.textContent).not.toContain('stored-secret-sentinel');
  });

  it.each(['SAVE_FAILED', 'TEST_REQUIRED'])('maps hostile external %s codes to generic safe failure copy', async (code) => {
    const user = userEvent.setup();
    const api = {
      ...makeApi(),
      testLlmConnection: vi.fn().mockResolvedValue({
        ok: false,
        code,
        message: 'dependency-message-sentinel renderer-only-secret',
      }),
    };
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('We could not verify this provider. Review the values and try again.')).toBeTruthy();
    expect(screen.queryByText('Settings could not be saved. Review the local values and try again.')).toBeNull();
    expect(screen.queryByText('Test this provider again before saving changed values.')).toBeNull();
    expect(document.body.textContent).not.toContain('dependency-message-sentinel');
    expect(document.body.textContent).not.toContain('renderer-only-secret');
  });

  it('explains that a saved key is never displayed again', () => {
    render(<SettingsScreen api={makeApi()} config={redactedConfig} />);

    expect(screen.getByText('Leave blank to use the stored key. A replacement stays only in this form’s memory until save.')).toBeTruthy();
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  });

  it('tests and saves non-secret settings with the Main-held key without sending its mask', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.type(screen.getByLabelText('Profile name'), ' updated');
    await user.type(screen.getByLabelText('Model'), '-new');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const expectedPatch = {
      profile: { name: 'My Trading updated', telemetry: false },
      llm: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        model: 'provider/model-new',
      },
    };
    expect(api.testLlmConnection).toHaveBeenCalledWith(expectedPatch);
    expect(api.patchSettings).toHaveBeenCalledWith(expectedPatch);
    expect(JSON.stringify(vi.mocked(api.testLlmConnection).mock.calls)).not.toContain('••••••••');
    expect(JSON.stringify(vi.mocked(api.patchSettings).mock.calls)).not.toContain('••••••••');
  });

  it('blocks testing and saving when the base credential scope changes without a new key', async () => {
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://api.example.com/v1/tenant' },
    });

    expect(screen.getByText('The stored key cannot be reused for a different provider location. Enter a new API key to test and save.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector('form')!);
    expect(api.testLlmConnection).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it('blocks testing and saving when the provider credential scope changes without a new key', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    const provider = screen.getByRole('combobox', { name: 'Provider' });
    provider.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Anthropic-compatible' }));
    expect(provider.textContent).toContain('anthropic-compatible');

    expect(screen.getByText('The stored key cannot be reused for a different provider location. Enter a new API key to test and save.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector('form')!);
    expect(api.testLlmConnection).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it('keeps test approval for a canonical-equivalent base URL and reuses the stored key', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'HTTPS://API.EXAMPLE.COM:443/v1/' },
    });

    expect(screen.queryByText('The stored key cannot be reused for a different provider location. Enter a new API key to test and save.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(api.patchSettings).toHaveBeenCalledWith({
      profile: redactedConfig.profile,
      llm: {
        provider: 'openai-compatible',
        baseUrl: 'HTTPS://API.EXAMPLE.COM:443/v1/',
        model: 'provider/model',
      },
    });
  });

  it('binds test approval to whether the credential is stored or newly supplied', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.type(screen.getByLabelText('API key'), 'newly-supplied-secret');
    expect(save.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    expect(save.disabled).toBe(false);

    await user.clear(screen.getByLabelText('API key'));
    expect(save.disabled).toBe(true);
  });

  it('tests and saves a changed credential scope only after receiving a new key', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://replacement.example/v2' },
    });
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('API key'), 'replacement-scope-secret');
    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connection successful');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const expectedPatch = {
      profile: redactedConfig.profile,
      llm: {
        provider: 'openai-compatible' as const,
        baseUrl: 'https://replacement.example/v2',
        apiKey: 'replacement-scope-secret',
        model: 'provider/model',
      },
    };
    expect(api.testLlmConnection).toHaveBeenCalledWith(expectedPatch);
    expect(api.patchSettings).toHaveBeenCalledWith(expectedPatch);
  });

  it('never enables a connection test for the redacted display mask', () => {
    const api = makeApi();
    render(<SettingsScreen api={api} config={redactedConfig} />);

    fireEvent.change(screen.getByLabelText('API key'), { target: { value: '••••••••' } });

    expect((screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(document.querySelector('form')!);
    expect(api.testLlmConnection).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
  });

  it('always renders a fixed repair banner but exposes only safe field paths', () => {
    const api = makeApi();
    const { rerender } = render(<SettingsScreen api={api} repairIssues={[{ path: 'config', message: 'syntax-secret-sentinel' }]} />);

    expect(screen.getByText('Configuration repair')).toBeTruthy();
    expect(screen.getByText('Re-enter the local profile and provider values to repair this configuration.')).toBeTruthy();
    expect(screen.queryByText('config')).toBeNull();
    expect(screen.queryByText('syntax-secret-sentinel')).toBeNull();

    rerender(<SettingsScreen api={api} repairIssues={[{ path: 'syntax', message: 'another-secret-sentinel' }]} />);
    expect(screen.getByText('Configuration repair')).toBeTruthy();
    expect(screen.queryByText('syntax')).toBeNull();
    expect(screen.queryByText('another-secret-sentinel')).toBeNull();
  });

  it('associates field errors and accepts loopback HTTP providers', async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const { unmount } = render(<SettingsScreen api={api} config={redactedConfig} />);

    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'http://example.com/v1');
    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.type(screen.getByLabelText('Model'), '{Enter}');
    const invalidUrl = screen.getByLabelText('Base URL');
    const describedBy = invalidUrl.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(invalidUrl.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy.some((id) => document.getElementById(id)?.textContent?.includes('Use HTTPS, or HTTP only for a provider on this computer.'))).toBe(true);
    unmount();

    render(<SettingsScreen api={api} config={redactedConfig} />);
    await user.clear(screen.getByLabelText('Base URL'));
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:11434/v1');
    await user.type(screen.getByLabelText('API key'), 'renderer-only-secret');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(api.testLlmConnection).toHaveBeenLastCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ baseUrl: 'http://localhost:11434/v1' }),
    }));
  });
});
