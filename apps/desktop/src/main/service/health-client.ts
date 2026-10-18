import { isServiceIdentity, type ServiceIdentity } from '../web/service-identity';

type HealthClientOptions = Readonly<{
  origin: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}>;

export function createHealthClient(options: HealthClientOptions) {
  const fetchHealth = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;

  const current = async (): Promise<ServiceIdentity | undefined> => {
    let response: Response;
    try {
      response = await fetchHealth(`${options.origin}/api/health`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(timeoutMs, 2_000)),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error('SERVICE_HEALTH_INVALID');
    }
    return isServiceIdentity(value) ? value : undefined;
  };

  return {
    current,
    waitForReady: async (): Promise<ServiceIdentity> => {
      const deadline = now() + timeoutMs;
      while (now() <= deadline) {
        const identity = await current();
        if (identity?.readiness === 'ready') return identity;
        await delay(pollMs);
      }
      throw new Error('SERVICE_START_TIMEOUT');
    },
  };
}
