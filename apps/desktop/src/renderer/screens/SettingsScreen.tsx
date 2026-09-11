import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { BrandWordmark } from '../components/BrandLogo';
import { BrandIllustration } from '../components/BrandIllustration';
import { Banner, Button, Dialog, Input, LayerCard, Select, Switch, Tooltip } from '@cloudflare/kumo';
import { InfoIcon } from '@phosphor-icons/react';
import {
  CompatibleProviderUrlSchema,
  hasSameLlmCredentialScope,
  normalizeLlmProviderBaseUrl,
  REDACTED_SECRET,
  type CatbotsDesktopApi,
  type LocalConfig,
  type LocalSettingsPatch,
  type OpenAiReasoningEffort,
  type RedactedLocalConfig,
} from '@catbots/contracts';
import { ConnectionTestStatus, mapExternalConnectionErrorCode, type ConnectionTestState } from '../components/ConnectionTestStatus';
import { SecretField } from '../components/SecretField';

type Provider = LocalConfig['llm']['provider'];
type ReasoningEffortSetting = 'auto' | OpenAiReasoningEffort;
type SettingsScreenProps = { connections?: ReactNode; api: CatbotsDesktopApi['config']; config?: RedactedLocalConfig; repairIssues?: ReadonlyArray<{ path: string; message: string }>; onboarding?: boolean; embedded?: boolean; onSaved?(config: RedactedLocalConfig): void };
type FormState = {
  profileName: string; telemetry: boolean; provider: Provider; baseUrl: string; apiKey: string;
  model: string; reasoningEffort: ReasoningEffortSetting;
  hyperliquidEnabled: boolean; hyperliquidAccount: string; hyperliquidAgentKey: string;
};
type FormErrors = Partial<Record<keyof FormState, string>>;

const SAFE_REPAIR_PATHS = new Set(['profile.name', 'profile.telemetry', 'llm.provider', 'llm.baseUrl', 'llm.apiKey', 'llm.model', 'llm.reasoningEffort']);

function formFromConfig(config?: RedactedLocalConfig): FormState {
  return {
    profileName: config?.profile.name ?? '', telemetry: config?.profile.telemetry ?? false,
    provider: config?.llm.provider ?? 'openai-compatible', baseUrl: config?.llm.baseUrl ?? '', apiKey: '',
    model: config?.llm.model ?? '', reasoningEffort: config?.llm.provider === 'openai-compatible' ? config.llm.reasoningEffort ?? 'auto' : 'auto',
    hyperliquidEnabled: config?.exchanges.hyperliquid !== undefined,
    hyperliquidAccount: config?.exchanges.hyperliquid?.accountAddress ?? '', hyperliquidAgentKey: '',
  };
}

function isPermittedProviderUrl(value: string): boolean {
  return CompatibleProviderUrlSchema.safeParse(value).success;
}

function effectiveProviderBaseUrl(state: Pick<FormState, 'provider' | 'baseUrl'>): string {
  const value = state.baseUrl.trim();
  if (state.provider !== 'openai-compatible' || !isPermittedProviderUrl(value)) return value;
  const url = new URL(value);
  if (url.pathname !== '/') return value;
  url.pathname = '/v1';
  return url.toString();
}

function hasChangedStoredCredentialScope(state: FormState, config?: RedactedLocalConfig): boolean {
  if (config === undefined) return false;
  const baseUrl = effectiveProviderBaseUrl(state);
  if (!isPermittedProviderUrl(baseUrl)) return false;
  return !hasSameLlmCredentialScope(config.llm, { provider: state.provider, baseUrl });
}

function connectionApprovalBinding(state: FormState, replacementKeyRevision: number): string | null {
  const baseUrl = effectiveProviderBaseUrl(state);
  if (!isPermittedProviderUrl(baseUrl)) return null;
  return JSON.stringify({
    provider: state.provider,
    baseUrl: normalizeLlmProviderBaseUrl(baseUrl),
    model: state.model.trim(),
    reasoningEffort: state.provider === 'openai-compatible' ? state.reasoningEffort : 'auto',
    credential: state.apiKey.length === 0 ? 'existing' : `replacement:${replacementKeyRevision}`,
  });
}

