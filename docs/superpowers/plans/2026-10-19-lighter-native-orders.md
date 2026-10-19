# Lighter Native Order Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the native SL/TP order transport and evidence checks needed by issue #11, without prematurely enabling protected runtime entry.

**Architecture:** Extend the pinned WASM signer with reduce-only trigger and individual cancellation operations. Add a separate Lighter protection venue that uses the existing order reconciliation for terminal fills. Keep the production adapter capability disabled until runtime fault/acceptance work is complete.

**Tech Stack:** Existing TypeScript, Zod, Vitest, pinned Lighter Go WASM.

**Spec:** GitHub catbots-fun/catbots issue #11. This is its transport increment, not full acceptance; native runtime activation and authenticated Testnet crash/restart acceptance remain subsequent work.

## Global Constraints

- No user credentials, live trades, automatic merge, Mainnet activation or source-worktree edits.
- Journal ownership remains with the existing protection orchestrator. Never resend an unknown creation; a missing order is unknown, not cancelled.
- Keep the existing Kumo UI and current adapter runtime capability unchanged.
- English code/docs and PR; independent final review and full workspace tests.

## Review Focus

- Wrong account/market/side/type/reduce-only/size/trigger or saved exchange identity must never be accepted as protection.
- Filled and cancelled-partial orders require existing base/quote/trade evidence.
- Transport errors after submission must remain unresolved, with no automatic resubmission.
- Cancellation must verify identity before sending and terminal no-fill evidence afterward.
- Precision loss, expiry and unsafe integer identifiers must fail closed before signing.

### Task 1: Signed protection commands

**Files:** `connections/lighter/signer.ts`, `tests/lighter-signer.test.ts`.
**Interfaces:** New `LighterProtectionSignerPort` extends `LighterSignerPort` with `signProtection({market,clientIndex,amount,price,sell,nonce,kind,triggerPrice,expiresAt})` and `signCancel({market,orderIndex,nonce})`, returning signed transaction strings. The base interface is unchanged.

- [ ] Add local WASM tests for SL/TP type 2/4, IOC, reduce-only, expiry, account/key/nonce, cancellation identity and rejection of invalid wire values.
- [ ] Run signer tests; expect failure because methods do not exist.
- [ ] Implement wrappers using the pinned upstream WASM signatures; validate safe numeric and integer-string bounds before calling WASM.
- [ ] Run signer tests and typecheck; expect pass, no network.
- [ ] Commit.

### Task 2: Verified protection venue

**Files:** Create `connections/lighter/protection.ts` and `tests/lighter-protection.test.ts`; update `docs/lighter.md`.
**Interfaces:** `LighterProtectionVenue implements ProtectionVenue`, constructed with client, protection signer, credentials, target and existing terminal-fill reconciler. Not exposed as runtime capability yet.

- [ ] Add tests for SL/TP submit, exact identity validation, missing/duplicate responses, unknown submission, terminal partial fill, cancellation and fill/cancel races; synthetic HTTP only.
- [ ] Run protection tests; expect missing implementation failure.
- [ ] Implement fixed-endpoint order inspection, exact wire precision, one-shot submission and verified cancellation. Recover using persisted client identity; do not create on inspect.
- [ ] Add integration tests with `installProtection`: journal unknown before send, resume without duplicate broadcast, reject protection mismatch, retain ambiguous cancellation.
- [ ] Run focused and full workspace tests, typecheck and diff checks. Expected all pass.
- [ ] Document disabled activation and remaining acceptance; commit.

### Task 3: Review and publish

**Files:** Whole branch, issue #11 evidence.
**Interfaces:** PR against main; no automatic issue closure.

- [ ] Independent final review; fix important findings with RED→GREEN tests.
- [ ] Run final `pnpm test` and `pnpm typecheck`; expect pass.
- [ ] Push and open/attach PR; update #11 with exact scope and remaining runtime/live acceptance. Keep #11 open.
