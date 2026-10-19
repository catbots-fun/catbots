# Confirmed Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explicit, deployment-bound Testnet directional close with durable uncertain-order recovery.
**Architecture:** Extend FlowRunner's journal and existing account/reconciliation guards; route one strict command through ConnectionsService and show a typed-confirmation control in Deploy. Reuse venue precision/reduce-only validation, not a second execution engine.
**Tech Stack:** TypeScript, React/Kumo, Vitest, existing local JSON recovery and SQLite audit.
**Spec:** `docs/confirmed-close.md`

## Global Constraints

- Directional Testnet only; no Mainnet/native-protected workflows.
- No live exchange requests or user-runtime restart during development.
- Keep current entry/stop/reconciliation behavior unless required for account serialization.
- No automatic resubmission or automatic merge.

## Review Focus

- Start preflight overlapping close must not acquire the account after close reserves it.
- Invalid/partial fill responses must not clear unresolved state or report flat.
- Stop waiting on a submitted entry must settle before close snapshots inventory.
- Snapshot failure after terminal fill must retain a recoverable close state.
- Duplicate/stale close confirmations must not resend or affect a replacement deployment.

### Task 1: Confirmed close end-to-end

**Files:** Modify `packages/contracts/src/connections.ts`, `apps/desktop/src/main/connections/flow-runner.ts`, `apps/desktop/src/main/connections/service.ts`, `apps/desktop/src/renderer/workbench/ExecutionTargetPanel.tsx`; create `apps/desktop/tests/confirmed-close.test.ts`; extend `apps/desktop/tests/entry-controls.test.tsx` and `docs/confirmed-close.md`.

**Interfaces:** `FlowRunner.closePosition(botId, deploymentId, confirmation, venue): Promise<FlowDeployment>`; command `close_flow_position` with UUID botId/deploymentId and confirmation string; view optional `closePositionSupported` and `closeResult` (`pending`, `needs-attention`, `closed`). Persist a manual-close marker; prohibit controller resume until verified flat, then create a new deployment.

- [ ] Write runtime tests: long/short full/partial close, wrong confirmation/stale ID, unresolved timeout/reopen/reconcile without resend, manual changes, malformed fill, concurrent start/close, delayed entry/stop and post-fill snapshot failure. Assert reduce-only sizing and durable ownership.
- [ ] Run focused tests; expected FAIL for absent closePosition before implementation.
- [ ] Implement reservation, stop/refresh/submit/recover sequencing in FlowRunner with intent-before-submit audit and persisted manual-close state.
- [ ] Add strict service command and typed UI confirmation; test no close before exact phrase and deployment-bound dispatch.
- [ ] Run focused tests; expected PASS. Run `pnpm test`, `pnpm typecheck`, `git diff --check`; expected all pass.
- [ ] Commit implementation and documentation. Whole-branch review, one verified fix pass if needed, then PR (no auto-merge).
