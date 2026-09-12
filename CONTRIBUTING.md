# Contributing to Catbots

## Setup and checks

The M0 release is macOS-only and requires Node.js 22.x. Release scripts fail fast on other operating systems or Node majors; Windows and Linux packaging is outside this milestone.

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm make
```

Run the relevant focused test before changing behavior, then run the full checks before opening a contribution. The Electron E2E suite uses an isolated canonical `catbots-e2e-*` child of the OS temporary directory and must clean up its application process even when a test fails. Its native lifecycle seam requires `NODE_ENV=test` plus a positively established development/default or macOS ad-hoc build; production-signed and MAS builds cannot enable it.

## M0 engineering boundaries

- Keep the renderer sandboxed: no Node integration, generic IPC, filesystem bridge, or remote renderer content.
- Add only named, typed preload methods backed by Main-process validation.
- The Settings form remains the only in-app writer of `local.env.yaml`; never log or commit credentials.
- Do not add a master wallet key. Hyperliquid Agent/API-wallet material is local configuration only.
- Keep AI-provider and Hyperliquid testnet network access in Electron Main, behind the named IPC contracts. Preserve the mainnet execution guard.
- Preserve close-to-tray behavior; Main owns the native Quit confirmation and orderly runtime shutdown.

The package gate recursively rejects `local.env.yaml` and rollback/temp variants, `.superpowers`, and review/visual artifacts from the app bundle, `app.asar`, and generated ZIP.
