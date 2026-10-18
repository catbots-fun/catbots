# Trading Audit Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver the durable runtime foundation of issue #14 without claiming its history UI is complete.

**Architecture:** Add a separate local SQLite append-only event store beside the existing runtime state. Persist evaluations before dispatch and order intent/outcome events around submission; keep recovery state and existing latest-view behavior unchanged. Open/close each database operation, use FULL synchronous transactions, and fail closed before submission when audit persistence fails.

**Tech Stack:** TypeScript, existing better-sqlite3, Vitest; Node 22.

**Spec:** https://github.com/catbots-fun/catbots/issues/14 (incremental backend PR); parent https://github.com/catbots-fun/catbots/issues/22.

## Global Constraints

- No Mainnet trades, app restarts, existing runtime data modifications, or unrelated dirty-worktree changes.
- Keep #14 open: renderer history browsing, IPC wiring and user-managed retention remain a subsequent PR.
- Store only explicit runtime event fields, never credentials/context objects. Redact sensitive field names and recognized credential strings recursively; this is defense in depth, not a general secret detector.
- No automatic deletion of audit evidence. Database files are private (0600).

## Review Focus

- Audit persistence failure must prevent new order submission and stop the runtime.
- Reopening the store must retain earlier no-order and order evaluations.
- Pagination must isolate bots and reject invalid limits/cursors.
- Failed submissions must keep the existing uncertain-order journal, never retry.
- Nested sensitive values must not appear in persisted event payloads.

### Task 1: Durable event storage and runtime integration

**Files:** Create `apps/desktop/src/main/connections/flow-audit.ts`; modify `flow-runner.ts`; create `apps/desktop/tests/flow-audit.test.ts`; extend `flow-runner.test.ts`; document `docs/execution-audit.md`.

**Interfaces:** `FlowAuditStore.append(event: FlowAuditEvent): void` and `list(botId: string, after = 0, limit = 50)` return ascending sequence-tagged events. Event kinds: evaluation, order_intent, order_outcome, failure. Runner exposes `auditHistory(botId, after?, limit?)` internally, not over IPC in this slice.

- [ ] Add failing tests for durable immutable snapshots, bot-isolated pagination, input validation, nested redaction, and private file permissions.
- [ ] Add runner tests for multiple evaluations/reopen, no-order evaluations, intent/outcome correlation and no submission when journal path is unwritable.
- [ ] Run targeted Vitest tests and observe missing behavior fail.
- [ ] Implement store and runner hooks. Append evaluation before state commit/dispatch; append guarded intent before pending state/submission; append outcome after recovery state persistence. On failure append a safe failure event best-effort without masking the original recovery state.
- [ ] Run targeted tests, full `pnpm test`, `pnpm typecheck`, and `git diff --check`.
- [ ] Commit focused changes, perform fresh whole-branch review, fix important findings with RED/GREEN coverage, push feature branch and open PR referencing #14 and #22 without closing them.

## Delivery boundary

This records new events only; old overwritten traces cannot be reconstructed. No claim of forensic tamper-proof storage or native protection. No user data is published in the PR. The full issue also needs browsing/retention and additional lifecycle coverage before closure.
