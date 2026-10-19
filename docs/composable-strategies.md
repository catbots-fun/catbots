# Composable strategy signals

Use **Long / Short · Custom signals** (`strategy.directional`, version 2) when the entry rules are more complex than the version 1 EMA/RSI template. Existing version 1 bots are unchanged; do not migrate saved bots without reviewing their rules.

## Build an entry graph

1. Add `data.candles` for each required timeframe, with enough closed bars for indicator warm-up.
2. Connect EMA/RSI/ATR or other available indicators to comparisons.
3. Combine comparisons with nested `condition.combine` (all/any) and `condition.not`.
4. Connect the final long and short conditions to the controller and an ATR value to its `atr` input.
5. Configure quote size, ATR stop multiplier, reward/risk ratio, maximum holding time and cooldown. Validate and backtest before considering deployment.

For example, a long condition can combine `1h EMA fast > EMA slow` with `5m RSI < 20`. A separate short condition can express the inverse trend and `5m RSI > 80`. Do not connect `NOT(long)` as short unless every non-long observation really should be a short signal. For a long-only strategy, connect an explicitly false comparison (such as `0 > 1`) to short.

Missing or warming data remains unknown, including through NOT. Both true, both false, or either unknown cannot open a position. One true direction with the other explicitly false may enter when ATR, cooldown and position constraints permit.

## Single-fire and position management

After emitting an entry, the controller disarms. Both conditions must explicitly become false during a signal evaluation to rearm. A cancellation, unavailable observation, conflicting signals or risk-only tick does not rearm it. State survives serialization/restart. A signal consumed before a definitive entry rejection is not automatically retried.

Confirmed fills alone change inventory. Partial entry cancellation leaves only confirmed inventory eligible for a reduce-only exit. Risk-only evaluation continues ATR stop, full take-profit and maximum-holding-time exits without needing entry signals. Cooldown still applies after a position closes. The controller owns a single position and must be the only order-producing path.

## Execution boundary

Version 2 inherits the existing directional Testnet-only gate and manual Deploy readiness checks. These tests do not establish live exchange acceptance. Exits are local and require the app/network; native Lighter protection is not enabled. Agent tools build, validate and backtest, but cannot start trading or grant approval. Schema-2 Paper execution is not extended by this change.

## Still to deliver

This is the entry-composition increment, not the complete advanced trading workflow. Prior-high/low breakout examples, risk-percent sizing, split take-profit, break-even/trailing stops, account loss limits and shared capability reporting remain follow-up work in [the implementation plan](superpowers/plans/2026-10-19-composable-strategies.md). Do not describe those features as available in version 2.