function validate(state: FormState, requiresApiKey: boolean): FormErrors {
  const errors: FormErrors = {};
  if (state.profileName.trim().length === 0) errors.profileName = 'Enter a local profile name.';
  if (state.profileName.trim().length > 80) errors.profileName = 'Use 80 characters or fewer.';
  if (state.baseUrl.trim().length === 0) errors.baseUrl = 'Enter the provider URL.';
  else if (!isPermittedProviderUrl(state.baseUrl)) errors.baseUrl = 'Use HTTPS, or HTTP only for a provider on this computer.';
  if (requiresApiKey && state.apiKey.length === 0) errors.apiKey = 'Enter the API key to test and save this provider.';
  if (state.apiKey === REDACTED_SECRET) errors.apiKey = 'Enter a real API key, not the stored-key mask.';
  if (state.model.trim().length === 0) errors.model = 'Enter a model identifier.';
  if (state.hyperliquidEnabled) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(state.hyperliquidAccount.trim())) errors.hyperliquidAccount = 'Enter a valid 0x account address.';
    if (state.hyperliquidAgentKey.length === 0 && requiresApiKey) errors.hyperliquidAgentKey = 'Enter the Agent/API Wallet private key.';
    else if (state.hyperliquidAgentKey.length > 0 && !/^0x[0-9a-fA-F]{64}$/.test(state.hyperliquidAgentKey)) errors.hyperliquidAgentKey = 'Enter a 32-byte 0x private key.';
    if (state.hyperliquidAgentKey === REDACTED_SECRET) errors.hyperliquidAgentKey = 'Enter a real key, not the stored-key mask.';
  }
  return errors;
}

function toSettingsPatch(state: FormState, config?: RedactedLocalConfig): LocalSettingsPatch {
  return {
    profile: { name: state.profileName.trim(), telemetry: state.telemetry },
    llm: {
      provider: state.provider,
      baseUrl: effectiveProviderBaseUrl(state),
      model: state.model.trim(),
      ...(state.provider === 'openai-compatible' && state.reasoningEffort !== 'auto'
        ? { reasoningEffort: state.reasoningEffort }
        : {}),
      ...(state.apiKey.length === 0 ? {} : { apiKey: state.apiKey }),
    },
    ...(state.hyperliquidEnabled ? { exchanges: {
      hyperliquid: {
        network: 'testnet',
        accountAddress: state.hyperliquidAccount.trim(),
        ...(state.hyperliquidAgentKey.length === 0 ? {} : { agentPrivateKey: state.hyperliquidAgentKey }),
      },
    } } : config?.exchanges.hyperliquid === undefined ? {} : { exchanges: { hyperliquid: null } }),
  };
}

function getSafeRepairPaths(issues: SettingsScreenProps['repairIssues']): string[] { return [...new Set((issues ?? []).flatMap((issue) => SAFE_REPAIR_PATHS.has(issue.path) ? [issue.path] : []))]; }

