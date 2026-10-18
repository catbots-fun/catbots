# Execution audit journal (backend foundation)

Tracking: [#14](https://github.com/catbots-fun/catbots/issues/14), [readiness roadmap #22](https://github.com/catbots-fun/catbots/issues/22).

New flow evaluations are stored in `<runtime-state-path>.audit.sqlite`, separately from the recoverable runtime state. An append-only SQLite table stores timestamped, monotonically sequenced records scoped to bot, deployment and flow version. Each operation closes its database handle; synchronous FULL writes and private file permissions are used.

The runtime records:

- Signal and risk evaluations, including node trace and proposed orders even when no order is produced.
- Guard-approved order intent with deterministic client-order correlation before dispatch.
- Confirmed fill or cancellation after recovery state is saved.
- Runtime failure, best-effort when storage itself is unavailable.

An evaluation/intent write failure stops execution before a new order is sent. An outcome write failure stops subsequent execution while retaining the existing recovery journal. Audit records never authorize retries. A crash between the separate recovery-state and audit transactions can leave an intent without an outcome: reconciliation remains authoritative, not an inference from missing audit evidence.

Sensitive field names, bearer strings and long hexadecimal values in payloads are redacted recursively. Only explicit event fields are copied, not venue credentials or full connection contexts. Redaction is defense in depth, not a guarantee that arbitrary user content cannot contain a secret. Treat the database as private; do not publish it unreviewed. This is not tamper-proof storage against local filesystem access.

`FlowRunner.auditHistory(botId, afterSequence, limit)` supports ascending pages of at most 100 events. This PR does not expose that method through IPC or add a history browser. Existing UI still shows the latest evaluation. Those changes remain in #14.

Events larger than 1 MiB fail explicitly rather than silently losing evidence. No automatic pruning is performed: plan storage capacity and preserve an offline backup before any manual retention procedure. User-managed retention/export, readable lifecycle history (including recovery/protection events), and history UI remain follow-up work. Existing overwritten traces cannot be reconstructed retrospectively.
