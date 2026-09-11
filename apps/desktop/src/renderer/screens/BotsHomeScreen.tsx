import { BotExecutionActivity, ExecutionBadge } from './BotExecutionActivity';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button, LayerCard, Table, Input, Select, Dialog } from '@cloudflare/kumo';
import { PlusIcon, MagnifyingGlassIcon, ChatCircleTextIcon, GraphIcon, FlaskIcon } from '@phosphor-icons/react';
import type { BotExecutionOverview, BotSummary, CatbotsDesktopApi } from '@catbots/contracts';
import { BrandIllustration } from '../components/BrandIllustration';
import { StatusBadge } from '../components/StatusBadge';
import { CreateDraftBotDialog } from './CreateDraftBotDialog';

type BotsHomeScreenProps = { api: CatbotsDesktopApi['bots']; connections?: CatbotsDesktopApi['connections']; onOpenBot?(bot: BotSummary): void };

const DEX_DISPLAY_NAMES: Record<BotSummary['dex'], string> = {
  hyperliquid: 'Hyperliquid',
};

export function formatUpdatedAt(value: string, locale = 'en-US', timeZone = 'UTC'): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'Updated locally';
  return `Updated ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(timestamp)}`;
}

function latestBotUpdate(bot: BotSummary, execution?: BotExecutionOverview): string {
  const lastRunAt = execution?.deployment?.lastRunAt;
  return lastRunAt && Date.parse(lastRunAt) > Date.parse(bot.updatedAt) ? lastRunAt : bot.updatedAt;
}

function mergeBots(listedBots: readonly BotSummary[], locallyCreatedBots: ReadonlyMap<string, BotSummary>): BotSummary[] {
  const merged = new Map(listedBots.map((bot) => [bot.id, bot]));
  for (const [id, bot] of locallyCreatedBots) if (!merged.has(id)) merged.set(id, bot);
  return [...merged.values()];
}

