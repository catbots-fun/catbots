# Audit snapshot export and retention visibility

**Goal:** Let users export bot audit evidence and understand local retention without deleting trading history (#14).
**Architecture:** Read-only summary reports per-bot count/high-water sequence and shared database size. Existing paginated command gains an optional upper sequence bound. Renderer builds a bounded NDJSON snapshot with manifest, refuses incomplete/oversized exports, and initiates a local download only after successful completion. Cancellation prevents stale-bot downloads.
**Tech Stack:** TypeScript, SQLite, React/Kumo, Vitest.
**Spec:** docs/execution-audit.md; #14 retention/redaction acceptance.

## Global Constraints
- Retain all records, no automatic pruning or deletion. No live trades or runtime restarts.
- Snapshot fixes upper sequence; later appends are excluded. Export is bot-scoped, redacted as stored and not a backup of recovery state.
- Maximum 25 MiB serialized export and 50,000 records; failures never download a partial file. Manifest identifies count and sequence boundary. Larger journals require a future streaming export.
- No arbitrary filesystem paths across IPC. Browser/Electron download behavior stays under user control; do not claim file saved merely because download initiated.
- React/Kumo English UI, explicit loading/error/cancel states.

## Review Focus
Bot isolation, new appends during export, cancellation and stale UI responses, memory bounds, incomplete pages and unsupported transports, retention clarity, and escaping sensitive data boundaries.

### Task 1: Snapshot export
**Interfaces:** get_flow_audit_summary -> auditSummary {count,through,databaseBytes,retention:'keep_all'}; get_flow_audit optional through; bounded renderer export helper and summary/export controls.
1. RED tests for bot-specific snapshot summaries, upper-bound pages and export completeness/cancellation/limits.
2. Implement contracts/store/command and renderer helper. Expected: targeted tests GREEN.
3. Add UI tests RED then implement storage/export controls. Expected: tests GREEN.
4. Document retention and download/privacy limitations; run full tests and typecheck. Expected: pass.
5. Commit; fresh review; fix Important/Critical findings with RED/GREEN. Push/open PR, keep broader readiness issues open.
