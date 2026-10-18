# Pause entries and stop runtime

Tracking: [#12](https://github.com/catbots-fun/catbots/issues/12).

The Deploy runtime card exposes separate controls for supported DCA and Long/Short controllers:

- **Pause entries** prevents new exposure, including DCA additions. The runtime stays running and retains account ownership. Risk evaluations, reduce-only exits and existing native protection inspection continue.
- **Resume entries** permits entries at the next signal evaluation. It does not immediately place an order or bypass risk checks.
- **Stop runtime** stops local evaluation after in-flight work settles. It does not close positions or cancel exchange-native protection.

Pause cannot retract a request already sent to an exchange. Its outcome remains subject to normal confirmation/reconciliation. An entry still awaiting preflight when pause is requested is not sent, and its controller pending state is cancelled so later resume can work.

The pause flag is persisted with the deployment and retained when resuming that same deployment after a stop or backend restart. Restart does not automatically start a bot. A new deployment starts with entries enabled. Control requests carry the deployment ID, so stale requests cannot change a replacement deployment. Unsupported action workflows do not expose entry pause and are rejected by the backend.

Pause/resume transitions and suppressed entries are logged. Resume requires a successful audit write before allowing new exposure. A persistence failure during pause leaves entries paused in memory and reports failure; do not treat that response as confirmation of durable storage. Local exits still require an available app, network and exchange.

## Verification and remaining scope

Runtime tests cover pause across a clean stop/reopen, failed-persistence retry, risk exits while paused, DCA addition suppression, stale deployment IDs, unsupported/stopped workflows, audit failure on resume and pause during preflight. Component tests distinguish the entry controls from Stop runtime and verify deployment-bound commands. The API schema rejects malformed requests. Dedicated interrupted-running restart and native-protection-while-paused fault cases remain follow-up coverage; these tests do not simulate process kill or power loss.

This is partial #12 delivery. **Close position & stop**, explicit close confirmation, terminal close reconciliation and its fault-acceptance matrix remain outstanding. No live trading or Mainnet readiness is claimed.
