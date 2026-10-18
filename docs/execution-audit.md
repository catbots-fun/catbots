# Execution audit journal

Tracking: [#14](https://github.com/catbots-fun/catbots/issues/14), [readiness roadmap #22](https://github.com/catbots-fun/catbots/issues/22).

New flow evaluations are stored in `<runtime-state-path>.audit.sqlite`, separately from the recoverable runtime state. An append-only SQLite table stores timestamped, monotonically sequenced records scoped to bot, deployment and flow version. Each operation closes its database handle; synchronous FULL writes and private file permissions are used.

The runtime records:

- Signal and risk evaluations, including node trace and proposed orders even when no order is produced.
- Guard-approved order intent with deterministic client-order correlation before dispatch.
- Confirmed fill or cancellation after recovery state is saved and mandatory native protection handling has run. A logging failure must not bypass protection of confirmed inventory.
- Runtime failure, best-effort when storage itself is unavailable.

An evaluation/intent write failure stops execution before a new order is sent. An outcome write failure stops subsequent execution while retaining the existing recovery journal. Audit records never authorize retries. A crash between the separate recovery-state and audit transactions can leave an intent without an outcome: reconciliation remains authoritative, not an inference from missing audit evidence.

Sensitive field names, bearer strings and long hexadecimal values in payloads are redacted recursively. Only explicit event fields are copied, not venue credentials or full connection contexts. Redaction is defense in depth, not a guarantee that arbitrary user content cannot contain a secret. Treat the database as private; do not publish it unreviewed. This is not tamper-proof storage against local filesystem access.

Open a bot's **Execution logs → Audit history · All runs** to browse stored events, oldest first. Each event includes its timestamp, kind, flow version, run ID and expandable JSON evidence. This panel is independent of the selected runtime snapshot, so older journal evidence remains accessible even when a run is absent from that snapshot. Previous/next controls navigate cursor pages; refresh reloads the current page to discover new events. The existing latest-evaluation and order views remain below it.

`get_flow_audit` uses the existing validated connections command for desktop IPC and the authenticated local web transport. It accepts a bot UUID, nonnegative safe-integer `after` cursor (default 0), and `limit` from 1 to 50 (default 20). It returns `auditPage.records` and `nextAfter` only when another page exists. Read-only evidence remains available when execution capabilities are disabled; reading it never contacts an exchange. Older/simulated transports without this command report unavailable, not an empty journal.

`FlowRunner.auditHistory(botId, afterSequence, limit)` remains the internal ascending-page API (maximum 100 records). The UI has no global search or export yet. Missing events are not proof that no execution occurred, and a blank journal does not reconstruct pre-audit history.

Events larger than 1 MiB fail explicitly rather than silently losing evidence. No automatic pruning is performed: plan storage capacity and preserve an offline backup before any manual retention procedure. User-managed retention/export and readable lifecycle history (including recovery/protection events) remain follow-up work under #14. Existing overwritten traces cannot be reconstructed retrospectively.
