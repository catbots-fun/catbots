import type { CatbotsDesktopApi, FlowAuditSummary } from '@catbots/contracts';

type Api = NonNullable<CatbotsDesktopApi['connections']>;
const maxBytes = 25 * 1024 * 1024;
const maxRecords = 50000;
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;

export async function readAuditSummary(api: Api, botId: string): Promise<FlowAuditSummary> {
  const { auditSummary: summary } = await api.command({ action: 'get_flow_audit_summary', botId });
  if (!summary || !integer(summary.count) || !integer(summary.through) || !integer(summary.databaseBytes)
    || summary.count > summary.through || (summary.count === 0) !== (summary.through === 0)
    || summary.retention !== 'keep_all') throw new Error('AUDIT_SUMMARY_UNAVAILABLE');
  return summary;
}

/** Read a fixed high-water snapshot; never return a partial or mixed-bot export. */
export async function collectAuditExport(api: Api, botId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const summary = await readAuditSummary(api, botId);
  signal.throwIfAborted();
  if (summary.count > maxRecords) throw new Error('AUDIT_EXPORT_TOO_LARGE');
  const parts: string[] = [];
  let bytes = 0, count = 0, after = 0;
  const append = (value: unknown) => {
    const text = JSON.stringify(value) + '\n';
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > maxBytes) throw new Error('AUDIT_EXPORT_TOO_LARGE');
    parts.push(text);
  };
  append({ type: 'manifest', format: 'catbots-audit-v1', botId, count: summary.count,
    through: summary.through, exportedAt: new Date().toISOString(), retention: summary.retention,
    notice: 'Stored audit evidence only; not a recovery backup. Missing evidence does not prove no trade occurred. Review private trading data before sharing.' });
  while (count < summary.count) {
    signal.throwIfAborted();
    const { auditPage: page } = await api.command({ action: 'get_flow_audit', botId, after, through: summary.through, limit: 20 });
    signal.throwIfAborted();
    if (!page || !Array.isArray(page.records) || page.records.length === 0 || page.records.length > 20) throw new Error('AUDIT_EXPORT_INCOMPLETE');
    for (const record of page.records) {
      if (record.botId !== botId || !integer(record.sequence) || record.sequence <= after || record.sequence > summary.through) throw new Error('AUDIT_EXPORT_INCOMPLETE');
      append({ type: 'event', ...record });
      after = record.sequence;
      count++;
    }
    if (count > summary.count || (count < summary.count && page.nextAfter !== after)
      || (count === summary.count && (page.nextAfter !== undefined || after !== summary.through))) throw new Error('AUDIT_EXPORT_INCOMPLETE');
  }
  append({ type: 'end', count, through: summary.through });
  signal.throwIfAborted();
  return { summary, blob: new Blob(parts, { type: 'application/x-ndjson;charset=utf-8' }) };
}

export function downloadAudit(blob: Blob, botId: string, through: number) {
  const url = URL.createObjectURL(blob);
  const revoke = URL.revokeObjectURL.bind(URL);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `catbots-audit-${botId.replace(/[^a-zA-Z0-9-]/g, '_')}-through-${through}.jsonl`;
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    // Allow the browser to consume the URL before releasing the bounded buffer.
    setTimeout(() => revoke(url), 1000);
  }
}
