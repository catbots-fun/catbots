# Composable trading strategies

**Goal:** Let users compose multi-timeframe entry rules independently of position management, then extend position management and execution capability reporting in focused PRs.

**Approved intent:** The user approved moving beyond simple strategies: hourly EMA trend, five-minute RSI, one-minute breakout, ATR stop, risk sizing, partial take profit, trailing stop and loss limits. No autonomous real-money trading.

## Findings

- `data.candles` and historical replay already accept multiple timeframes with closed-candle slices.
- Packaged conditions already support comparison and nested binary AND/OR; NOT is missing in this runtime (legacy schema has it).
- `strategy.directional` v1 hardcodes EMA/RSI signals. It already handles confirmed fills, single-position ownership, ATR exits, maximum holding time and cooldown.
- Agent guidance still describes all packaged flows as simulation-only, despite selected Testnet deployment support.

## Delivery sequence

1. Composable signal controller: retain v1 unchanged; add v2 with explicit long/short condition inputs and ATR. Unknown/conflicting signals cannot enter. Signal edge is consumed once, persisted across restart, and cannot re-enter until rearmed. Add tri-state NOT. Test state, partial fills, cooldown and risk-only exits. Clarify AI guidance without authorizing deployment.
2. Multi-timeframe breakout nodes and a complete example: rolling prior high/low with offset, warm-up and no-lookahead tests; AI-edit → validation → historical replay → simulated venue acceptance.
3. Risk sizing and position lifecycle: versioned risk-percent/ATR sizing, partial TP, break-even/trailing stops with confirmed-fill accounting and restart recovery. Integrate target limits; do not expose unsupported exchange-native capabilities.
4. Agent capability tool and UI: report per-flow backtest/Testnet/Mainnet support from shared validation, explain unsupported nodes and offer targeted repairs. Test the user's full example across layers.

## Increment 1 implementation

**Architecture:** A versioned wrapper around the existing directional position manager owns signal-edge state; the underlying position/fill journal remains unchanged. Version 1 is not migrated. Both versions retain the Testnet gate and single-controller rule.

**Files:** `packages/nodes-strategy/src/directional.ts`, package registration, packaged condition definitions, runtime tests, agent guidance and documentation.

- [ ] Write tests for v2 boolean signals: long/short, unavailable/conflicting signals, single-fire/rearm, serialized restart, partial fill exits and risk-only evaluation.
- [ ] Observe failing tests before implementing v2; validate defaults with the node config schema.
- [ ] Implement `strategy.directional` version 2 with `long`, `short`, `atr` inputs. Persist `{controller, armed, scope, key}`. Rearm only after both signals are explicitly false during a signal evaluation; unavailable/conflicting/risk observations never rearm. Consume only when an entry order is emitted.
- [ ] Add `condition.not`, preserving unknown quality, and tests for nested boolean evaluation.
- [ ] Update agent guidance to prefer composable signals when requested; do not claim Paper/Mainnet/native support and do not add execution tools.
- [ ] Run focused tests, full suite and typecheck; independent review and fix important findings.
- [ ] Open PR with exact scope. Remaining increments are not claimed complete.

## Safety and acceptance

No live exchange requests or credentials. No mainnet gate changes. Missing data cannot become permission to enter. Risk-only ticks must still process confirmed fills and exits without consuming/rearming signals. Existing v1 state, existing deployment constraints and confirmed-close behavior must remain compatible. Backtest success does not imply live readiness or profitability.

## Review resolution

Independent review identified two important manifestations of a type-only lookup bug: the main-process draft store rejected wired v1 edits, and the renderer substituted v2 definitions for saved v1 nodes. Both now resolve type plus version, including connected ports, palette keys, configuration defaults and draft restore. Regression tests failed before the fixes and passed afterward. Risk-only evaluation also resolves the saved version.

The minor coverage gaps were addressed with nonzero cooldown after confirmed close and an executable nested AND/OR/NOT graph. Core signal tests and the risk-monitor regression were observed failing before implementation. No live exchange acceptance or profitability is claimed. Increments 2–4 remain open.
