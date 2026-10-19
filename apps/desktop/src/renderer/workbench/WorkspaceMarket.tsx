import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Dialog, Input, Select } from '@cloudflare/kumo';
import type { CatbotsDesktopApi } from '@catbots/contracts';
import type { FlowWorkspaceState } from './flow-workspace-state';

/** Saved research context. Trading deployments keep their own pinned target. */
export function WorkspaceMarket({ botId, api, connectionsApi, workspace, disabled, dex = 'hyperliquid' }: {
  botId: string; api?: CatbotsDesktopApi['nodes']; connectionsApi?: CatbotsDesktopApi['connections'];
  workspace: FlowWorkspaceState; disabled?: boolean;
  dex?: 'hyperliquid'|'lighter';
}) {
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(''), [selected, setSelected] = useState(workspace.market);
  const [markets, setMarkets] = useState<string[]>([]), [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const loadCatalog = async () => {
    try { const response = await api?.command({ action: 'market_catalog' }); setMarkets(response?.markets ?? []); setError(''); }
    catch { setError('Market list unavailable. Retry to choose a market.'); }
  };
  useEffect(() => {
    let active = true; setLoading(true); workspace.setMarketReady(false);
    void (async () => {
      try {
        const response = await api?.command({ action: 'get_workspace_market', botId });
        const target = response?.workspaceMarket ? undefined : await connectionsApi?.command({ action: 'get_target', botId });
        if (!active) return;
        const market = response?.workspaceMarket ?? target?.executionTarget?.target?.market ?? 'ETH-PERP';
        workspace.setMarketReady(true); setError(''); workspace.setMarket(market); setSelected(market); setSaved(response?.workspaceMarket ?? '');
      } catch { if (active) setError('Could not load the saved market. Retry before testing.'); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, [api, connectionsApi, botId, attempt]);
  const save = async () => {
    if (!api || !markets.includes(selected)) return;
    setLoading(true); setError('');
    try { await api.command({ action: 'save_workspace_market', botId, market: selected }); workspace.setMarket(selected); setSaved(selected); setEditing(false); }
    catch { setError('Market was not saved. Try again.'); }
    finally { setLoading(false); }
  };
  return <div className="workspace-market-control">
    <Button size="sm" variant="secondary" disabled={loading || disabled || workspace.running || !api} aria-label="Change design and test market" title={`Design and test market · ${dex === 'lighter' ? 'Lighter' : 'Hyperliquid'} Mainnet data`} onClick={() => { setSelected(workspace.market); setSearch(''); setEditing(true); void loadCatalog(); }}>
      {loading ? 'Loading market…' : `${workspace.market} · Simulation${error ? ' · !' : ''}`}
    </Button>
    <Dialog.Root open={editing} onOpenChange={setEditing}>
      <Dialog className="workbench-approval-dialog market-settings-dialog">
        <Dialog.Title>Design & test market</Dialog.Title>
        <Dialog.Description>All node tests and new backtests use this market. Trading targets are set separately in Deploy.</Dialog.Description>
        <div className="provider-actions"><Badge variant="secondary">{dex === 'lighter' ? 'Lighter' : 'Hyperliquid'} · Perpetual</Badge><Badge variant="info">Mainnet data · Simulation</Badge></div>
        {!saved && !loading && <p className="backtest-muted">This session uses {workspace.market}. Save to remember your choice for this bot.</p>}
        <Input size="base" label="Search markets" placeholder="Search SOL, BTC, ETH…" value={search} onChange={event => setSearch(event.target.value)} />
        <Select size="base" label="Market" value={selected} renderValue={value => String(value)} onValueChange={value => setSelected(String(value))}>
          {markets.filter(market => market.includes(search.trim().toUpperCase())).map(market => <Select.Option key={market} value={market}>{market}</Select.Option>)}
        </Select>
        {error && <Banner variant="error" title="Market needs attention" description={error}/>}
        {!workspace.marketReady && <Button size="sm" variant="secondary" onClick={() => setAttempt(attempt + 1)}>Reload saved market</Button>}
        {error && <Button size="sm" variant="secondary" onClick={() => void loadCatalog()}>Retry market list</Button>}
        <div className="workbench-dialog-actions">
          <Dialog.Close render={<Button size="base" variant="secondary" />}>Cancel</Dialog.Close>
          <Button size="base" variant="primary" disabled={loading || disabled || workspace.running || !workspace.marketReady || !markets.includes(selected)} onClick={() => void save()}>Save market</Button>
        </div>
      </Dialog>
    </Dialog.Root>
  </div>;
}
