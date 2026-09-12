# Catbots user guide

[Back to the README](../README.md) · [Dynamic markets](dynamic-markets.md) · [Community nodes](architecture/community-node-sdk.md)

Detailed configuration, local runtime behavior, and provider integration for the macOS app. For installation and your first strategy, start with the [quick start](../README.md#quick-start).

## What you can build

- Fixed-symbol strategies use a normal Condition such as `market.symbol = ETH-PERP`.
- Screeners omit the symbol equality and filter each `currentMarket` by price, funding, volume, rank, or indicators.
- Interval Triggers evaluate the active DEX universe; market Events evaluate only their event market.
- Actions cannot choose a different symbol. Strategy 2.0 binds every Action to the evaluation's immutable `currentMarket`.
- “Sell ETH” means close or reduce an ETH Long. Opening a Short requires explicit short intent.

The graph always uses the same three node kinds:

```text
Trigger  →  Condition  →  Action
```

## Configuration

Settings is the only in-app writer of `local.env.yaml`, stored in the Catbots Electron data directory. Use [local.env.example.yaml](../local.env.example.yaml) only as a field reference; never copy credentials into the repository.

For LM Studio, a typical OpenAI-compatible configuration is:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:1234/v1` |
| API key | `lm-studio`, or the token configured in LM Studio |
| Model | The loaded model identifier |
| Reasoning effort | `Off` for Qwen tool workflows |

With LM Studio running and a model loaded, run the optional real-model acceptance test with `pnpm test:lmstudio`. Override its defaults with `CATBOTS_LMSTUDIO_URL` and `CATBOTS_LMSTUDIO_MODEL`.

Hyperliquid testnet additionally requires the master account's public address and a dedicated Agent/API Wallet private key. Never give Catbots a master-wallet private key. Credentials remain in Electron Main and are excluded from renderer DTOs, Agent prompts, traces, logs, and diagnostics.

## Running Catbots

```sh
pnpm dev           # native Electron application
pnpm dev:desktop   # same as pnpm dev
pnpm dev:web       # real browser UI + local Electron backend, no window at startup
pnpm dev:all       # browser UI + desktop window, sharing one backend
pnpm dev:preview   # simulated UI only
```

Open **http://127.0.0.1:5180/** after the terminal prints `Catbots web:`. Real web mode uses the same AI provider, config, SQLite repositories, backtests and deployment services as desktop. Reloading the browser preserves saved bots and conversations. `dev:all` is the supported way to use both surfaces together; do not start separate backend processes against the same profile.

The browser talks to a loopback-only HTTP backend using an HttpOnly, SameSite session and same-origin requests. Provider credentials remain in the backend after entry. The backend currently runs on Electron/macOS; this is a real local web client, not a standalone static site or an Internet-hosted multi-user server. Keep the backend process running. Closing the browser does not quit the backend or stop its runtime; use the tray's Quit action or stop the dev process. Native quit confirmation and existing live-review requirements remain in place. Web mode is currently a development entry point, not a packaged web distribution. Port 5180 must be free; an occupied port fails startup instead of silently changing the browser origin.

`dev:preview` is separate: the browser preview uses in-memory fixtures, resets on reload, retains no API keys, and performs no YAML, SQLite, runtime, or exchange operations. Use the Electron application for persistence and native integration testing.

Paper simulates the selected DEX locally. Hyperliquid Live mode uses the approved Strategy 2.0 revision, a fresh market universe, explicit Live review, and the configured testnet Agent Wallet. Both modes use DEX-wide market access plus per-market and shared portfolio controls. Details are in [Dynamic markets](dynamic-markets.md#paper-and-hyperliquid-testnet).

## Architecture and security

| Area | Responsibility |
| --- | --- |
| Electron Main | Configuration, SQLite, secure IPC, market-universe refresh, deployments, and exchange access |
| React renderer | Kumo UI, Chat, React Flow, Backtest results, deployment review, performance, and logs |
| `@catbots/contracts` | Strict renderer-safe DTOs and IPC schemas |
| `@catbots/strategy-runtime` | Versioned TCA graphs, deterministic evaluation, fan-out, Backtest, and traces |
| `@catbots/execution-core` | Venue-neutral adapter contract, risk checks, normalized orders, and idempotency |
| Hyperliquid adapter | Testnet metadata, Agent Wallet signing, submission, and reconciliation |

The renderer is sandboxed. Live proposals, approved risk decisions, and outbox items are written before adapter side effects. Unknown venue outcomes require reconciliation and are never blindly submitted twice. See [SECURITY.md](../SECURITY.md) to report a vulnerability privately.

## Pi strategy agent

The shared web/desktop backend runs `@earendil-works/pi-agent-core` 0.84.3 and `@earendil-works/pi-ai` 0.84.4, matching [Cloudflare OS](https://github.com/cloudflare/cloudflare-os/tree/main/packages/workshop-backend). Pi owns the conversation loop, schema validation, sequential tool execution, and lifecycle events. Catbots supplies six strategy tools and the existing OpenAI-compatible/Anthropic-compatible HTTP transport, so saved provider settings (including LM Studio and reasoning effort) still apply. No separate Pi CLI installation or login is needed.

The agent can inspect nodes/data, validate drafts, backtest, explain, and compare versions. It cannot approve or deploy a strategy. A successful backtest stops further tools in that batch and ends the turn for review; at most eight tool rounds may execute. Cancellation and credential-safe failures propagate through the same backend to both clients.

The transport forwards live text deltas from OpenAI-compatible and Anthropic-compatible SSE responses through Pi to both web and desktop chat. Tool calls execute only after a complete, validated response; interrupted or truncated streams cannot execute partial tool arguments. Pi coding-agent shell/filesystem tools and usage/cost accounting are not enabled. Existing chat history and strategy storage remain compatible.

## Subscription providers (Pi)

Settings → AI providers supports ChatGPT Plus/Pro (Codex), Claude Pro/Max,
GitHub Copilot, xAI, OpenRouter, and Radius through Pi's provider-owned login
flows. Select **Sign in**, open the provider page, finish any device-code or
manual-code prompt, then choose a model and **Use for chat**. API-key login is
also offered where Pi supports it. Existing compatible API settings remain
available through **Use compatible API settings instead**. First-launch users
can connect and select a subscription model without creating API-key settings.

Web and desktop use the same local backend and credentials. OAuth tokens and
API keys stay in the profile's `provider-auth.enc`, encrypted using Electron
safeStorage; the file is user-only (0600). Catbots does not read or modify
`~/.pi/agent/auth.json`. Pi resolves and refreshes credentials under a serialized
store lock. Sign out deletes the local credential; it does not revoke a token
at the provider. OpenRouter keys can be revoked from the OpenRouter account.
The active provider/model is saved separately in `provider-selection.json`.

Claude subscription authentication draws on extra usage billed per token;
OpenRouter sign-in creates a key billed from OpenRouter credits. Provider terms,
account entitlements, and model availability still apply. Radius uses a dynamic
catalog: use **Refresh models** after connecting if necessary. Provider login
opens in the host's system browser, with Pi's loopback callback or manual input.
Actual account sign-in requires the account owner; automated tests use simulated
provider flows and do not prove subscription entitlement or live inference.

References: [Pi provider documentation](https://pi.dev/docs/latest/providers),
[Cloudflare OS provider routing](https://github.com/cloudflare/cloudflare-os/blob/main/packages/workshop-backend/src/ai-models.ts).
