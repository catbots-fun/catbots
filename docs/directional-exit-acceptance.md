# Directional exit fault acceptance

Tracking: [#21](https://github.com/catbots-fun/catbots/issues/21). This is a runtime integration gate, not an end-to-end or live-exchange readiness certificate.

Run with Node 22:

```sh
pnpm --filter @catbots/desktop exec vitest run tests/directional-exit-faults.test.ts
```

The suite uses the real flow compiler, directional controller, runner, recovery file and audit store. A deterministic in-memory venue replaces the exchange; timers are controlled. No credentials, network requests or trades are involved.

| Fault | Required behavior | Coverage |
| --- | --- | --- |
| Exchange fills exit but response is lost | Preserve uncertain order and last confirmed position; reject restart and competing bot on the same account; reopening storage must retain ownership; unknown reconciliation cannot clear the order; confirmed reconciliation applies once without resubmission | Long and short |
| Exit rejected | Preserve position, record rejection, stop automatic retries, retain result across reopening | Long and short |
| Terminal partial exit | Record only filled quantity; next risk evaluation closes only the residual quantity with a new order identity; never report flat early | Long and short |
| Snapshot request fails | Stop without submitting an exit from unavailable data | Long |
| Position changes externally | Stop without submitting an exit against mismatched inventory | Long |
| Stop requested while exit response is delayed | Remain stopping with last confirmed inventory, await the result, record it and stop without another order | Long |

Nine cases exercise these contracts. A mutation check removing the unknown-reconciliation guard causes both long/short uncertainty cases to fail; the guard is restored in the shipped code.

## Remaining gates

- Real adapter contract tests and Testnet evidence, including exchange-side order identities and native protection.
- Process termination/power-loss at persistence boundaries; reopening after a recorded failure does not simulate a hard crash.
- Short-side network/manual-change/stop scenarios and mixed fault sequences.
- Notification delivery and actionable health alerts (#15).
- Full app lifecycle, account-service lock integration and unattended acceptance across supported adapters.

Local exits still require the running application and network. The runtime snapshot is last confirmed state, not a guarantee of current exchange inventory. This suite does not enable Mainnet or complete #21.
