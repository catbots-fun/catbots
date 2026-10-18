# Execution protection capability guard

Tracking: [#11](https://github.com/catbots-fun/catbots/issues/11).

The runtime checks the concrete venue's native protection operations, not an adapter display flag. Production DCA requires callable `submitProtection`, `inspectProtection` and `cancelProtection` operations before any snapshot or order request. A partially implemented protection interface is rejected on either network.

A deployment with saved native protection also requires the complete interface when resuming or reconciling, including on Testnet. An unsupported venue cannot silently skip inspection and report recovery successful. Rejection preserves deployment/order/protection state; reconciliation failures remain in the audit journal.

Testnet DCA without saved native orders can still use the existing local-exit behavior when no native interface is supplied. Local exits depend on the app and network. The existing directional-controller Mainnet restriction is unchanged. This is not a universal protected-entry guarantee for every action node, nor proof that remote protection orders are accepted: placement/inspection errors still use the existing native protection recovery path.

This change is a shared safety foundation only. The merged main branch currently provides Hyperliquid execution; it does not contain the unmerged Lighter adapter work. #11 remains open until Lighter-native protection, capability reporting, reconciliation and Testnet fault acceptance are implemented and verified. It does not enable Mainnet or change exchange protocols.

## Local directional risk checks

The Testnet Long/Short controller checks stop-loss, take-profit and maximum holding time between signal evaluations, using the same five-second risk cadence as DCA. Risk-only evaluations consume confirmed fills and can issue reduce-only exits, but cannot open or reverse a position. Entry signals continue on the existing signal timeframe. Each completed risk evaluation is recorded in the audit journal with `source: risk`.

The cadence is best effort, not an execution deadline: the runtime serializes work, so slow exchange requests delay subsequent checks. Stopping the runtime, losing network access or closing the process prevents local exits. This is not exchange-native protection and does not complete #11 or enable directional Mainnet trading.
