# Lighter Testnet foundation

Lighter uses the exchange-adapter boundary for connection verification, account discovery, market data and execution. The shared flow runner owns evaluation logs, account locks, uncertain-order journals, pause/stop controls and recovery.

## Connect an account

1. Open Connections and select Lighter, then Testnet.
2. Enter a connection name, Account Index, API Key Index (4–254) and the API Private Key registered on that account.
3. Test and save. Catbots checks the registered public key and authenticated order access before saving encrypted credentials locally.
4. Create a Lighter bot and select its connection, account and market in Deploy. Review readiness before starting.

Catbots does not request an Ethereum/L1 private key. Saved API keys are not returned to the renderer. Multiple accounts may be saved; one bot has one account target. Active or unresolved executions retain account ownership. Removing the saved view does not revoke the exchange key; revoke it on the exchange when appropriate. Credential rotation and garbage collection are not implemented by this foundation.

## Execution and recovery

- Local app capabilities enable Testnet execution only. Production starts remain blocked at both IPC and service boundaries.
- Orders use the bundled, hash-verified official Go WASM signer. No external signing service or runtime binary download is involved; see `apps/desktop/assets/lighter/README.md` for version and provenance.
- Market execution uses IOC orders with a fixed 0.5% price bound. An order may cancel instead of filling outside that bound.
- Order and paginated trade evidence must agree before a fill is confirmed. A timeout or incomplete evidence preserves the pending journal; reconciliation does not broadcast the order again.
- Terminal fills require matching decimal base/quote totals from trade evidence. A `filled` order must be fully filled; corroborated canceled partial fills remain supported. Contradictory evidence stays unresolved.
- Directional Pause entries continues local exit monitoring. Stop runtime does not close the position. Confirmed Close position & stop is available only for supported directional Testnet deployments, with fresh reduce-only sizing and terminal/flat checks.
- Native exchange SL/TP is **not enabled** for Lighter. Workflows requiring native protection remain blocked. Local exits depend on the app and network remaining available.

When removing an orphan connection after a fresh account-wide flat/no-orders check, archived records retain their original inventory and an explicit verification timestamp. That resolved history does not reserve the reconnected account forever. Pending or uncertain order evidence still blocks removal, including when a legacy record has lost its pending pointer.

## Research data

Lighter bots use Lighter Mainnet public historical candles and funding for simulations, regardless of the execution network. Supported candle resolutions are 1m, 5m, 15m, 30m, 1h, 4h and 1d. History is paginated, bounded to 100,000 candles per interval and rejects missing/conflicting records. Execution rejects markets with a multiplier other than 1. Legacy schema-2 Paper execution is not extended to Lighter.

## Verification boundary

Foundation tests use local synthetic accounts, fake exchange transports and the real bundled signer with a dummy key. They verify routing, precision, credential isolation, ambiguous outcomes, fill pagination and control compatibility. They do not prove exchange-side native protection, unattended readiness or profitability. No authenticated exchange acceptance run is claimed by this integration.

Issues #11 (native protection), #12 (complete close controls) and #13 (account-level risk budgets) remain open until their full acceptance criteria are met. Mainnet must remain gated.

## Adapter extensions

`ExchangeAdapter` supplies discovery and optional `verify`, `connectApiKey`, `createVenue` and authenticated `activity` operations. `ConnectionsService` resolves the registered adapter for readiness, start, reconciliation and confirmed close. A venue implements `FlowVenue`; native protection is an optional complete interface, not inferred from its exchange name. New venues must declare unsupported operations and provide behavioral tests before enabling their capabilities.

Protocol references: [official Go signer](https://github.com/elliottech/lighter-go) and [official Python SDK](https://github.com/elliottech/lighter-python).

## Native protection transport (development only)

The separate `LighterProtectionVenue` implements creation, inspection and cancellation for journaled reduce-only SL/TP orders. It is not attached to `LighterFlowVenue.protection` or advertised as an adapter capability yet. This prevents incomplete runtime acceptance from silently changing existing deployments.

The signer uses the pinned Go WASM's trigger types 2/4, IOC time-in-force and explicit expiry. Creation uses a 28-day expiry and a 0.5% execution-price bound around the quantized trigger. Sell triggers round up to the market price tick, buy triggers down; quantities must be exactly representable. Stops can cancel or partially fill when liquidity or that price bound prevents a complete fill; they do not guarantee an exit price or full execution.

Inspection checks account, market, side, kind, reduce-only, quantity, trigger, price and saved exchange identity. Pending/open orders waiting for `mark-price` with no fills and a future expiry may be recognized as resting protection. Already-triggered `ready` orders, missing rows, ambiguous history and partial evidence remain unresolved. Terminal fills use the existing trade reconciliation. Cancellation requires identity verification before sending and terminal no-fill evidence afterward; a racing fill requires reconciliation.

The orchestrator must persist `unknown` before creation. Recovery inspects that client identity instead of resubmitting it. The caller must serialize all account mutations and retain unresolved journals/account locks. Transport tests exercise this contract with synthetic HTTP and local WASM signatures, not an authenticated exchange account.

Before activation, #11 still requires runtime protected-entry handling, expiry renewal, partial/missing-protection recovery and authenticated Testnet crash/network/restart acceptance. The existing directional local risk cadence remains unchanged. #12 will extend protected close controls; Mainnet remains gated.

Wire references: [pinned WASM entry points](https://github.com/elliottech/lighter-go/blob/9d38261d1a4cc5c7211b383ba07a4d6e41604708/web-wasm/main.go), [SDK SL/TP helpers](https://github.com/elliottech/lighter-python/blob/main/lighter/signer_client.py), [official order fields](https://apidocs.lighter.xyz/docs/websocket-reference), and [NautilusTrader's trigger-transition handling](https://nautechsystems.github.io/nautilus_docs/rust-api-latest/src/nautilus_lighter/websocket/parse.rs.html).
