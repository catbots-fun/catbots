# Lighter Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the existing local Lighter adapter on current main as a reviewed prerequisite for issues #11, #12 and #13.

**Architecture:** Preserve the source worktree. Integrate PR #10 locally on a new branch, then port its uncommitted Lighter changes while retaining current audit, incident, pause and confirmed-close behavior. Route execution through adapter factories rather than hardcoded Hyperliquid construction.

**Tech Stack:** TypeScript, Electron, React, Vitest, pinned Lighter Go WASM signer.

**Spec:** User-authorized preservation and prerequisite integration; GitHub issues #11, #12 and #13 remain the completion authority. This foundation alone does not close them.

## Global Constraints

- Do not alter the source worktree or user data; do not start the application or send trades.
- No automatic merge, Mainnet enablement, or claim of native Lighter protection.
- Keep uncertain orders and account ownership locked until conclusive reconciliation.
- Use only fixed exchange hosts; never publish credentials, transaction payloads or private account evidence.
- Keep PR #10 open until its replacement is merged or the user chooses otherwise.

## Review Focus

- Adapter routing must include readiness, start, reconciliation and confirmed close.
- Concurrent account starts and unresolved deployments must not lose existing guards.
- Venue-specific credentials must not cross accounts, networks or IPC responses.
- Production execution must remain gated after enabling Testnet connections.
- Partial/ambiguous order evidence must never imply a confirmed fill or duplicate broadcast.

### Task 1: Preserve both dependency and current safety changes

**Files:** PR #10 changes in connection service, runner, lifecycle and packaging tests.
**Interfaces:** Preserve current `FlowRunner` audit/incident/control APIs and add PR #10 orphan-account guards.

- [ ] Merge PR #10 into the isolated branch only; resolve conflicting hunks preserving both intents.
- [ ] Run `pnpm typecheck` and `pnpm test`. Expected: no failures.
- [ ] Commit the dependency integration, without changing the remote PR branch.

### Task 2: Port and validate Lighter foundation

**Files:** Existing local `connections/lighter/`, signer assets, Lighter tests, adapter registry, connection service, contracts, app wiring, market data/backtest and connection UI changes.
**Interfaces:** `ExchangeAdapter.verify`, `createVenue`, `connectApiKey`; Lighter implements the existing `FlowVenue` contract, without native protection.

- [ ] Import existing tests and exercise the missing Lighter behavior on the integration baseline.
- [ ] Port source changes using patches; include existing local tests and license/hash-pinned assets without changing the source worktree.
- [ ] Add service regressions for adapter routing in confirmed close, account/DEX mismatch and Mainnet gating; observe failures before fixes.
- [ ] Verify all existing lifecycle controls, typed incidents and audit behavior remain intact; do not replace current runner with the old source version.
- [ ] Run `pnpm typecheck` and `pnpm test`. Expected: no failures; no network trades.
- [ ] Commit foundation and current-scope documentation without historical private account evidence.

### Task 3: Review and publish

**Files:** Foundation diff and issue/PR evidence.
**Interfaces:** PR against main explicitly includes the PR #10 prerequisite and does not close #11–#13.

- [ ] Request independent whole-branch review; fix important findings with regressions.
- [ ] Run final tests/typecheck/diff checks, push and open a PR; attach it to this task.
- [ ] Record the dependency and verification evidence on #11, leaving incomplete issues open.

## Subsequent delivery order

1. #11: implement verified native Lighter SL/TP, missing/partial-order recovery and crash/network/restart acceptance; maintain Mainnet gate.
2. #12: extend confirmed close to native-protected workflows without duplicate closes, keeping unresolved journals/account locks.
3. #13: persistent account loss/drawdown breakers, explicit reset, cost/stop-based sizing, exposure/margin and precision gates; allow reducing-risk exits.

Each requires a focused implementation plan and PR. Close only when all issue acceptance criteria have evidence; live Testnet verification requiring account access must be separately authorized.
