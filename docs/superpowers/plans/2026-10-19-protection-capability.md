# Protection capability guard

**Goal:** Close the unsupported-protection runtime gap as a foundation for #11, without claiming Lighter native SL/TP support.
**Architecture:** Validate the concrete venue's submit/inspect/cancel protection operations before production DCA starts. Existing saved native protection always requires those operations on start/reconciliation, on either network. No exchange protocol changes.
**Tech Stack:** TypeScript, Vitest.
**Spec:** #11 supported/unsupported capability criterion; docs/execution-audit.md recovery authority.

## Global Constraints
- Main currently contains Hyperliquid only; do not copy unmerged/dirty Lighter work or claim #11 complete.
- Preserve local Testnet DCA behavior without saved protection; directional Mainnet gate remains unchanged.
- No live trades or user runtime changes; no automatic merge.

## Review Focus
Missing/incomplete adapter methods, no exchange calls before rejection, saved protection recovery on Testnet, unchanged pending-order state and supported Hyperliquid/DCA behavior.

### Task 1: Enforce protection capability
**Interfaces:** shared validation at start and reconciliation boundaries, concrete protection interface rather than marketing capability flags.
1. RED tests: production DCA missing/partial capability rejected before snapshot; saved native protection cannot resume/reconcile through a venue without protection.
2. Add minimal guard; existing Testnet and supported native tests remain GREEN.
3. Document limits; full test/typecheck; commit. Expected: pass.
4. Fresh review; fix blockers; open PR referencing #11, not closing it.
