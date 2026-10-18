import { useEffect, useState } from 'react';
import { Badge, Banner, Button, Input, LayerCard, Select, Table, Collapsible } from '@cloudflare/kumo';
import { PlugsConnectedIcon, ArrowClockwiseIcon, CopyIcon, CaretDownIcon } from '@phosphor-icons/react';
import type { CatbotsDesktopApi, ConnectionsView, ConnectionCommand } from '@catbots/contracts';
type WalletProvider={request(input:{method:string;params?:unknown[]}):Promise<unknown>};
const connectionError=(error:unknown)=>{
 const message=error instanceof Error?error.message:'';
 const descriptions:Record<string,string>={
 CONNECTION_KEYSTORE_UNAVAILABLE:'Cannot access secure key storage. Unlock your macOS Keychain and retry. No unencrypted key was saved.',
 CONNECTION_ACCOUNT_NOT_ACTIVATED:'Hyperliquid requires an activated account on this network. Open Hyperliquid on the selected Testnet/Mainnet, set up the main account and fund it as required, then retry.',
 CONNECTION_AGENT_LIMIT:'This account has reached its API wallet limit. Remove an unused API wallet on Hyperliquid, then retry.',
 CONNECTION_AUTHORIZATION_EXPIRED:'The authorization request expired. Click Authorize trading again and sign the new request.',
 CONNECTION_SIGNATURE_REJECTED:'Hyperliquid rejected the signature. Check the selected main wallet and network, then authorize again.',
 CONNECTION_WALLET_MISMATCH:'The signature does not match this connection’s owner. Check the main wallet, reload the page and sign a fresh authorization request.',
 CONNECTION_AUTHORIZATION_REJECTED:'Hyperliquid rejected API wallet approval. Check account activation and existing API wallets on the selected network, then retry.',
 CONNECTION_EXCHANGE_UNREACHABLE:'Could not reach Hyperliquid. Approval may have been submitted; click Check authorization before trying again.',
 CONNECTION_RATE_LIMITED:'Hyperliquid rate limit reached. Wait briefly, then click Check authorization.',
 CONNECTION_INVALID_RESPONSE:'Could not verify Hyperliquid’s response. Click Check authorization to confirm whether approval succeeded.',
 WEB_REQUEST_FAILED:'The backend could not complete authorization. Reload this page and retry; if it persists, restart the local backend.',
 };
 return Object.entries(descriptions).find(([code])=>message.includes(code))?.[1]??(message||'Connection failed. Please retry.');
};
const wallet=()=> (window as unknown as {ethereum?:WalletProvider}).ethereum;
const usd=(value:string)=>Number(value).toLocaleString(undefined,{style:'currency',currency:'USD'});
export function ConnectionsScreen({api}:{api:NonNullable<CatbotsDesktopApi['connections']>}){
 const [view,setView]=useState<ConnectionsView>({adapters:[],connections:[]}),[busy,setBusy]=useState(true),[error,setError]=useState(''),[adding,setAdding]=useState(false),[adapterId,setAdapter]=useState(''),[environment,setEnvironment]=useState<'production'|'testnet'>('production'),[name,setName]=useState(''),[owner,setOwner]=useState('');
 useEffect(()=>{let active=true;api.command({action:'list'}).then(next=>{if(active){setView(next);setAdapter(next.adapters[0]?.id??'');}}).catch(()=>{if(active)setError('Could not load connections. Retry when the backend is available.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[api]);
 const run=async(command:ConnectionCommand)=>{setBusy(true);setError('');try{const next=await api.command(command);setView(next);if(!adapterId)setAdapter(next.adapters[0]?.id??'');if(command.action==='connect'){setAdding(false);setOwner('');setName('');}}catch(e){setError(connectionError(e));}finally{setBusy(false);}};
 const connectWallet=async()=>{setError('');setBusy(true);try{const provider=wallet();if(!provider)throw new Error('Open this workspace in a browser with a wallet extension to connect.');const accounts=await provider.request({method:'eth_requestAccounts'});if(!Array.isArray(accounts)||typeof accounts[0]!=='string')throw new Error('No wallet account selected');setOwner(accounts[0]);}catch(e){setError(e instanceof Error?e.message:'Wallet connection cancelled');}finally{setBusy(false);}};
 const authorize=async(id:string)=>{setBusy(true);setError('');try{
  const provider=wallet();if(!provider)throw new Error('Open the web workspace in a browser with a wallet extension to authorize trading.');
  const prepared=await api.command({action:'prepare_authorization',id});const challenge=prepared.authorization;if(!challenge)throw new Error('Secure authorization unavailable');
  const accounts=await provider.request({method:'eth_requestAccounts'});if(!Array.isArray(accounts)||String(accounts[0]).toLowerCase()!==challenge.owner.toLowerCase())throw new Error('Select the main wallet used by this connection and retry.');
  await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0xa4b1'}]});
  const signature=await provider.request({method:'eth_signTypedData_v4',params:[challenge.owner,JSON.stringify(challenge.typedData)]});if(typeof signature!=='string')throw new Error('Wallet did not return a signature');
  const next=await api.command({action:'complete_authorization',id,signature});setView(next);
 }catch(e){setError(connectionError(e));}finally{setBusy(false);}};
 const [waiting,setWaiting]=useState<{id:string;checked?:string}>();
 useEffect(()=>{
  if(!waiting)return;
  let active=true; let timer:ReturnType<typeof setTimeout>; const deadline=Date.now()+600000;
  const poll=async()=>{try{const next=await api.command({action:'list'});if(!active)return;setView(next);const item=next.connections.find(c=>c.id===waiting.id);if(item?.permission==='trading-authorized'&&item.authorizationCheckedAt!==waiting.checked){setWaiting(undefined);return;}}catch{/* Retry while signing. */}if(active){if(Date.now()>=deadline){setWaiting(undefined);setError('Signing session expired. Click Authorize trading to try again.');}else timer=setTimeout(poll,1500);}};
  void poll(); return()=>{active=false;clearTimeout(timer);};
 },[api,waiting]);
 const openApproval=async(id:string)=>{setBusy(true);setError('');try{await api.command({action:'open_wallet_browser',id});setWaiting({id,checked:view.connections.find(c=>c.id===id)?.authorizationCheckedAt});}catch(e){setError(connectionError(e));}finally{setBusy(false);}};
 const adapter=view.adapters.find(item=>item.id===adapterId);
 return <section className="page-container settings-shell connections-page"><header className="backtest-toolbar"><div><h1>Connections</h1><p>Manage your exchange accounts.</p></div><Button size="base" variant="primary" icon={PlugsConnectedIcon} disabled={busy||!view.adapters.length} onClick={()=>setAdding(!adding)}>{adding?'Close setup':'Add connection'}</Button></header>
 {adding&&!wallet()&&<Banner variant="default" title="Use a browser wallet" description="Wallet approval requires a browser extension. Open the local web workspace in your wallet browser, then return here and check authorization."/>}
 {adding&&!wallet()&&<Button size="base" variant="secondary" disabled={busy} onClick={()=>void run({action:'open_wallet_browser'})}>Open wallet browser</Button>}
 {waiting&&<Banner variant="default" title="Waiting for wallet approval" description="Approve in your browser. This window updates automatically; no bot starts until you deploy it."/>}
 {error&&<Banner variant="error" title="Connection needs attention" description={error}/>}
 {error&&<Button size="base" variant="secondary" disabled={busy} onClick={()=>void run({action:'list'})}>Reload connections</Button>}
 {adding&&<LayerCard className="settings-card provider-connections"><h2>Add a connection</h2><p>Choose the platform and environment. Only installed adapters appear here.</p><Select size="base" label="Platform" renderValue={value=>view.adapters.find(item=>item.id===value)?.name??String(value)} value={adapterId} disabled={busy} onValueChange={value=>{setAdapter(String(value));setEnvironment(view.adapters.find(item=>item.id===value)?.environments[0]??'production');setOwner('');}}>{view.adapters.map(item=><Select.Option key={item.id} value={item.id}>{item.name}</Select.Option>)}</Select><Select size="base" label="Environment" renderValue={value=>value==='production'?'Production':'Testnet'} value={environment} disabled={busy} onValueChange={value=>setEnvironment(value as typeof environment)}>{adapter?.environments.map(value=><Select.Option key={value} value={value}>{value==='production'?'Production':'Testnet'}</Select.Option>)}</Select>
 {adapter?.authentication.includes('wallet')&&<Button size="base" variant="secondary" disabled={busy} onClick={()=>void connectWallet()}>Connect wallet</Button>}
 <Input size="base" label="Connection name" placeholder="Personal trading" value={name} disabled={busy} onChange={event=>setName(event.target.value)}/>
 {adapter?.authentication.includes('public-address')&&<><Input size="base" label="Main account public address" placeholder="0x…" value={owner} disabled={busy} onChange={event=>setOwner(event.target.value)}/><Banner variant="default" title="View only" description="This reads public account data. It does not verify wallet ownership or authorize trades. Never enter a private key or seed phrase."/><Button size="base" variant="primary" disabled={busy||!owner.trim()||!name.trim()} loading={busy} onClick={()=>void run({action:'connect',adapterId,name,environment,owner})}>Discover and save accounts</Button></>}
 </LayerCard>}
 {busy&&<p role="status">Loading account data…</p>}
 {!busy&&!adding&&!view.connections.length&&!error&&<LayerCard className="backtest-empty"><PlugsConnectedIcon size={32}/><h2>No exchange connections</h2><p>Add a connection to discover main accounts and subaccounts.</p></LayerCard>}
 {view.connections.map(connection=><LayerCard key={connection.id} className="connection-card">
  <header className="connection-card-header"><div><h2>{connection.name}</h2><div className="connection-meta"><span>{view.adapters.find(item=>item.id===connection.adapterId)?.name??connection.adapterId}</span><Badge variant="secondary">{connection.environment==='production'?'Mainnet':'Testnet'}</Badge><Badge variant={connection.permission==='trading-authorized'?'success':'secondary'}>{connection.permission==='trading-authorized'?'Authorized':'View only'}</Badge></div></div><Button size="sm" variant="secondary" icon={ArrowClockwiseIcon} disabled={busy} onClick={()=>void run({action:'refresh',id:connection.id})}>Refresh</Button></header>
  <div className="backtest-table-scroll"><Table aria-label={`${connection.name} accounts`}><Table.Header><Table.Row>{['Account','Address','USDC balance','Perp equity','Positions'].map(label=><Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header><Table.Body>{connection.accounts.map(account=><Table.Row key={account.id}><Table.Cell><strong>{account.name}</strong>{account.kind!=='main'&&<Badge variant="secondary">{account.kind}</Badge>}</Table.Cell><Table.Cell><div className="connection-address"><span title={account.address}>{account.address.slice(0,6)}…{account.address.slice(-4)}</span><Button size="sm" variant="ghost" icon={CopyIcon} aria-label={`Copy address for ${account.name}`} onClick={()=>void navigator.clipboard.writeText(account.address).catch(()=>setError('Could not copy address.'))}/></div></Table.Cell><Table.Cell>{account.usdcBalance===undefined?'—':<span title={`${account.usdcBalance} USDC`}>{Number(account.usdcBalance).toLocaleString(undefined,{maximumFractionDigits:8})} USDC</span>}<div className="backtest-muted">{account.accountMode==='unifiedAccount'?'Unified':account.accountMode==='portfolioMargin'?'Portfolio':'Spot'}</div></Table.Cell><Table.Cell>{account.accountMode==='unifiedAccount'||account.accountMode==='portfolioMargin'?<span title="Collateral is shared with the USDC balance">Shared</span>:usd(account.equity)}</Table.Cell><Table.Cell>{account.positions}</Table.Cell></Table.Row>)}</Table.Body></Table></div>
  <Collapsible.Root><div className="connection-card-footer"><span className="backtest-muted" title={new Date(connection.updatedAt).toLocaleString()}>Snapshot · {new Date(connection.updatedAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span><Collapsible.Trigger render={<Button size="sm" variant="ghost" icon={CaretDownIcon}/>}>Manage connection</Collapsible.Trigger></div><Collapsible.Panel className="connection-management">
   <dl className="connection-details"><div><dt>Main wallet</dt><dd className="package-integrity">{connection.owner}</dd></div><div><dt>Authorization checked</dt><dd>{connection.authorizationCheckedAt?new Date(connection.authorizationCheckedAt).toLocaleString():'Not checked'}</dd></div></dl>
   <p className="backtest-muted">API wallet approval lasts 30 days and may cover all subaccounts. Renewal uses a new key after verification; revoke previous approvals on Hyperliquid. Choose the account and start a supported workflow from its Deploy tab.</p>

   <div className="provider-actions"><Button size="base" variant={connection.permission==='trading-authorized'?'secondary':'primary'} disabled={busy} onClick={()=>void (wallet()?authorize(connection.id):openApproval(connection.id))}>{connection.permission==='trading-authorized'?'Renew authorization':'Authorize trading'}</Button><Button size="base" variant="secondary" disabled={busy} onClick={()=>void run({action:'verify_authorization',id:connection.id})}>Check authorization</Button></div>
   <div className="connection-remove"><p className="backtest-muted">Removes this saved view only. Exchange permissions and bots remain unchanged.</p><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run({action:'remove',id:connection.id})}>Remove connection</Button></div>
  </Collapsible.Panel></Collapsible.Root>
 </LayerCard>)}
 </section>;
}
