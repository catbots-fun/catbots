# Execution history browser

**Goal:** Expose the durable journal from #23 in Execution logs, including evidence from runs no longer present in the recovery snapshot.
**Architecture:** Bot-scoped, ascending cursor pages through the existing connections command boundary; a separate read-only React/Kumo history panel. No exchange calls or execution changes.
**Tech Stack:** TypeScript, Zod, React, Kumo, SQLite, Vitest.
**Spec:** Issue #14 and docs/execution-audit.md.

## Global Constraints

- English UI, existing React/Kumo components. No live trades, restart, pruning, or secret access.
- Never treat missing evidence as proof that no execution occurred.
- Explicit loading, empty, error/retry, previous/next and refresh behavior; stale responses cannot cross bots/pages.
- Lifecycle logging, retention and export remain separate work under #14.

## Review Focus

Read-only boundary validation, bot isolation, pagination gaps, async stale responses, compatibility with older web preview APIs, and access when runtime snapshots are absent.

### Task 1: Expose and browse audit history

**Interfaces:** contracts exports FlowAuditRecord and FlowAuditPage; get_flow_audit accepts botId, after (default 0), limit (default 20, max 50). Page returns records and nextAfter only when more records exist. Renderer consumes this contract without main-process imports.

1. Add tests for service bot isolation, cursor pages, empty history, invalid requests and redaction. Add UI tests for navigation, retry and bot-change race, and history without runtime snapshots.
2. Run targeted tests. Expected: new behaviors fail before implementation.
3. Implement shared contracts, service dispatch and history panel. Keep legacy latest-evaluation inspection intact.
4. Run targeted tests and root typecheck. Expected: pass.
5. Document scope, run root test suite, commit. Expected: suite green.
6. Fresh whole-branch review; fix important findings with RED/GREEN; push branch and open PR referencing #14 without closing it.
