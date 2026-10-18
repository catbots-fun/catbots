import { useEffect, useId, useState } from 'react';
import { Badge, Banner, Button, CodeBlock, LayerCard } from '@cloudflare/kumo';
import type { CatbotsDesktopApi, FlowAuditPage, FlowAuditRecord } from '@catbots/contracts';
import { AuditExportControls } from './AuditExportControls';

const labels: Record<FlowAuditRecord['kind'], string> = {
  evaluation: 'Evaluation', order_intent: 'Order intent', order_outcome: 'Order outcome', failure: 'Failure',
  lifecycle: 'Lifecycle', reconciliation: 'Reconciliation', protection: 'Protection',
};

function AuditEntry({ record }: { record: FlowAuditRecord }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div>
    <Button size="base" variant="ghost" className="execution-log-entry" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span>Event #{record.sequence}</span>
      <time dateTime={record.at} title={record.at}>{new Date(record.at).toLocaleString()}</time>
      <Badge variant={record.kind === 'failure' ? 'warning' : 'neutral'}>{labels[record.kind] ?? record.kind}</Badge>
      <span>v{record.version}</span>
      <span className="backtest-muted">{open ? 'Hide data' : 'View data'}</span>
    </Button>
    <div id={id} hidden={!open}>
      {open && <div className="execution-log-order">
        <p>Run ID: {record.deploymentId}</p>
        <CodeBlock lang="jsonc" code={JSON.stringify(record.details, null, 2) ?? 'null'}/>
      </div>}
    </div>
  </div>;
}

/** All runs for this bot, independent of the bounded recovery snapshot. */
export function FlowAuditPanel({ botId, api }: { botId: string; api?: CatbotsDesktopApi['connections'] }) {
  return <AuditHistory key={botId} botId={botId} api={api}/>;
}

function AuditHistory({ botId, api }: { botId: string; api?: CatbotsDesktopApi['connections'] }) {
  const [cursors, setCursors] = useState([0]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<FlowAuditPage>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const after = cursors[cursors.length - 1];

  useEffect(() => {
    let active = true;
    setLoading(true); setFailed(false); setPage(undefined);
    void (async () => {
      try {
        const result = await api?.command({ action: 'get_flow_audit', botId, after, limit: 20 });
        // An older/preview transport may not implement the journal command.
        if (!result?.auditPage) throw new Error('AUDIT_UNAVAILABLE');
        if (active) setPage(result.auditPage);
      } catch {
        if (active) setFailed(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [api, botId, after, revision]);

  return <LayerCard className="deploy-card execution-log-panel" aria-label="Audit history">
    <div className="deploy-runtime-heading">
      <h3>Audit history · All runs</h3>
      <Button size="sm" variant="secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh audit history</Button>
    </div>
    <p className="backtest-muted">Oldest first · Includes evaluations that produced no orders. Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
    <p className="backtest-muted">Only events recorded since audit logging was enabled are available. Missing records do not prove that no trade occurred.</p>
    <AuditExportControls botId={botId} api={api}/>
    {loading && <p role="status">Loading audit history…</p>}
    {failed && <>
      <Banner variant="error" title="Audit history unavailable" description="Could not read the local journal. Retry or check that your app supports audit history."/>
      <Button size="sm" variant="secondary" onClick={() => setRevision(value => value + 1)}>Retry audit history</Button>
    </>}
    {page && <>
      {page.records.length === 0 && <p role="status">No recorded audit events</p>}
      <div className="execution-log-entries">{page.records.map(record => <AuditEntry key={record.sequence} record={record}/>)}</div>
    </>}
    <div className="execution-log-toolbar">
      <Button variant="secondary" size="sm" disabled={loading || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>Previous page</Button>
      <span role="status">Page {cursors.length}</span>
      <Button variant="secondary" size="sm" disabled={loading || page?.nextAfter === undefined} onClick={() => {
        if (page?.nextAfter !== undefined) setCursors(value => [...value, page.nextAfter!]);
      }}>Next page</Button>
    </div>
  </LayerCard>;
}