export function BotsHomeScreen({ api, connections, onOpenBot }: BotsHomeScreenProps) {
  const [execution, setExecution] = useState<Record<string,BotExecutionOverview>>({});
  const [executionError,setExecutionError]=useState(false);
  const [selectedActivity,setSelectedActivity]=useState<string|null>(null);
  const [deleting,setDeleting]=useState<BotSummary|null>(null);
  const [deleteBusy,setDeleteBusy]=useState(false);
  const [deleteError,setDeleteError]=useState('');
  const [deleteBlocked,setDeleteBlocked]=useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [hasListError, setHasListError] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const mountedRef = useRef(true);
  const listRequestTokenRef = useRef(0);
  const locallyCreatedBotsRef = useRef(new Map<string, BotSummary>());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadBots = useCallback(async () => {
    const requestToken = listRequestTokenRef.current + 1;
    listRequestTokenRef.current = requestToken;
    setBots(null);
    setHasListError(false);
    try {
      const localBots = await api.list();
      if (!mountedRef.current || requestToken !== listRequestTokenRef.current) return;
      setBots(mergeBots(localBots, locallyCreatedBotsRef.current));
    } catch {
      if (!mountedRef.current || requestToken !== listRequestTokenRef.current) return;
      setBots([...locallyCreatedBotsRef.current.values()]);
      setHasListError(true);
    }
  }, [api]);

  useEffect(() => { void loadBots(); }, [loadBots]);

  const addCreatedBot = (created: BotSummary) => {
    locallyCreatedBotsRef.current.set(created.id, created);
    setHasListError(false);
    setBots((previous) => previous === null ? [...locallyCreatedBotsRef.current.values()] : mergeBots(previous, locallyCreatedBotsRef.current));
    onOpenBot?.(created);
  };

  const botIds=bots?.map(bot=>bot.id).join(',')??'';
  useEffect(()=>{
    if(!botIds)return;
    if(!connections){setExecution(Object.fromEntries(botIds.split(',').map(botId=>[botId,{botId}])));return;}
    let disposed=false;
    let timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try {
        const result=await connections.command({action:'bot_overview',botIds:botIds.split(',')});
        if(!disposed){setExecution(Object.fromEntries((result.botOverview??[]).map(view=>[view.botId,view])));setExecutionError(false);}
      }catch{if(!disposed)setExecutionError(true);}
      if(!disposed)timer=setTimeout(refresh,15000);
    };
    void refresh();
    return ()=>{disposed=true;clearTimeout(timer);};
  },[connections,botIds]);
  const displayStatus=(bot:BotSummary)=>execution[bot.id]?.deployment?.status==='failed'?'error':execution[bot.id]?.deployment?.status??(execution[bot.id]?.target?'not_started':bot.status);
  const filteredBots = bots?.filter((bot) => bot.name.toLowerCase().includes(query.trim().toLowerCase()) && (status === 'all' || displayStatus(bot) === status)).sort((a, b) => Date.parse(latestBotUpdate(b, execution[b.id])) - Date.parse(latestBotUpdate(a, execution[a.id])) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) ?? [];

  return (
    <section className="bots-home page-container" aria-labelledby="bots-home-title">
      <header className="bots-home-header">
        <div>
          <h1 id="bots-home-title">Bots</h1>
          <p>Turn a trading idea into a strategy you can inspect and test.</p>
        </div>
        <Button size="base" type="button" variant="primary" icon={PlusIcon} onClick={() => setIsCreateOpen(true)}>Create new bot</Button>
      </header>

      {bots === null ? <div className="bots-state" role="status" aria-live="polite">Loading local bots…</div> : null}
      {hasListError ? (
        <div className="bots-list-error" role="alert">
          <Banner variant="error" title="Local bots unavailable" description="We could not load local bots. Try again." />
          <Button size="base" type="button" variant="secondary" onClick={() => { void loadBots(); }}>Try again</Button>
        </div>
      ) : null}
      {bots !== null && !hasListError && bots.length === 0 ? <EmptyBots onCreate={() => setIsCreateOpen(true)} /> : null}
      {bots !== null && bots.length > 0 ? <>
        <div className="bots-toolbar">
          <Input size="base" aria-label="Search bots" placeholder="Search bots…" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Select<string> size="base" aria-label="Filter by status" value={status} onValueChange={(value) => setStatus(value ?? 'all')} items={{ all: 'All statuses', draft: 'Draft', not_started:'Not started', running:'Running', stopping:'Stopping', interrupted:'Interrupted', paper: 'Paper', live: 'Live', paused: 'Paused', stopped: 'Stopped', error: 'Error', recovering: 'Recovering' }}>
            <Select.Option value="all">All statuses</Select.Option>{['not_started', 'running', 'stopping', 'interrupted', 'draft', 'paper', 'live', 'paused', 'stopped', 'error', 'recovering'].map((value) => <Select.Option key={value} value={value}>{(value.charAt(0).toUpperCase() + value.slice(1)).replaceAll('_',' ')}</Select.Option>)}
          </Select>
          <span className="bots-result-count" role="status">{filteredBots.length} of {bots.length} bots</span>
        </div>
        {filteredBots.length ? <BotsTable bots={filteredBots} execution={execution} executionError={executionError} onActivity={setSelectedActivity} onDelete={api.remove ? bot=>{setDeleting(bot);setDeleteError('');setDeleteBlocked(false);} : undefined} onOpenBot={onOpenBot} /> : <div className="bots-state"><h2>No matching bots</h2><p>Try another name or status.</p><Button size="base" variant="secondary" onClick={() => { setQuery(''); setStatus('all'); }}>Clear filters</Button></div>}
      </> : null}

      {executionError && <Banner variant="error" title="Runtime status unavailable" description="Displayed data may be out of date. Retrying automatically."/>}
      {selectedActivity && execution[selectedActivity] && <BotExecutionActivity name={bots?.find(bot=>bot.id===selectedActivity)?.name??'Bot'} view={execution[selectedActivity]} onClose={()=>setSelectedActivity(null)}/>}
      <Dialog.Root open={!!deleting} onOpenChange={open=>{if(!open&&!deleteBusy)setDeleting(null);}}><Dialog className="delete-bot-dialog" size="base" aria-label="Delete bot"><Dialog.Title>Delete {deleting?.name}?</Dialog.Title><Dialog.Description>Remove this bot from your list. Trading history is kept.</Dialog.Description><p className="delete-bot-note">Positions and exchange orders stay open.</p>{deleteError&&<Banner variant="error" title="Could not delete bot" description={deleteError}/>} {deleteBlocked && onOpenBot && <Button size="base" variant="secondary" onClick={()=>{if(deleting){onOpenBot(deleting);setDeleting(null);}}}>Open bot to resolve</Button>}<div className="delete-bot-actions"><Button size="base" variant="secondary" disabled={deleteBusy} onClick={()=>setDeleting(null)}>Cancel</Button><Button size="base" variant="primary" loading={deleteBusy} disabled={deleteBusy} onClick={async()=>{
        if(!deleting||!api.remove)return;
        setDeleteBusy(true);setDeleteError('');
        try{await api.remove({botId:deleting.id});locallyCreatedBotsRef.current.delete(deleting.id);setBots(previous=>previous?.filter(bot=>bot.id!==deleting.id)??[]);setDeleting(null);}
        catch(error){
          const message=error instanceof Error?error.message:'';
          const active=message.includes('BOT_ACTIVE');
          const unresolved=message.includes('BOT_UNRESOLVED');
          setDeleteBlocked(active||unresolved);
          setDeleteError(active ? 'This bot still has an active or saved deployment. Open the bot and press Stop, including when Paper runtime is unavailable, then delete it again.' : unresolved ? 'An order outcome is still uncertain. Open Deploy and reconcile with the exchange before deleting.' : 'Could not remove this bot. Please retry. If the problem continues, check that the local backend is up to date.');
        }
        finally{setDeleteBusy(false);}
      }}>Delete bot</Button></div></Dialog></Dialog.Root>
      <CreateDraftBotDialog api={api} open={isCreateOpen} onOpenChange={setIsCreateOpen} onCreated={addCreatedBot} />
    </section>
  );
}