export function SettingsScreen({ connections, api, config, repairIssues, onboarding = false, embedded = false, onSaved }: SettingsScreenProps) {
  const [showCompatible, setShowCompatible] = useState(!connections);
  const [form, setForm] = useState<FormState>(() => formFromConfig(config));
  const [errors, setErrors] = useState<FormErrors>({});
  const [connection, setConnection] = useState<ConnectionTestState>({ state: 'idle' });
  const [replacementKeyRevision, setReplacementKeyRevision] = useState(0);
  const [testedConnectionBinding, setTestedConnectionBinding] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const mountedRef = useRef(true);
  const formRevisionRef = useRef(0);
  const providerRevisionRef = useRef(0);
  const replacementKeyRevisionRef = useRef(0);
  const testRequestTokenRef = useRef(0);
  const isTestingRef = useRef(false);
  const saveRequestTokenRef = useRef(0);
  const isSavingRef = useRef(false);
  const safeRepairPaths = useMemo(() => getSafeRepairPaths(repairIssues), [repairIssues]);
  const credentialScopeChanged = hasChangedStoredCredentialScope(form, config);
  const requiresApiKey = config === undefined || credentialScopeChanged;
  const requiresHyperliquidKey = form.hyperliquidEnabled && (
    config?.exchanges.hyperliquid === undefined
    || config.exchanges.hyperliquid.accountAddress.toLowerCase() !== form.hyperliquidAccount.trim().toLowerCase()
  );
  const isRequiredApiKeyMissing = requiresApiKey && form.apiKey.length === 0;
  const currentConnectionBinding = connectionApprovalBinding(form, replacementKeyRevision);
  const hasPassedCurrentTest = testedConnectionBinding !== null
    && testedConnectionBinding === currentConnectionBinding
    && !isRequiredApiKeyMissing
    && form.apiKey !== REDACTED_SECRET;
  const submitLabel = onboarding ? 'Connect & continue' : 'Save settings';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const updateForm = <Key extends keyof FormState>(key: Key, value: FormState[Key]) => {
    if (isSavingRef.current) return;
    setForm((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => ({ ...previous, [key]: undefined }));
    formRevisionRef.current += 1;
    if (key === 'provider' || key === 'baseUrl' || key === 'apiKey' || key === 'model' || key === 'reasoningEffort') {
      const nextProviderRevision = providerRevisionRef.current + 1;
      providerRevisionRef.current = nextProviderRevision;
      if (key === 'apiKey') {
        const nextReplacementKeyRevision = replacementKeyRevisionRef.current + 1;
        replacementKeyRevisionRef.current = nextReplacementKeyRevision;
        setReplacementKeyRevision(nextReplacementKeyRevision);
      }
      testRequestTokenRef.current += 1;
      isTestingRef.current = false;
      setIsTesting(false);
      setConnection({ state: 'idle' });
    }
  };
  const validateForm = (): boolean => {
    const nextErrors = validate(form, requiresApiKey || requiresHyperliquidKey);
    if (!requiresApiKey) delete nextErrors.apiKey;
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };
  const testConnection = async (): Promise<boolean> => {
    if (isTestingRef.current || isSavingRef.current) return false;
    if (!validateForm()) return false;
    const token = testRequestTokenRef.current + 1;
    testRequestTokenRef.current = token;
    const submittedProviderRevision = providerRevisionRef.current;
    const submittedConnectionBinding = connectionApprovalBinding(form, replacementKeyRevisionRef.current);
    if (submittedConnectionBinding === null) return false;
    const submittedPatch = toSettingsPatch(form, config);
    isTestingRef.current = true;
    setTestedConnectionBinding(null);
    setIsTesting(true);
    setConnection({ state: 'testing' });
    try {
      const result = await api.testLlmConnection(submittedPatch);
      if (!mountedRef.current || token !== testRequestTokenRef.current || submittedProviderRevision !== providerRevisionRef.current) return false;
      if (result.ok) { setTestedConnectionBinding(submittedConnectionBinding); setConnection({ state: 'success', model: submittedPatch.llm.model }); return true; }
      setTestedConnectionBinding(null); setConnection({ state: 'error', code: mapExternalConnectionErrorCode(result.code) }); return false;
    } catch {
      if (!mountedRef.current || token !== testRequestTokenRef.current || submittedProviderRevision !== providerRevisionRef.current) return false;
      setTestedConnectionBinding(null); setConnection({ state: 'error', code: 'connection-failed' }); return false;
    } finally {
      if (mountedRef.current && token === testRequestTokenRef.current) setIsTesting(false);
      if (token === testRequestTokenRef.current) isTestingRef.current = false;
    }
  };
  const save = async (): Promise<void> => {
    if (isSavingRef.current) return;
    if (!validateForm()) return;
    if (testedConnectionBinding === null || testedConnectionBinding !== currentConnectionBinding) { setConnection({ state: 'error', code: 'test-required' }); return; }
    const token = saveRequestTokenRef.current + 1;
    saveRequestTokenRef.current = token;
    const submittedRevision = formRevisionRef.current;
    const submittedPatch = toSettingsPatch(form, config);
    isSavingRef.current = true;
    setIsSaving(true);
    try {
      const savedConfig = await api.patchSettings(submittedPatch);
      if (!mountedRef.current || token !== saveRequestTokenRef.current || submittedRevision !== formRevisionRef.current) return;
      setForm((previous) => ({ ...previous, apiKey: '', hyperliquidAgentKey: '' }));
      setTestedConnectionBinding(null);
      setConnection({ state: 'saved' });
      onSaved?.(savedConfig);
    } catch {
      if (mountedRef.current && token === saveRequestTokenRef.current && submittedRevision === formRevisionRef.current) {
        setConnection({ state: 'error', code: 'save-failed' });
      }
    } finally {
      if (token === saveRequestTokenRef.current) isSavingRef.current = false;
      if (mountedRef.current && token === saveRequestTokenRef.current) setIsSaving(false);
    }
  };
  const connectAndSave = async (): Promise<void> => {
    if (isTestingRef.current || isSavingRef.current) return;
    if (!validateForm()) return;
    const testToken = testRequestTokenRef.current + 1;
    testRequestTokenRef.current = testToken;
    const saveToken = saveRequestTokenRef.current + 1;
    saveRequestTokenRef.current = saveToken;
    const submittedRevision = formRevisionRef.current;
    const submittedProviderRevision = providerRevisionRef.current;
    const submittedPatch = toSettingsPatch(form, config);
    isTestingRef.current = true;
    setTestedConnectionBinding(null);
    setIsTesting(true);
    setConnection({ state: 'testing' });
    try {
      const result = await api.testLlmConnection(submittedPatch);
      if (!mountedRef.current || testToken !== testRequestTokenRef.current || submittedProviderRevision !== providerRevisionRef.current) return;
      if (!result.ok) {
        setConnection({ state: 'error', code: mapExternalConnectionErrorCode(result.code) });
        return;
      }

      isTestingRef.current = false;
      setIsTesting(false);
      isSavingRef.current = true;
      setIsSaving(true);
      const savedConfig = await api.patchSettings(submittedPatch);
      if (!mountedRef.current || saveToken !== saveRequestTokenRef.current || submittedRevision !== formRevisionRef.current) return;
      setForm((previous) => ({ ...previous, apiKey: '', hyperliquidAgentKey: '' }));
      setConnection({ state: 'saved' });
      onSaved?.(savedConfig);
    } catch {
      if (mountedRef.current && saveToken === saveRequestTokenRef.current && submittedRevision === formRevisionRef.current) {
        setConnection({ state: 'error', code: isSavingRef.current ? 'save-failed' : 'connection-failed' });
      }
    } finally {
      if (testToken === testRequestTokenRef.current) isTestingRef.current = false;
      if (saveToken === saveRequestTokenRef.current) isSavingRef.current = false;
      if (mountedRef.current && testToken === testRequestTokenRef.current) setIsTesting(false);
      if (mountedRef.current && saveToken === saveRequestTokenRef.current) setIsSaving(false);
    }
  };
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void (onboarding ? connectAndSave() : save()); };
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    void (onboarding ? connectAndSave() : save());
  };

  const Root = embedded ? 'div' : 'main';

  return (
    <Root className={onboarding ? 'setup-shell' : 'settings-shell page-container'}>
      <section className="setup-intro" aria-labelledby="settings-heading">
        <div className="local-mark"><BrandWordmark /></div>
        {onboarding && <div className="setup-brand-art"><BrandIllustration /></div>}
        <h1 id="settings-heading">{onboarding ? 'Connect your AI provider' : 'Settings'}</h1>
        <p className="lead">{onboarding ? 'Name this local workspace and add the AI provider Catbots will use to design and backtest your bots.' : 'Update the local profile and AI provider used by this Catbots installation.'}</p>
        {onboarding && <p className="setup-brand-signoff">Curious by design. Clear by choice.</p>}
      </section>
      {connections}
      <LayerCard render={<section aria-label={onboarding ? 'Local profile setup' : 'Local settings'} />} className="settings-card">
        {repairIssues === undefined ? null : <Banner variant="alert" title="Configuration repair" description={safeRepairPaths.length === 0 ? 'Re-enter the local profile and provider values to repair this configuration.' : <>Review these safe settings fields: {safeRepairPaths.map((path) => <code key={path}>{path}</code>)}</>} />}
        <header className="form-heading"><p className="eyebrow">LOCAL CONFIGURATION</p><h2>{onboarding ? 'Set up Catbots' : 'Profile & execution settings'}</h2><p>{onboarding ? 'Connect once to verify these details, save them locally, and open your bot workspace.' : 'A successful connection test is required before these provider values can be saved.'}</p></header>
        <form className="settings-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown} noValidate>
          <Input size="base" id="profile-name" label="Profile name" value={form.profileName} onChange={(event) => updateForm('profileName', event.currentTarget.value)} variant={errors.profileName === undefined ? 'default' : 'error'} aria-invalid={errors.profileName === undefined ? undefined : true} aria-describedby={errors.profileName === undefined ? undefined : 'profile-name-error'} autoComplete="off" disabled={isSaving} />
          {errors.profileName === undefined ? null : <p id="profile-name-error" role="alert">{errors.profileName}</p>}
          <Switch label="Anonymous telemetry" checked={form.telemetry} onCheckedChange={(value) => updateForm('telemetry', value)} required={false} disabled={isSaving} />
          <h3>Compatible API settings</h3>
          {connections && <><p>Used only when you choose compatible API mode in AI providers above.</p><Button size="sm" type="button" variant="secondary" aria-expanded={showCompatible} onClick={() => setShowCompatible(!showCompatible)}>{showCompatible ? 'Hide compatible API' : 'Show compatible API'}</Button></>}
          <div className="compatible-fields" hidden={!showCompatible}>
          <Select<Provider> size="base" label="Provider" value={form.provider} onValueChange={(value) => updateForm('provider', value as Provider)} error={errors.provider} disabled={isSaving}><Select.Option value="openai-compatible">OpenAI-compatible</Select.Option><Select.Option value="anthropic-compatible">Anthropic-compatible</Select.Option></Select>
          <Input size="base" id="base-url" label="Base URL" value={form.baseUrl} onChange={(event) => updateForm('baseUrl', event.currentTarget.value)} variant={errors.baseUrl === undefined ? 'default' : 'error'} aria-invalid={errors.baseUrl === undefined ? undefined : true} aria-describedby={errors.baseUrl === undefined ? undefined : 'base-url-error'} placeholder="https://api.example.com/v1" autoComplete="url" spellCheck={false} description="OpenAI-compatible root URLs use /v1 automatically. HTTP is allowed only for localhost, 127.0.0.1, or ::1." disabled={isSaving} />
          {errors.baseUrl === undefined ? null : <p id="base-url-error" role="alert">{errors.baseUrl}</p>}
          <SecretField value={form.apiKey} onValueChange={(value) => updateForm('apiKey', value)} error={errors.apiKey} storedMask={config?.llm.apiKey} requiresReplacement={credentialScopeChanged} disabled={isSaving} />
          <Input size="base" id="model" label="Model" value={form.model} onChange={(event) => updateForm('model', event.currentTarget.value)} variant={errors.model === undefined ? 'default' : 'error'} aria-invalid={errors.model === undefined ? undefined : true} aria-describedby={errors.model === undefined ? undefined : 'model-error'} placeholder="provider/model" autoComplete="off" spellCheck={false} disabled={isSaving} />
          {errors.model === undefined ? null : <p id="model-error" role="alert">{errors.model}</p>}
          {form.provider === 'openai-compatible' ? <Select<ReasoningEffortSetting> size="base" label="Reasoning effort" value={form.reasoningEffort} onValueChange={(value) => updateForm('reasoningEffort', value as ReasoningEffortSetting)} disabled={isSaving}><Select.Option value="auto">Auto</Select.Option><Select.Option value="none">Off</Select.Option><Select.Option value="low">Low</Select.Option><Select.Option value="medium">Medium</Select.Option><Select.Option value="high">High</Select.Option></Select> : null}
          </div>
          {onboarding ? null : <section className="exchange-settings" aria-labelledby="hyperliquid-settings-title">
            <div><p className="eyebrow">LIVE EXECUTION</p><h3 id="hyperliquid-settings-title">Hyperliquid testnet</h3><p>Optional. Use a dedicated Agent/API Wallet. Mainnet is disabled.</p></div>
            <Switch label="Enable Hyperliquid testnet" checked={form.hyperliquidEnabled} onCheckedChange={(value) => updateForm('hyperliquidEnabled', value)} required={false} disabled={isSaving} />
            {form.hyperliquidEnabled ? <>
              <Input size="base" id="hyperliquid-account" label="Master account address" value={form.hyperliquidAccount} onChange={(event) => updateForm('hyperliquidAccount', event.currentTarget.value)} variant={errors.hyperliquidAccount === undefined ? 'default' : 'error'} aria-invalid={errors.hyperliquidAccount === undefined ? undefined : true} aria-describedby={errors.hyperliquidAccount === undefined ? undefined : 'hyperliquid-account-error'} autoComplete="off" spellCheck={false} placeholder="0x…" disabled={isSaving} />
              {errors.hyperliquidAccount === undefined ? null : <p id="hyperliquid-account-error" role="alert">{errors.hyperliquidAccount}</p>}
              <SecretField id="hyperliquid-agent-key" label="Agent/API Wallet private key" value={form.hyperliquidAgentKey} onValueChange={(value) => updateForm('hyperliquidAgentKey', value)} error={errors.hyperliquidAgentKey} storedMask={config?.exchanges.hyperliquid?.agentPrivateKey} requiresReplacement={requiresHyperliquidKey} disabled={isSaving} />
            </> : null}
          </section>}
          <ConnectionTestStatus value={connection} />
          <div className={`form-actions${onboarding ? ' onboarding-actions' : ''}`}>
            {onboarding ? null : <Tooltip content="Checks the URL, authentication, model availability, and a minimal provider request." render={<Button size="base" type="button" variant="secondary" disabled={isTesting || isSaving || isRequiredApiKeyMissing || form.apiKey === REDACTED_SECRET} onClick={() => void testConnection()} />}>Test connection</Tooltip>}
            <Button size="base" type="submit" variant="primary" disabled={onboarding ? isTesting || isSaving || form.apiKey === REDACTED_SECRET : !hasPassedCurrentTest || isTesting || isSaving} loading={onboarding ? isTesting || isSaving : isSaving}>{submitLabel}</Button>
          </div>
          <p className="form-footnote"><InfoIcon aria-hidden="true" /> Your API key is stored locally and sent only to your AI provider.</p>
        </form>
        <Dialog.Root><Dialog.Trigger render={(props) => <Button {...props} className="privacy-dialog-trigger" variant="ghost" size="sm">How is my key handled?</Button>} /><Dialog className="p-8"><Dialog.Title className="text-2xl font-semibold">Local-only credentials</Dialog.Title><Dialog.Description className="mt-2 text-kumo-subtle">Your key is held only by this password field until a successful local save. The stored value is never rendered again.</Dialog.Description><Dialog.Close render={(props) => <Button size="base" {...props} className="mt-6" variant="secondary">Close</Button>} /></Dialog></Dialog.Root>
      </LayerCard>
    </Root>
  );
}
