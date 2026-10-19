import { MarketPicker } from './MarketPicker';
import { useEffect, useRef, useState } from 'react';
import { Badge, Banner, Button, CodeBlock, Collapsible, Input, LayerCard, Select, Switch, Table, Tabs } from '@cloudflare/kumo';
import { PlayIcon, StopIcon, SlidersHorizontalIcon, CaretDownIcon } from '@phosphor-icons/react';
import { FlowBacktestSettingsSchema, type CatbotsDesktopApi, type ChatFlowDraft, type FlowBacktestJob, type FlowBacktestSettings } from '@catbots/contracts';
import { EquityCurve } from './EquityCurve';
const money=(value:number)=>value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const stamp=(value:string)=>value.slice(0,16);
function defaults():FlowBacktestSettings { const to=Math.floor(Date.now()/3600000)*3600000;return {market:'ETH-PERP',from:new Date(to-7*86400000).toISOString(),to:new Date(to).toISOString(),timeframe:'1h',startingCapital:10000,feeBps:3.5,slippageBps:1}; }
export function FlowBacktestPanel({draft,api,workspaceMarket='ETH-PERP',disabled=false,dex='hyperliquid'}:{dex?:'hyperliquid'|'lighter';workspaceMarket?:string;draft:ChatFlowDraft;api?:CatbotsDesktopApi['nodes'];disabled?:boolean}) {
  const [settings,setSettings]=useState(() => ({...defaults(), market: workspaceMarket})),[refresh,setRefresh]=useState(false),[job,setJob]=useState<FlowBacktestJob|null>(null),[error,setError]=useState(''),[starting,setStarting]=useState(false),[page,setPage]=useState(0);
  const [overrideMarket,setOverrideMarket]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(true),[resultTab,setResultTab]=useState('overview');
  useEffect(()=>{if(job?.status==='completed'){setSettingsOpen(false);setResultTab('overview');}},[job?.id,job?.status]);
  const storageKey=`catbots.backtest-job:${draft.botId}`;
  const [jobId,setJobId]=useState(()=>{try{return sessionStorage.getItem(storageKey)??'';}catch{return '';}});
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(!api||!jobId)return;let active=true;let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const response=await api.command({action:'backtest_status',botId:draft.botId,jobId});if(!active)return;if(!response.backtest)throw new Error();setJob(response.backtest);if(['loading','running'].includes(response.backtest.status))timer=setTimeout(()=>void poll(),750);}catch{if(active)setError('Run is no longer available. The backend may have restarted; run again to restore cached results.');}};
    void poll();return()=>{active=false;clearTimeout(timer);};
  },[api,jobId,draft.botId]);
  const busy=starting||job?.status==='loading'||job?.status==='running';
  useEffect(()=>{if(!overrideMarket && !busy)setSettings(previous=>({...previous,market:workspaceMarket}));},[workspaceMarket,overrideMarket,busy]);
  const result=job?.result;
  const start=async()=>{const parsed=FlowBacktestSettingsSchema.safeParse(settings);if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join('; '));return;}if(!api)return;setStarting(true);setError('');setPage(0);
    try{const response=await api.command({action:'backtest_flow',botId:draft.botId,version:draft.version,settings:parsed.data,refresh});if(!alive.current)return;if(!response.backtest)throw new Error();setJob(response.backtest);setJobId(response.backtest.id);try{sessionStorage.setItem(storageKey,response.backtest.id);}catch{}}
    catch{if(alive.current)setError('Could not start. Save node changes, reload the flow, or wait for another active backtest to finish.');}finally{if(alive.current)setStarting(false);}};
  const chart=result?result.equityCurve.filter((_,index,all)=>index===0||index===all.length-1||index%Math.max(1,Math.ceil(all.length/400))===0).map(point=>({timestamp:new Date(point.at).toISOString(),equity:String(point.equity)})):[];
  return <section className="backtest-panel flow-backtest" aria-label="Historical flow backtest">
    <header className="backtest-toolbar"><div><p className="eyebrow">STRATEGY TESTING · FLOW v{draft.version}</p><h2>Backtest</h2><p className="backtest-muted">Test your rules before putting capital at risk.</p></div><Button size="base" variant="primary" icon={PlayIcon} disabled={busy||disabled||!api} loading={starting} onClick={()=>void start()}>Run historical backtest</Button>{busy&&job&&<Button size="base" variant="secondary" icon={StopIcon} onClick={async()=>{try{const response=await api?.command({action:'cancel_backtest',botId:draft.botId,jobId:job.id});if(response?.backtest)setJob(response.backtest);}catch{setError('Could not cancel; retry or wait for completion.');}}}>Cancel backtest</Button>}</header>
    <LayerCard className="backtest-setup">
      <div className="backtest-setup-heading"><div><h3>Run settings</h3><p className="backtest-muted">{settings.market} · {settings.timeframe} candles · ${money(settings.startingCapital)} starting capital</p></div><Button size="sm" variant="secondary" icon={SlidersHorizontalIcon} aria-expanded={settingsOpen} aria-controls="backtest-settings" onClick={()=>setSettingsOpen(!settingsOpen)}>{settingsOpen?'Hide settings':'Edit settings'}</Button></div>
      <div id="backtest-settings" hidden={!settingsOpen}>
      <p className="backtest-muted">{dex==='lighter'?'Lighter':'Hyperliquid'} Mainnet historical data · Simulation only. Dates are UTC; the end time is exclusive.</p>
    <div className="provider-actions"><Badge variant="secondary">{settings.market} · {overrideMarket ? 'Backtest override' : 'From workspace'}</Badge><Switch label="Test a different market" checked={overrideMarket} disabled={busy} onCheckedChange={setOverrideMarket}/></div>
    <div className="backtest-assumption-form">{overrideMarket && <MarketPicker api={api} label="Backtest market only" value={settings.market} disabled={busy} onChange={market=>setSettings({...settings,market})}/>}
      <Input size="base" label="From (UTC)" type="datetime-local" value={stamp(settings.from)} disabled={busy} onChange={event=>setSettings({...settings,from:event.target.value?`${event.target.value}:00.000Z`:''})}/>
      <Input size="base" label="To (UTC, exclusive)" type="datetime-local" value={stamp(settings.to)} disabled={busy} onChange={event=>setSettings({...settings,to:event.target.value?`${event.target.value}:00.000Z`:''})}/>
      <Select size="base" label="Replay interval" value={settings.timeframe} disabled={busy} onValueChange={value=>setSettings({...settings,timeframe:value as FlowBacktestSettings['timeframe']})}>{['1m','5m','15m','1h'].map(value=><Select.Option key={value} value={value}>{value}</Select.Option>)}</Select>
      {(['startingCapital','feeBps','slippageBps'] as const).map((key,index)=><Input key={key} size="base" type="number" label={['Starting capital (USD)','Fee per fill (bps)','Market slippage (bps)'][index]} value={settings[key]} min={0} disabled={busy} onChange={event=>setSettings({...settings,[key]:Number(event.target.value)})}/>)}</div>
    <Switch disabled={busy} label="Refresh historical data and recompute (bypass cache)" checked={refresh} onCheckedChange={setRefresh}/>
    </div></LayerCard>
    {disabled&&<p>Save or reset unsaved node configurations and wait for AI to finish before running.</p>}
    {error&&<Banner variant="error" title="Backtest needs attention" description={error}/>}
    {job&&<p role="status"><Badge variant={job.status==='completed'?'success':'info'}>{job.status}</Badge> {job.status==='loading'?'Loading and validating market history':`${Math.round(job.progress*100)}%`} · {job.cacheHit?'Cached result':'New run'}</p>}
    {job?.error&&<Banner variant="error" title="Backtest failed" description={job.error}/>}
    {result?<><div className="backtest-provenance"><Badge variant="info">Flow v{job.version}</Badge><span>{result.settings.market} · {stamp(result.settings.from).replace('T',' ')} → {stamp(result.settings.to).replace('T',' ')} UTC · {result.settings.timeframe}</span></div>{job.version!==draft.version&&<Banner variant="alert" title="Older flow result" description="This result belongs to a previous saved flow version. Run again to test the current flow."/>}
      {result.settings.market!==settings.market&&<Banner variant="alert" title="Result uses a different market" description={`These results are for ${result.settings.market}. Run again to test ${settings.market}.`}/>}
      <Tabs tabs={[{value:'overview',label:'Overview'},{value:'fills',label:`Fills (${result.fills.length})`},{value:'diagnostics',label:'Run details'}]} value={resultTab} onValueChange={setResultTab}/>
      {resultTab==='overview'&&<div className="backtest-result-section">
      <div className="metric-grid">{[['Final equity',money(result.finalEquity)],['Net return',`${result.returnPercent>=0?'+':''}${result.returnPercent.toFixed(2)}%`],['Drawdown (bar close)',`${result.maxDrawdownPercent.toFixed(2)}%`],['Fills',String(result.fills.length)],['Fees / funding',`${money(result.fees)} / ${money(result.funding)}`],['Realized / unrealized PnL',`${money(result.realizedPnl)} / ${money(result.unrealizedPnl)}`]].map(([label,value])=><LayerCard className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></LayerCard>)}</div>
      <p className="backtest-muted">{result.dataset.bars} replay bars · {result.durationMs.toFixed(0)} ms {job.cacheHit?'original compute':'compute'} · {result.rejectedOrders} rejected orders · {result.pendingOrders} pending at end · Position {result.position.quantity} @ {money(result.position.entryPrice)}</p>
      <EquityCurve points={chart}/><p className="backtest-muted">Signals use closed candles; orders fill from the next bar. Chart sampled for display; metrics use every replay bar.</p>
      <div className="provider-actions"><span className="backtest-muted">Simulation · Results may differ from live trading.</span><Button size="sm" variant="ghost" onClick={()=>setResultTab('diagnostics')}>View run details</Button></div></div>}
      {resultTab==='fills'&&
      <LayerCard className="backtest-trades"><h3>Fills</h3><p>Market fills are at the next open. Intrabar limit fills use the bar’s opening timestamp as a bucket, not an exact execution time.</p><div className="backtest-table-scroll"><Table aria-label="Historical fills"><Table.Header><Table.Row>{['Time (UTC)','Side','Quantity','Price','Fee','Realized PnL'].map(label=><Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header><Table.Body>{result.fills.slice(page*50,page*50+50).map((fill,index)=><Table.Row key={index}><Table.Cell>{new Date(fill.at).toISOString().slice(0,19).replace('T',' ')}</Table.Cell><Table.Cell>{fill.side}</Table.Cell><Table.Cell>{fill.quantity}</Table.Cell><Table.Cell>{money(fill.price)}</Table.Cell><Table.Cell>{money(fill.fee)}</Table.Cell><Table.Cell>{money(fill.realizedPnl)}</Table.Cell></Table.Row>)}</Table.Body></Table></div>{!result.fills.length&&<p>No fills in this period. Review node coverage and strategy conditions.</p>}<div className="provider-actions"><Button size="sm" variant="secondary" disabled={!page} onClick={()=>setPage(page-1)}>Previous fills</Button><span>{page+1} / {Math.max(1,Math.ceil(result.fills.length/50))}</span><Button size="sm" variant="secondary" disabled={(page+1)*50>=result.fills.length} onClick={()=>setPage(page+1)}>Next fills</Button></div></LayerCard>}
      {resultTab==='diagnostics'&&<div className="backtest-result-section">
        <div><h3>Run details</h3><p className="backtest-muted">{result.settings.market} · {result.dataset.bars.toLocaleString()} candles · {Object.keys(result.nodeStats).length} nodes</p></div>
        <div className="provider-actions"><Badge variant={Object.values(result.nodeStats).some(stats=>stats.unavailable>0)?'info':'success'}>{Object.values(result.nodeStats).filter(stats=>stats.unavailable>0).length} unavailable nodes</Badge><Badge variant={result.rejectedOrders>0?'info':'secondary'}>{result.rejectedOrders} rejected orders</Badge></div>
        <Collapsible.Root><Collapsible.Trigger render={<Button size="sm" variant="secondary" icon={CaretDownIcon}/>}>Node activity</Collapsible.Trigger><Collapsible.Panel className="backtest-node-coverage">
          <p className="backtest-muted">Skipped nodes may be on an inactive branch. Unavailable nodes need attention.</p>
          <div className="backtest-table-scroll"><Table aria-label="Backtest node coverage"><Table.Header><Table.Row><Table.Head>Node</Table.Head><Table.Head>Executed</Table.Head><Table.Head>Skipped</Table.Head><Table.Head>Unavailable</Table.Head></Table.Row></Table.Header><Table.Body>{Object.entries(result.nodeStats).map(([id,stats])=><Table.Row key={id}><Table.Cell>{id}</Table.Cell><Table.Cell>{stats.executed}</Table.Cell><Table.Cell>{stats.skipped}</Table.Cell><Table.Cell>{stats.unavailable}</Table.Cell></Table.Row>)}</Table.Body></Table></div>
        </Collapsible.Panel></Collapsible.Root>
        {result.warnings.length>0&&<LayerCard className="metric-card"><h3>Simulation limits</h3><p className="backtest-muted">How this test differs from live trading.</p>
          {result.warnings.map((warning,index)=><Collapsible.Root key={`${index}:${warning}`}><Collapsible.Trigger render={<Button size="sm" variant="ghost" icon={CaretDownIcon}/>}>{assumptionTitle(warning)}</Collapsible.Trigger><Collapsible.Panel><p className="backtest-muted">{warning}</p></Collapsible.Panel></Collapsible.Root>)}
        </LayerCard>}
        <Collapsible.Root><Collapsible.Trigger render={<Button size="sm" variant="ghost" icon={CaretDownIcon}/>}>Technical details</Collapsible.Trigger><Collapsible.Panel>
          <p className="backtest-muted">Engine, data fingerprints and settings for reproducing this run.</p>
          <CodeBlock lang="jsonc" code={JSON.stringify({engine:result.engineVersion,flowHash:result.flowHash,dataHash:result.dataHash,fetchedAt:result.dataset.fetchedAt,settings:result.settings},null,2)}/>
        </Collapsible.Panel></Collapsible.Root>
      </div>}</>:!busy&&<LayerCard className="backtest-empty"><h3>Test your saved flow on historical data</h3><p>{dex==='lighter'?'Paginated Lighter history, up to 100,000 candles per interval':'Up to 5,000 recent candles per interval'}, including indicator warm-up. Missing history stops the run; results are never substituted with sample data.</p></LayerCard>}
  </section>;
}

function assumptionTitle(warning:string):string {
  if (warning.startsWith('OHLCV simulation:')) return 'Orders fill from the next candle';
  if (warning.startsWith('Net position,')) return 'No leverage or order-book simulation';
  if (warning.startsWith('Historical funding')) return 'Funding uses hourly estimates';
  if (warning.startsWith('Open positions')) return 'Open positions remain open at the end';
  return warning.length>100 ? `${warning.slice(0,97)}…` : warning;
}
