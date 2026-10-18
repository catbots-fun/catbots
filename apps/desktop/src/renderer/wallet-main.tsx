import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Banner, Button, LayerCard } from '@cloudflare/kumo';
import '@cloudflare/kumo/styles/standalone';
import './app.css';
type Challenge = { owner: string; environment: string; typedData: unknown };
async function rpc(method: string, input?: string) {
  const response = await fetch('/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'x-catbots-client': '1' }, body: JSON.stringify({ method, input }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Authorization failed');
  return value.result;
}
function WalletApproval() {
  const [challenge, setChallenge] = useState<Challenge>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => { void (async () => {
    try {
      const session = await fetch('/api/session', { headers: { 'x-catbots-client': '1' } });
      if (!session.ok) throw new Error('Signing session unavailable');
      const result = await rpc('wallet:challenge'); setChallenge(result.challenge); setDone(result.completed);
    } catch { setError('This signing session has ended. Return to Catbots and authorize again.'); }
  })(); }, []);
  async function sign() {
    if (!challenge) return;
    setBusy(true); setError('');
    try {
      const provider = (window as unknown as { ethereum?: { request(input: {method: string; params?: unknown[]}): Promise<unknown> } }).ethereum;
      if (!provider) throw new Error('Open this page in a browser with your wallet extension.');
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== challenge.owner.toLowerCase()) throw new Error('Select the main wallet shown above, then retry.');
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{chainId: '0xa4b1'}] });
      const signature = await provider.request({ method: 'eth_signTypedData_v4', params: [challenge.owner, JSON.stringify(challenge.typedData)] });
      if (typeof signature !== 'string') throw new Error('Wallet did not return a signature.');
      await rpc('wallet:complete', signature); setDone(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Signing cancelled. Retry when ready.'); }
    finally { setBusy(false); }
  }
  return <main className="page-container settings-shell"><LayerCard className="settings-card">
    <h1>{done ? 'Trading authorized' : 'Authorize Catbots'}</h1>
    {done ? <Banner variant="default" title="Return to Desktop" description="Catbots has received the approval. You can close this tab. No bot was started."/> : <>
      <p>{challenge?.environment === 'production' ? 'Mainnet · Real funds' : 'Testnet · Test funds'}</p>
      <p>Main wallet: {challenge?.owner ?? 'Loading…'}</p>
      <p>Approve an API wallet for 30 days. Permission may cover this wallet’s subaccounts. This does not start a bot.</p>
      <Button variant="primary" disabled={!challenge || busy} loading={busy} onClick={() => void sign()}>Approve in wallet</Button>
    </>}
    {error && <Banner variant="error" title="Authorization not completed" description={error}/>}
  </LayerCard></main>;
}
createRoot(document.getElementById('root')!).render(<WalletApproval/>);
