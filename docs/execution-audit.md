# Execution audit journal

Tracking: [#14](https://github.com/catbots-fun/catbots/issues/14), [readiness roadmap #22](https://github.com/catbots-fun/catbots/issues/22).

New flow evaluations are stored in `<runtime-state-path>.audit.sqlite`, separately from the recoverable runtime state. An append-only SQLite table stores timestamped, monotonically sequenced records scoped to bot, deployment and flow version. Each operation closes its database handle; synchronous FULL writes and private file permissions are used.

The runtime records:

- Signal and risk evaluations, including node trace and proposed orders even when no order is produced.
- Guard-approved order intent with deterministic client-order correlation before dispatch.
- Confirmed fill or cancellation after recovery state is saved and mandatory native protection handling has run. A logging failure must not bypass protection of confirmed inventory.
- Runtime failure, best-effort when storage itself is unavailable.
- Lifecycle: started/resumed before scheduling, stop requested and stop completed (including final status and unresolved client-order ID), and restart interruption after recovery state is saved. Reopening an already interrupted deployment does not create another interruption event.
- Reconciliation: requested, completed or failed, with the pending client-order ID and confirmed fill/cancellation when available. Unresolved results preserve pending state and never authorize a resend.
- Native protection: persisted plan/submission/confirmation/retirement transitions, synchronized state, native fill correlation, and failures. Unchanged polling does not generate new protection events. These records describe the existing native protection implementation; they do not add native protection capability to another adapter.

An evaluation/intent write failure stops execution before a new order is sent. An outcome write failure stops subsequent execution while retaining the existing recovery journal. Audit records never authorize retries. A crash between the separate recovery-state and audit transactions can leave an intent without an outcome: reconciliation remains authoritative, not an inference from missing audit evidence.

A start/resume audit write failure prevents scheduling and leaves a failed deployment. By contrast, stop, restart recovery, reconciliation and mandatory native protection use best-effort audit writes: an audit error cannot abort those safety operations. Recovery state is persisted before protection transition logging. If audit persistence fails, the deployment keeps a sanitized `auditWarning`, shown separately from financial errors in Logs/Performance. The warning is sticky for that deployment; a later successful write does not repair missing evidence. If recovery-state persistence is also unavailable, the warning remains in memory only. There is no atomic transaction across runtime JSON, SQLite and the exchange; process loss can still leave an evidence gap.

Sensitive field names, bearer strings and long hexadecimal values in payloads are redacted recursively. Only explicit event fields are copied, not venue credentials or full connection contexts. Redaction is defense in depth, not a guarantee that arbitrary user content cannot contain a secret. Treat the database as private; do not publish it unreviewed. This is not tamper-proof storage against local filesystem access.

Open a bot's **Execution logs → Audit history · All runs** to browse stored events, oldest first. Each event includes its timestamp, kind, flow version, run ID and expandable JSON evidence. This panel is independent of the selected runtime snapshot, so older journal evidence remains accessible even when a run is absent from that snapshot. Previous/next controls navigate cursor pages; refresh reloads the current page to discover new events. The existing latest-evaluation and order views remain below it.

`get_flow_audit` uses the existing validated connections command for desktop IPC and the authenticated local web transport. It accepts a bot UUID, nonnegative safe-integer `after` cursor (default 0), and `limit` from 1 to 50 (default 20). It returns `auditPage.records` and `nextAfter` only when another page exists. Read-only evidence remains available when execution capabilities are disabled; reading it never contacts an exchange. Older/simulated transports without this command report unavailable, not an empty journal.

`FlowRunner.auditHistory(botId, afterSequence, limit, throughSequence?)` remains the internal ascending-page API (maximum 100 records). The public `get_flow_audit` command also accepts optional `through` (inclusive) for fixed snapshots. The UI has no global search yet. Missing events are not proof that no execution occurred, and a blank journal does not reconstruct pre-audit history.

## Retention and export

The retention policy is **keep all events; no automatic deletion**. There is no pruning command or delete button. **Inspect storage** in Audit history shows this bot's stored event count and the shared SQLite database file size across all bots (not total workspace disk usage). Counts are a snapshot at inspection time. Refresh by inspecting again. Plan disk capacity: at 1m evaluation frequency the journal can grow continuously; a full disk stops new orders when required writes fail.

**Export JSONL** reads a new bot-scoped snapshot, fixes its highest sequence, and downloads UTF-8 newline-delimited JSON. The first line is a `catbots-audit-v1` manifest with bot ID, expected count, upper sequence and export timestamp. Event lines retain run/version/sequence/timestamp and stored redacted details. The final `end` line identifies the completed count and boundary. Later appended events are excluded. An in-flight order can therefore have an intent but no outcome in this snapshot; this is evidence, not a recovery instruction.

Exports are limited to **50,000 events and 25 MiB serialized data** to bound renderer memory. Unsupported transport, missing/invalid pages, wrong-bot records, size overflow or cancellation do not download a partial export. Cancellation stops further paging; an already dispatched read may finish but its result is ignored. Larger archives need a future streaming export. Download initiation does not confirm a file was saved: check the browser/Electron download destination. Export does not delete any records or reduce database size.

Exported files may contain private account/trading information. Stored redaction remains defense in depth; review exports before sharing. A JSONL snapshot is **not** a backup of recovery state, configuration or credentials, nor is its manifest a cryptographic integrity proof. Keep an offline backup of the whole stopped workspace for recovery. Do not manually edit or prune an active journal.

`get_flow_audit_summary` is a read-only command returning `auditSummary` with bot-scoped `count`/`through`, shared `databaseBytes` and `retention: 'keep_all'`. It uses the same authenticated local web/desktop boundary as history and works with execution disabled.

Events larger than 1 MiB fail explicitly rather than silently losing evidence. User-configurable archival/pruning and streaming export remain follow-up work. Existing overwritten traces cannot be reconstructed retrospectively. Preflight failures before a deployment exists are not deployment lifecycle records.
