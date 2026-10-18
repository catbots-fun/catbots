import { useEffect, useRef, useState } from 'react';
import { Banner, Button } from '@cloudflare/kumo';
import type { CatbotsDesktopApi, FlowAuditSummary } from '@catbots/contracts';
import { collectAuditExport, downloadAudit, readAuditSummary } from './audit-export';

export function AuditExportControls({ botId, api }: { botId: string; api?: CatbotsDesktopApi['connections'] }) {
  const request = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState<'summary' | 'export' | null>(null);
  const [summary, setSummary] = useState<FlowAuditSummary>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setBusy(null); setSummary(undefined); setError(''); setNotice('');
    return () => { request.current?.abort(); request.current = undefined; };
  }, [api, botId]);

  const run = async (operation: 'summary' | 'export') => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(operation); setError(''); setNotice('');
    try {
      if (!api) throw new Error('UNAVAILABLE');
      if (operation === 'summary') {
        const result = await readAuditSummary(api, botId);
        controller.signal.throwIfAborted(); setSummary(result);
      } else {
        const result = await collectAuditExport(api, botId, controller.signal);
        controller.signal.throwIfAborted();
        downloadAudit(result.blob, botId, result.summary.through);
        setSummary(result.summary); setNotice('Download initiated. Check your downloads; no audit records were deleted.');
      }
    } catch {
      if (!controller.signal.aborted) setError(operation === 'export' ? 'Export unavailable' : 'Storage summary unavailable');
    } finally {
      if (request.current === controller) { request.current = undefined; setBusy(null); }
    }
  };
  return <section aria-label="Audit storage and export">
    <p className="backtest-muted">Retention: keep all events. No automatic deletion. Export contains private trading data; review it before sharing.</p>
    {summary && <p>{summary.count.toLocaleString()} events for this bot · {(summary.databaseBytes / 1024 / 1024).toFixed(2)} MiB shared audit database (all bots). Snapshot through #{summary.through}.</p>}
    <div className="execution-log-toolbar">
      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('summary')}>Inspect storage</Button>
      <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run('export')}>Export JSONL</Button>
      {busy === 'export' && <Button size="sm" variant="ghost" onClick={() => {
        request.current?.abort(); request.current = undefined; setBusy(null); setNotice('Export cancelled.');
      }}>Cancel export</Button>}
    </div>
    <p className="backtest-muted">Up to 50,000 events / 25 MiB per export. Snapshot excludes later events; export does not replace a workspace backup.</p>
    {busy && <p role="status">{busy === 'export' ? 'Preparing export…' : 'Reading storage…'}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <Banner variant="error" title={error} description="Could not complete the request. Check local storage and app support, then retry. Exports must fit the limits above; incomplete files are not downloaded."/>}
  </section>;
}
