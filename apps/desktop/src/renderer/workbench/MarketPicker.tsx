import { useEffect, useState } from 'react';
import { Button, Select } from '@cloudflare/kumo';
import type { CatbotsDesktopApi } from '@catbots/contracts';
/** Only markets supported by the current Hyperliquid data adapter. Deploy readiness validates the selected network. */
export function MarketPicker({ api, value, onChange, label, disabled, dex, environment }: { api?: CatbotsDesktopApi['nodes']; value: string; onChange(value: string): void; label: string; disabled?: boolean; dex?: 'hyperliquid'|'lighter'; environment?: 'production'|'testnet' }) {
  const [markets, setMarkets] = useState<string[]>([]), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; setError(false); setMarkets([]); void api?.command({ action: 'market_catalog', ...(dex ? {dex} : {}), ...(environment ? {environment} : {}) }).then(result => { if (active) setMarkets(result.markets ?? []); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api, attempt, dex, environment]);
  return <div><Select size="base" label={label} value={value} disabled={disabled || !markets.length} renderValue={value => String(value)} onValueChange={value => onChange(String(value))}>
    {markets.map(market => <Select.Option key={market} value={market}>{market}</Select.Option>)}
  </Select>{error && <Button size="sm" variant="secondary" onClick={() => setAttempt(attempt + 1)}>Retry market list</Button>}</div>;
}
