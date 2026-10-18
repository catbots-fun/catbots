# Execution protection capability guard

Tracking: [#11](https://github.com/catbots-fun/catbots/issues/11).

The runtime checks the concrete venue's native protection operations, not an adapter display flag. Production DCA requires callable `submitProtection`, `inspectProtection` and `cancelProtection` operations before any snapshot or order request. A partially implemented protection interface is rejected on either network.

A deployment with saved native protection also requires the complete interface when resuming or reconciling, including on Testnet. An unsupported venue cannot silently skip inspection and report recovery successful. Rejection preserves deployment/order/protection state; reconciliation failures remain in the audit journal.

Testnet DCA without saved native orders can still use the existing local-exit behavior when no native interface is supplied. Local exits depend on the app and network. The existing directional-controller Mainnet restriction is unchanged. This is not a universal protected-entry guarantee for every action node, nor proof that remote protection orders are accepted: placement/inspection errors still use the existing native protection recovery path.

This change is a shared safety foundation only. The merged main branch currently provides Hyperliquid execution; it does not contain the unmerged Lighter adapter work. #11 remains open until Lighter-native protection, capability reporting, reconciliation and Testnet fault acceptance are implemented and verified. It does not enable Mainnet or change exchange protocols.