function EmptyBots({ onCreate }: { onCreate(): void }) {
  return (
    <div className="bots-welcome">
    <section className="brand-welcome" aria-labelledby="empty-bots-heading">
      <div className="brand-welcome-copy">
        <p className="brand-welcome-status">No bots yet</p>
        <h2 id="empty-bots-heading">One idea.<br />Every rule visible.</h2>
        <p>Describe a trading idea, see how the rules connect, and test your strategy before taking the next step.</p>
        <Button size="base" type="button" variant="primary" icon={PlusIcon} onClick={onCreate}>Create new bot</Button>
      </div>
      <div className="brand-welcome-art"><BrandIllustration /></div>
    </section>
    <div className="getting-started" aria-label="How it works">
      <div><ChatCircleTextIcon size={22} aria-hidden="true" /><h3>Describe your strategy</h3><p>Give your bot a name, then explain your trading idea in chat.</p></div>
      <div><GraphIcon size={22} aria-hidden="true" /><h3>Review the logic</h3><p>Inspect triggers, conditions, and actions in a visual graph.</p></div>
      <div><FlaskIcon size={22} aria-hidden="true" /><h3>Test before deploying</h3><p>Run a backtest and review the results before moving to paper trading.</p></div>
    </div><p className="bots-market-note">Hyperliquid · Perpetual markets</p></div>
  );
}

function BotsTable({ bots, execution, executionError, onActivity, onDelete, onOpenBot }: { onDelete?(bot:BotSummary):void; execution:Record<string,BotExecutionOverview>; executionError:boolean; onActivity(id:string):void; bots: readonly BotSummary[]; onOpenBot?(bot: BotSummary): void }) {
  return (
    <LayerCard className="bots-table-wrap">
      <Table aria-label="Local bots">
        <Table.Header>
          <Table.Row>
            <Table.Head>Name</Table.Head>
            <Table.Head>DEX</Table.Head>
            <Table.Head>Status</Table.Head>
            <Table.Head>Updated</Table.Head>
            <Table.Head>Account position</Table.Head>
            <Table.Head>Account orders</Table.Head><Table.Head><span className="sr-only">Actions</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {bots.map((bot) => (
            <Table.Row key={bot.id}>
              <Table.Cell><Button size="base" type="button" variant="ghost" className="bot-name-button" onClick={() => onOpenBot?.(bot)}>{bot.name}</Button></Table.Cell>
              <Table.Cell>{DEX_DISPLAY_NAMES[bot.dex]}</Table.Cell>
              <Table.Cell>{executionError ? 'Status unavailable' : execution[bot.id]?.target ? <ExecutionBadge view={execution[bot.id]}/> : connectionsPlaceholder(execution[bot.id],bot.status)}</Table.Cell>
              <Table.Cell><time dateTime={latestBotUpdate(bot, execution[bot.id])}>{formatUpdatedAt(latestBotUpdate(bot, execution[bot.id]))}</time></Table.Cell>
              <Table.Cell>{execution[bot.id]?.target ? <Button size="base" variant="ghost" onClick={()=>onActivity(bot.id)}>{execution[bot.id].activity ? execution[bot.id].activity!.positions.filter(item=>item.market===execution[bot.id].target?.market).map(item=>`${Number(item.size)>0?'Long':'Short'} ${Math.abs(Number(item.size))}`).join(', ')||'Flat' : 'Unavailable'} · {execution[bot.id].target?.market}</Button>:'—'}</Table.Cell>
              <Table.Cell>{execution[bot.id]?.target ? <Button size="base" variant="ghost" onClick={()=>onActivity(bot.id)}>{execution[bot.id].activity ? `${execution[bot.id].activity!.orders.filter(item=>item.market===execution[bot.id].target?.market).length} open` : 'Unavailable'} · Details</Button>:'—'}</Table.Cell>
              <Table.Cell>{onDelete&&<Button size="sm" variant="ghost" aria-label={`Delete ${bot.name}`} disabled={!!execution[bot.id]?.deployment && ['running','stopping','interrupted'].includes(execution[bot.id].deployment!.status)} onClick={()=>onDelete(bot)}>Delete</Button>}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>
    </LayerCard>
  );
}

function connectionsPlaceholder(view:BotExecutionOverview|undefined,status:BotSummary['status']) {return view ? <StatusBadge status={status}/> : <span>Loading status…</span>;}
