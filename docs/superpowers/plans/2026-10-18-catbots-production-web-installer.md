# Catbots production web runtime and installer implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Catbots as a signed macOS local service with a real browser UI, safe lifecycle controls, and an idempotent installer.

**Architecture:** One packaged Electron Main process owns all writable application state. Browser, native window, CLI, LaunchAgent, and installer act as clients through typed boundaries. A signed transaction engine performs install and upgrade only after the application grants a trading-safe maintenance lease.

**Tech Stack:** TypeScript 5.9, Electron 40, Electron Forge 7, Vite 7, Vitest 4, Playwright 1.58, SQLite through `better-sqlite3`, Node.js 22 for builds, macOS `launchctl`, GitHub Actions

**Spec:** `docs/superpowers/specs/2026-10-17-catbots-production-web-installer-design.md`

## Global constraints

- Support macOS only in this release.
- Build separate `arm64` and `x64` artifacts.
- Install without `sudo`, Node.js, or pnpm.
- Bind the web service only to `127.0.0.1:5180`.
- Keep Electron Main as the only database, runtime, credential, and exchange owner.
- Keep provider keys, exchange secrets, wallet material, and browser tickets out of logs, health, and journals.
- Never resume a bot after login, crash, stop, update, rollback, or service restart.
- Block maintenance during an active deployment, an in-flight order, an unknown order outcome, database repair, or a non-quiescent runtime.
- Preserve product data during normal uninstall. Require interactive confirmation for `--purge-data`.
- Reject downgrades by default.
- Keep Hyperliquid mainnet unavailable. Production scope is Paper and Hyperliquid testnet.
- Start every behavior change with a failing test and run the full suite before each task commit.
- Preserve unrelated changes in the current working tree. Stage only the files named by the active task.

## Review focus

- A second launch races the LaunchAgent owner. `application-ownership.test.ts` must prove that only the winner constructs product services.
- Port 5180 belongs to another process. `service-startup.test.ts` must prove that Catbots reports the conflict and never kills the listener.
- A browser ticket expires or is replayed. `browser-ticket.test.ts` must prove that both requests fail without creating a session.
- The installer dies after an app move or a journal write. `installer-recovery.test.ts` must prove deterministic forward recovery or rollback.
- A migration raises the data schema beyond the prior app's compatibility. `installer-rollback.test.ts` must prove that Catbots stays in repair mode instead of launching the old app.

---

## File map

### Application ownership

- `apps/desktop/src/main/application/process-intent.ts`: Parse command-line input before product construction.
- `apps/desktop/src/main/application/application-owner.ts`: Construct and expose the sole application owner.
- `apps/desktop/src/main/application/bootstrap.ts`: Acquire ownership and route process intents.
- `apps/desktop/src/main/main.ts`: Thin Electron entry point that delegates to `bootstrapCatbots`.
- `apps/desktop/tests/process-intent.test.ts`: Pin intent parsing and invalid argument behavior.
- `apps/desktop/tests/application-ownership.test.ts`: Pin one-owner construction and client isolation.

### Web and control gateways

- `apps/desktop/src/main/web/service-identity.ts`: Define exact public health identity.
- `apps/desktop/src/main/web/static-assets.ts`: Resolve packaged renderer files without path escape.
- `apps/desktop/src/main/web/http-server.ts`: Serve health, session exchange, RPC, events, and assets.
- `apps/desktop/src/main/control/protocol.ts`: Define the versioned control request and response union.
- `apps/desktop/src/main/control/browser-tickets.ts`: Issue and consume expiring one-time tickets.
- `apps/desktop/src/main/control/socket-server.ts`: Serve user-only administrative commands.
- `apps/desktop/src/main/control/socket-client.ts`: Call and validate the control server.
- `apps/desktop/tests/web-server.test.ts`: Pin loopback security and production asset behavior.
- `apps/desktop/tests/service-startup.test.ts`: Pin health identity and port conflicts.
- `apps/desktop/tests/browser-ticket.test.ts`: Pin ticket expiry and replay protection.
- `apps/desktop/tests/control-socket.test.ts`: Pin permissions, framing, identity, and protocol errors.

### Maintenance and service lifecycle

- `apps/desktop/src/main/maintenance/maintenance-coordinator.ts`: Gate new work, inspect blockers, checkpoint SQLite, and grant leases.
- `apps/desktop/src/main/storage/database.ts`: Expose the zero-frame WAL checkpoint operation.
- `apps/desktop/src/main/service/desired-state.ts`: Persist `running` or `stopped` atomically.
- `apps/desktop/src/main/service/launch-agent.ts`: Render, install, load, unload, and inspect the user LaunchAgent.
- `apps/desktop/src/main/service/cli-command.ts`: Implement `open`, `status`, `start`, and `stop` over typed ports.
- `apps/desktop/assets/fun.catbots.web.plist.template`: Store the LaunchAgent template without shell interpolation.
- `apps/desktop/assets/catbots`: Delegate the installed command to the signed app executable.
- `apps/desktop/tests/maintenance-coordinator.test.ts`: Pin every maintenance blocker and lease transition.
- `apps/desktop/tests/desired-state.test.ts`: Pin atomic state writes and recovery.
- `apps/desktop/tests/launch-agent.test.ts`: Pin exact plist and `launchctl` arguments.
- `apps/desktop/tests/cli-command.test.ts`: Pin user-facing command outcomes.

### Installer transaction

- `apps/desktop/src/main/installer/types.ts`: Define release, journal, outcome, and failure unions.
- `apps/desktop/src/main/installer/managed-paths.ts`: Resolve and validate user-owned install paths.
- `apps/desktop/src/main/installer/release-verifier.ts`: Verify the manifest, digest, bundle, architecture, signature, Team ID, Gatekeeper, and notarization.
- `apps/desktop/src/main/installer/install-store.ts`: Lock, atomically write, and load the transaction journal.
- `apps/desktop/src/main/installer/snapshot-store.ts`: Create, restore, and retain data snapshots.
- `apps/desktop/src/main/installer/transaction.ts`: Reconcile install, update, rollback, and interrupted state.
- `apps/desktop/src/main/installer/uninstall.ts`: Remove managed program files and preserve data by default.
- `apps/desktop/tests/managed-paths.test.ts`: Pin root, traversal, ownership, and symlink rejection.
- `apps/desktop/tests/release-verifier.test.ts`: Pin every trust failure.
- `apps/desktop/tests/install-store.test.ts`: Pin journal durability and lock behavior.
- `apps/desktop/tests/snapshot-store.test.ts`: Pin snapshot creation, restore, disk-space checks, and retention.
- `apps/desktop/tests/installer-transaction.test.ts`: Pin first install and idempotent update.
- `apps/desktop/tests/installer-recovery.test.ts`: Pin every transaction cut point.
- `apps/desktop/tests/installer-rollback.test.ts`: Pin migration compatibility and repair mode.
- `apps/desktop/tests/uninstall.test.ts`: Pin preserved data and purge confirmation.

### Packaging and release

- `apps/desktop/vite.renderer.config.ts`: Build `web.html` into the production renderer.
- `apps/desktop/forge.config.ts`: Package the CLI, LaunchAgent template, and signed app settings.
- `scripts/verify-package-contents.mjs`: Verify required web and service assets in addition to forbidden files.
- `scripts/install.sh`: Bootstrap a verified staged app and call its transaction engine.
- `scripts/verify-release-manifest.mjs`: Verify release-manifest fixtures in CI.
- `.github/workflows/release.yml`: Build, sign, notarize, verify, and publish both architectures.
- `.github/workflows/installer-acceptance.yml`: Exercise the public lifecycle on clean macOS runners.
- `apps/desktop/tests/renderer-build.test.ts`: Pin the production renderer inputs.
- `apps/desktop/tests/package-contents.test.ts`: Pin required package contents.
- `apps/desktop/tests/bootstrap-installer.test.ts`: Pin bootstrap quoting, verification order, and failure behavior.
- `e2e/packaged-web.spec.ts`: Exercise the packaged browser UI against the real backend.
- `e2e/installer-lifecycle.spec.ts`: Exercise install, open, stop, start, update, and uninstall.

## Task 1: Parse process intents before product construction

**Files:**

- Create: `apps/desktop/src/main/application/process-intent.ts`
- Create: `apps/desktop/tests/process-intent.test.ts`

**Interfaces:**

- Consumes: Electron's `app.isPackaged`, `process.argv`, and the fixed service port `5180`.
- Produces: `parseProcessIntent(argv, context): ProcessIntent` and the `ProcessIntent`, `ControlCommand`, and `InstallerCommand` unions.

- [ ] **Step 1: Write the failing parser tests**

Add tests named `defaults a packaged launch to open-ui`, `parses serve-web without opening a window`, `parses control commands`, `parses installer reconcile`, and `rejects unknown or conflicting arguments`. Assert the exact discriminated unions from the spec.

- [ ] **Step 2: Run the parser tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/process-intent.test.ts`

Expected: FAIL because `process-intent.ts` does not exist.

- [ ] **Step 3: Implement the parser and exported unions**

Keep parsing pure. Return a typed error for invalid input before Electron services or product stores can be constructed.

- [ ] **Step 4: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/process-intent.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [x] **Step 5: Commit the task**

```bash
git add apps/desktop/src/main/application/process-intent.ts apps/desktop/tests/process-intent.test.ts
git commit -m "feat(runtime): parse packaged process intents"
```

## Task 2: Package the real browser renderer

**Files:**

- Modify: `apps/desktop/vite.renderer.config.ts`
- Modify: `apps/desktop/forge.config.ts`
- Modify: `scripts/verify-package-contents.mjs`
- Create: `apps/desktop/tests/renderer-build.test.ts`
- Create: `apps/desktop/tests/package-contents.test.ts`

**Interfaces:**

- Consumes: `src/renderer/web.html`, `src/renderer/web-main.tsx`, and Forge's `main_window` output directory.
- Produces: a packaged `web.html`, its hashed assets, and `verifyRequiredEntries(directory, entries): Promise<void>`.

- [ ] **Step 1: Write failing renderer-input and package-content tests**

Assert that the Vite input contains `main`, `wallet`, and `web`. Assert that package verification rejects an app archive missing `web.html` or the service assets.

- [ ] **Step 2: Run both tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/renderer-build.test.ts tests/package-contents.test.ts`

Expected: FAIL because the `web` input and required-entry verification are absent.

- [ ] **Step 3: Add the web input and required packaged resources**

Keep Vite `base: './'`. Package only renderer output, the CLI wrapper, the LaunchAgent template, the tray icon, and declared runtime dependencies.

- [ ] **Step 4: Verify the package without a Vite server**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/renderer-build.test.ts tests/package-contents.test.ts && pnpm make`

Expected: tests pass, packaging exits 0, and package verification finds `web.html` and no forbidden file.

- [ ] **Step 5: Commit the task**

```bash
git add apps/desktop/vite.renderer.config.ts apps/desktop/forge.config.ts scripts/verify-package-contents.mjs apps/desktop/tests/renderer-build.test.ts apps/desktop/tests/package-contents.test.ts
git commit -m "feat(web): package the production browser renderer"
```

## Task 3: Serve packaged assets and exact health

**Files:**

- Create: `apps/desktop/src/main/web/service-identity.ts`
- Create: `apps/desktop/src/main/web/static-assets.ts`
- Modify: `apps/desktop/src/main/web/http-server.ts`
- Create: `apps/desktop/tests/web-server.test.ts`
- Create: `apps/desktop/tests/service-startup.test.ts`

**Interfaces:**

- Consumes: `ServiceIdentity`, the packaged renderer root, shared RPC invocation, and event subscription.
- Produces: `createStaticAssetCatalog(root): StaticAssetCatalog`, `startWebServer(options): Promise<LocalGateway>`, and `GET /api/health`.

- [ ] **Step 1: Write failing behavior tests**

Add tests for exact identity fields, `web.html` fallback, hashed assets, content types, traversal, symlink escape, unsupported methods, an occupied port, and a foreign listener. Assert that Catbots never sends a kill signal.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/web-server.test.ts tests/service-startup.test.ts`

Expected: FAIL on the missing health route and packaged asset catalog.

- [ ] **Step 3: Implement static assets and health**

Keep RPC and event behavior unchanged. Add the strict Content Security Policy and retain the existing Host, Origin, Fetch Metadata, size, and content-type checks.

- [ ] **Step 4: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/web-server.test.ts tests/service-startup.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the task**

```bash
git add apps/desktop/src/main/web/service-identity.ts apps/desktop/src/main/web/static-assets.ts apps/desktop/src/main/web/http-server.ts apps/desktop/tests/web-server.test.ts apps/desktop/tests/service-startup.test.ts
git commit -m "feat(web): serve packaged assets and exact health"
```

## Task 4: Enforce one application owner

**Files:**

- Create: `apps/desktop/src/main/application/application-owner.ts`
- Create: `apps/desktop/src/main/application/bootstrap.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Create: `apps/desktop/tests/application-ownership.test.ts`
- Modify: `apps/desktop/tests/main-lifecycle.test.ts`

**Interfaces:**

- Consumes: `ProcessIntent`, Electron's single-instance API, current repositories, handlers, runtime, IPC, tray, and web gateway.
- Produces: `createApplicationOwner(platform): Promise<ApplicationOwner>` and `bootstrapCatbots(intent, platform): Promise<number>`.

- [ ] **Step 1: Write failing ownership tests**

Assert that `serve-web` acquires the single-instance lock before `ApplicationDatabase` construction. Assert that `open-ui`, `control`, and `installer` construct neither the database nor exchange services. Assert that concurrent service launches yield one owner.

- [ ] **Step 2: Run the ownership tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/application-ownership.test.ts tests/main-lifecycle.test.ts`

Expected: FAIL because `main.ts` constructs the database at module load.

- [ ] **Step 3: Move product construction behind `createApplicationOwner`**

Keep `main.ts` as argument parsing plus bootstrap only. Preserve the current shutdown order, database repair surface, native IPC, tray, E2E hooks, and shared application handlers.

- [ ] **Step 4: Add the import-boundary assertion**

Make `application-ownership.test.ts` scan client and installer entry points and reject imports from `application/application-owner.ts` or product repositories.

- [ ] **Step 5: Verify GREEN, typecheck, and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/application-ownership.test.ts tests/main-lifecycle.test.ts && pnpm --filter @catbots/desktop typecheck && pnpm --filter @catbots/desktop test`

Expected: all commands exit 0.

- [ ] **Step 6: Commit the task**

```bash
git add apps/desktop/src/main/application/application-owner.ts apps/desktop/src/main/application/bootstrap.ts apps/desktop/src/main/main.ts apps/desktop/tests/application-ownership.test.ts apps/desktop/tests/main-lifecycle.test.ts
git commit -m "refactor(runtime): enforce one application owner"
```

## Task 5: Add one-time browser tickets and the Unix control socket

**Files:**

- Create: `apps/desktop/src/main/control/protocol.ts`
- Create: `apps/desktop/src/main/control/browser-tickets.ts`
- Create: `apps/desktop/src/main/control/socket-server.ts`
- Create: `apps/desktop/src/main/control/socket-client.ts`
- Modify: `apps/desktop/src/main/application/application-owner.ts`
- Modify: `apps/desktop/src/main/web/http-server.ts`
- Create: `apps/desktop/tests/browser-ticket.test.ts`
- Create: `apps/desktop/tests/control-socket.test.ts`

**Interfaces:**

- Consumes: the application owner's `identity`, `prepareMaintenance`, and `shutdown` methods.
- Produces: `BrowserTicketStore.issue(ttlMs)`, `BrowserTicketStore.consume(ticket)`, `startControlSocket(options)`, and `createControlClient(options)`.

- [ ] **Step 1: Write failing ticket tests**

Assert that tickets are random, expire, can be consumed once, use constant-time digest comparison, and never appear in logs. Assert that session exchange accepts only a valid ticket.

- [ ] **Step 2: Write failing socket tests**

Assert parent mode `0700`, socket ownership, length-bounded frames, protocol-version rejection, stale instance rejection, concurrent request isolation, and cleanup after graceful exit.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/browser-ticket.test.ts tests/control-socket.test.ts`

Expected: FAIL because the control modules do not exist.

- [ ] **Step 4: Implement ticket and socket boundaries**

Use JSON frames with a fixed maximum byte length and discriminated schemas. Keep all administrative mutations off HTTP.

- [ ] **Step 5: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/browser-ticket.test.ts tests/control-socket.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the task**

```bash
git add apps/desktop/src/main/control apps/desktop/src/main/application/application-owner.ts apps/desktop/src/main/web/http-server.ts apps/desktop/tests/browser-ticket.test.ts apps/desktop/tests/control-socket.test.ts
git commit -m "feat(control): add local service control channel"
```

## Task 6: Gate maintenance on trading safety

**Files:**

- Create: `apps/desktop/src/main/maintenance/maintenance-coordinator.ts`
- Modify: `apps/desktop/src/main/storage/database.ts`
- Modify: `apps/desktop/src/main/application/application-owner.ts`
- Create: `apps/desktop/tests/maintenance-coordinator.test.ts`
- Modify: `apps/desktop/tests/database.test.ts`
- Modify: `apps/desktop/tests/flow-runner.test.ts`

**Interfaces:**

- Consumes: deployment records, pending execution records, reconciliation state, runtime status, and `ApplicationDatabase.checkpointWal(): WalCheckpoint`.
- Produces: `MaintenanceCoordinator.begin(request): Promise<MaintenanceDecision>`, `commit(leaseId)`, `rollback(leaseId)`, and `current()`.

- [ ] **Step 1: Write failing blocker tests**

Add one test for each blocker: active Paper deployment, active Live deployment, in-flight order, unknown outcome, database repair, and runtime work. Assert that all blockers return together with an exact UI route.

- [ ] **Step 2: Write failing lease and checkpoint tests**

Assert that `begin` blocks new work before inspection, waits for quiescence, requires a zero-frame WAL checkpoint, repeats safely for the same operation ID, and rejects a competing ID.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/maintenance-coordinator.test.ts tests/database.test.ts tests/flow-runner.test.ts`

Expected: FAIL on missing maintenance APIs.

- [ ] **Step 4: Implement the coordinator and database checkpoint**

Do not add a force path. Reuse durable deployment and order state instead of runtime-only flags.

- [ ] **Step 5: Verify manual-only resume**

Add assertions that login, crash, update, rollback, and service restart convert a prior running state to `interrupted` before new work is accepted.

- [ ] **Step 6: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/maintenance-coordinator.test.ts tests/database.test.ts tests/flow-runner.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [x] **Step 7: Commit the task**

```bash
git add apps/desktop/src/main/maintenance/maintenance-coordinator.ts apps/desktop/src/main/storage/database.ts apps/desktop/src/main/application/application-owner.ts apps/desktop/tests/maintenance-coordinator.test.ts apps/desktop/tests/database.test.ts apps/desktop/tests/flow-runner.test.ts
git commit -m "feat(runtime): gate maintenance on trading safety"
```

## Task 7: Add persistent start, stop, status, and open commands

**Files:**

- Create: `apps/desktop/src/main/service/desired-state.ts`
- Create: `apps/desktop/src/main/service/launch-agent.ts`
- Create: `apps/desktop/src/main/service/cli-command.ts`
- Create: `apps/desktop/assets/fun.catbots.web.plist.template`
- Create: `apps/desktop/assets/catbots`
- Modify: `apps/desktop/src/main/application/bootstrap.ts`
- Create: `apps/desktop/tests/desired-state.test.ts`
- Create: `apps/desktop/tests/launch-agent.test.ts`
- Create: `apps/desktop/tests/cli-command.test.ts`

**Interfaces:**

- Consumes: `ControlClient`, application paths, `launchctl`, `open`, and the exact health identity.
- Produces: `DesiredStateStore`, `LaunchAgentController`, and `runCliCommand(command, dependencies): Promise<CliOutcome>`.

- [ ] **Step 1: Write failing desired-state tests**

Assert atomic writes, recovery from a missing file, rejection of malformed content, and preservation across an update.

- [ ] **Step 2: Write failing LaunchAgent and CLI tests**

Assert exact `launchctl` arguments, no shell interpolation, executable-path verification, `stop` persistence, `start` health wait, actionable maintenance blockers, and a one-time URL from `open`.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/desired-state.test.ts tests/launch-agent.test.ts tests/cli-command.test.ts`

Expected: FAIL because the service modules do not exist.

- [ ] **Step 4: Implement the service and CLI boundaries**

Use `execFile` with fixed argument arrays. Do not use shell strings, `eval`, `pkill`, or a port-derived process ID.

- [ ] **Step 5: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/desired-state.test.ts tests/launch-agent.test.ts tests/cli-command.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the task**

```bash
git add apps/desktop/src/main/service apps/desktop/assets/fun.catbots.web.plist.template apps/desktop/assets/catbots apps/desktop/src/main/application/bootstrap.ts apps/desktop/tests/desired-state.test.ts apps/desktop/tests/launch-agent.test.ts apps/desktop/tests/cli-command.test.ts
git commit -m "feat(service): add persistent local service controls"
```

## Task 8: Verify releases and managed paths

**Files:**

- Create: `apps/desktop/src/main/installer/types.ts`
- Create: `apps/desktop/src/main/installer/managed-paths.ts`
- Create: `apps/desktop/src/main/installer/release-verifier.ts`
- Create: `apps/desktop/tests/managed-paths.test.ts`
- Create: `apps/desktop/tests/release-verifier.test.ts`
- Create: `apps/desktop/tests/fixtures/releases/`

**Interfaces:**

- Consumes: manifest bytes, detached signature bytes, embedded release public keys, the pinned bundle ID `com.catbots.desktop`, and the pinned Apple Team ID.
- Produces: `resolveManagedPaths(home, user): ManagedPaths` and `verifyRelease(input, platform): Promise<VerifiedRelease>`.

- [ ] **Step 1: Write failing managed-path tests**

Assert rejection of root, traversal, symlinked targets, another user's ownership, unsafe parent permissions, and paths outside the approved roots.

- [ ] **Step 2: Write failing release-verification tests**

Assert signature, byte length, SHA-256, architecture, bundle ID, Team ID, code signature, Gatekeeper, notarization, redirect host, and downgrade failures. Assert that current and next release keys follow the rotation rule.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/managed-paths.test.ts tests/release-verifier.test.ts`

Expected: FAIL because the installer modules do not exist.

- [ ] **Step 4: Implement verification with injectable platform commands**

Sign and verify the exact manifest bytes. Use `execFile` argument arrays for `codesign`, `spctl`, and `stapler`. Keep credentials and raw command output out of public errors.

- [ ] **Step 5: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/managed-paths.test.ts tests/release-verifier.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the task**

```bash
git add apps/desktop/src/main/installer/types.ts apps/desktop/src/main/installer/managed-paths.ts apps/desktop/src/main/installer/release-verifier.ts apps/desktop/tests/managed-paths.test.ts apps/desktop/tests/release-verifier.test.ts apps/desktop/tests/fixtures/releases
git commit -m "feat(installer): verify release trust and managed paths"
```

## Task 9: Persist the installer journal and data snapshots

**Files:**

- Create: `apps/desktop/src/main/installer/install-store.ts`
- Create: `apps/desktop/src/main/installer/snapshot-store.ts`
- Create: `apps/desktop/tests/install-store.test.ts`
- Create: `apps/desktop/tests/snapshot-store.test.ts`

**Interfaces:**

- Consumes: `InstallJournal`, `ManagedPaths`, filesystem durability operations, and declared disk-space requirements.
- Produces: `InstallStore.lock`, `readJournal`, `writeJournal`, `clearJournal`, plus `SnapshotStore.create`, `restore`, and `prune`.

- [ ] **Step 1: Write failing journal tests**

Assert exclusive locking, schema validation, file and parent-directory `fsync`, atomic rename, corrupted-journal failure, operation-ID conflict, and no secret-shaped fields.

- [ ] **Step 2: Write failing snapshot tests**

Assert space preflight, an application-data snapshot, atomic completion markers, restore behavior, retention of the newest successful snapshot, and retention of unresolved snapshots.

- [ ] **Step 3: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/install-store.test.ts tests/snapshot-store.test.ts`

Expected: FAIL because both stores are absent.

- [ ] **Step 4: Implement the stores**

Persist every journal transition before its following destructive action. Keep snapshot retention deterministic and bounded.

- [ ] **Step 5: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/install-store.test.ts tests/snapshot-store.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 6: Commit the task**

```bash
git add apps/desktop/src/main/installer/install-store.ts apps/desktop/src/main/installer/snapshot-store.ts apps/desktop/tests/install-store.test.ts apps/desktop/tests/snapshot-store.test.ts
git commit -m "feat(installer): persist transactions and data snapshots"
```

## Task 10: Reconcile install, update, and rollback

**Files:**

- Create: `apps/desktop/src/main/installer/transaction.ts`
- Modify: `apps/desktop/src/main/application/bootstrap.ts`
- Create: `apps/desktop/tests/installer-transaction.test.ts`
- Create: `apps/desktop/tests/installer-recovery.test.ts`
- Create: `apps/desktop/tests/installer-rollback.test.ts`

**Interfaces:**

- Consumes: `VerifiedRelease`, `InstallStore`, `SnapshotStore`, `ControlClient`, `LaunchAgentController`, `DesiredStateStore`, and exact service health.
- Produces: `createInstaller(platform): CatbotsInstaller` with `reconcile(request): Promise<InstallOutcome>`.

- [ ] **Step 1: Write the failing happy-path tests**

Assert first install, same-release idempotence, safe upgrade, preserved desired service state, candidate maintenance identity, canonical health, and preserved product data.

- [ ] **Step 2: Write the failing recovery matrix**

Parameterize termination after every journal phase. Assert one deterministic result for each cut point: finish forward, restore the previous verified app and snapshot, or enter repair mode.

- [ ] **Step 3: Write failing migration tests**

Assert rollback before migration commit. Assert rollback after commit only when the prior release declares data-schema compatibility. Assert repair mode for an incompatible schema.

- [ ] **Step 4: Run the focused tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/installer-transaction.test.ts tests/installer-recovery.test.ts tests/installer-rollback.test.ts`

Expected: FAIL because `transaction.ts` does not exist.

- [ ] **Step 5: Implement the state machine**

Use one transition function per journal phase. Require a maintenance lease before shutdown and require the candidate health response to echo the transaction ID.

- [ ] **Step 6: Add disk-full and `fsync` fault injection**

Cover download, extraction, snapshot, journal write, app move, candidate start, canonical start, and rollback. Preserve all recovery evidence after rollback failure.

- [ ] **Step 7: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/installer-transaction.test.ts tests/installer-recovery.test.ts tests/installer-rollback.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 8: Commit the task**

```bash
git add apps/desktop/src/main/installer/transaction.ts apps/desktop/src/main/application/bootstrap.ts apps/desktop/tests/installer-transaction.test.ts apps/desktop/tests/installer-recovery.test.ts apps/desktop/tests/installer-rollback.test.ts
git commit -m "feat(installer): reconcile install update and rollback"
```

## Task 11: Add safe uninstall and explicit purge

**Files:**

- Create: `apps/desktop/src/main/installer/uninstall.ts`
- Modify: `apps/desktop/src/main/application/bootstrap.ts`
- Create: `apps/desktop/tests/uninstall.test.ts`

**Interfaces:**

- Consumes: `ManagedPaths`, `MaintenanceCoordinator`, `LaunchAgentController`, `InstallStore`, and an interactive confirmation port.
- Produces: `uninstall(request): Promise<UninstallOutcome>`.

- [x] **Step 1: Write failing uninstall tests**

Assert maintenance blockers, service unload, managed-file deletion, preserved application data, idempotent repeat, exact purge confirmation, noninteractive purge rejection, and symlink rejection.

- [x] **Step 2: Run the uninstall tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/uninstall.test.ts`

Expected: FAIL because `uninstall.ts` does not exist.

- [x] **Step 3: Implement uninstall through validated managed paths**

Do not use recursive deletion on an unresolved path. Record each deletion in the transaction journal before it occurs.

- [x] **Step 4: Verify GREEN and run the desktop suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/uninstall.test.ts && pnpm --filter @catbots/desktop test`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the task**

```bash
git add apps/desktop/src/main/installer/uninstall.ts apps/desktop/src/main/application/bootstrap.ts apps/desktop/tests/uninstall.test.ts
git commit -m "feat(installer): preserve data during uninstall"
```

## Task 12: Add the public bootstrap installer

**Files:**

- Create: `scripts/install.sh`
- Create: `apps/desktop/tests/bootstrap-installer.test.ts`
- Modify: `apps/desktop/forge.config.ts`
- Modify: `scripts/verify-package-contents.mjs`

**Interfaces:**

- Consumes: `https://catbots.fun/releases/stable/manifest.json`, its detached signature, immutable GitHub release assets, an embedded manifest public key, and the pinned Apple Team ID.
- Produces: a POSIX shell bootstrap that invokes `Catbots --installer reconcile` after verification.

- [x] **Step 1: Write failing bootstrap tests**

Run the script against fixture commands and HTTP responses. Assert TLS flags, architecture mapping, detached-signature verification, byte length, SHA-256, approved redirect host, private temporary directory, safe extraction, bundle ID, Team ID, code signature, Gatekeeper, notarization, and cleanup.

- [x] **Step 2: Add failure tests for hostile input**

Cover spaces and newlines in paths, archive traversal, symlink escape, partial download, invalid JSON, command failure, unsupported macOS, and an interrupted download. Assert that the current app remains unchanged.

- [x] **Step 3: Run the bootstrap tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/bootstrap-installer.test.ts`

Expected: FAIL because `scripts/install.sh` does not exist.

- [x] **Step 4: Implement the small bootstrap**

Keep transaction and migration policy in the signed app. Use fixed command paths where macOS provides them, quote every expansion, use `mktemp -d`, and install a cleanup trap.

- [ ] **Step 5: Verify GREEN and run shell analysis**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/bootstrap-installer.test.ts && shellcheck scripts/install.sh`

Expected: tests pass and ShellCheck reports no finding.

- [x] **Step 6: Run the full suite and package verification**

Run: `pnpm test && pnpm typecheck && pnpm make`

Expected: all commands exit 0.

- [ ] **Step 7: Commit the task**

```bash
git add scripts/install.sh apps/desktop/tests/bootstrap-installer.test.ts apps/desktop/forge.config.ts scripts/verify-package-contents.mjs
git commit -m "feat(installer): add verified macOS bootstrap"
```

## Task 13: Build and verify signed release artifacts

**Files:**

- Create: `scripts/verify-release-manifest.mjs`
- Create: `scripts/release-manifest.d.mts`
- Create: `scripts/release-manifest.mjs`
- Create: `apps/desktop/tests/release-manifest.test.ts`
- Modify: `apps/desktop/forge.config.ts`
- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: Apple Developer ID credentials, Apple Team ID, notarization credentials, the release private key, GitHub release permissions, and exact app metadata.
- Produces: signed and stapled arm64 and x64 archives, `manifest.json`, and `manifest.json.sig`.

- [ ] **Step 1: Write failing manifest tests**

Assert schema version 1, immutable asset URLs, architecture coverage, bundle ID, Team ID, release ID, protocol version, data schema version, byte lengths, SHA-256 values, and an exact-byte detached signature.

- [ ] **Step 2: Run the manifest tests and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/release-manifest.test.ts`

Expected: FAIL because the manifest builder does not exist.

- [ ] **Step 3: Implement manifest generation and local verification**

Read artifact metadata from the completed app bundles. Never print signing credentials or private-key material.

- [ ] **Step 4: Add the release workflow**

Build both architectures, sign with hardened runtime, notarize, staple, run `codesign --verify --deep --strict --verbose=2`, run `spctl --assess --type execute --verbose=4`, validate the staple, verify package contents, create the signed manifest, and publish only after both jobs pass.

- [ ] **Step 5: Verify the workflow structure and full local suite**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/release-manifest.test.ts && pnpm test && pnpm typecheck`

Expected: all commands exit 0. The workflow remains expected to stop at its credential check outside the configured release environment.

- [ ] **Step 6: Commit the task**

```bash
git add scripts/verify-release-manifest.mjs scripts/release-manifest.d.mts scripts/release-manifest.mjs apps/desktop/tests/release-manifest.test.ts apps/desktop/forge.config.ts .github/workflows/release.yml
git commit -m "build(release): sign and verify macOS artifacts"
```

## Task 14: Prove the packaged lifecycle on clean macOS

**Files:**

- Create: `e2e/packaged-web.spec.ts`
- Create: `e2e/installer-lifecycle.spec.ts`
- Create: `.github/workflows/installer-acceptance.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Consumes: signed release artifacts, `scripts/install.sh`, a clean macOS user, port 5180, and the public CLI.
- Produces: `pnpm test:packaged-web`, `pnpm test:installer`, and a release-blocking acceptance workflow.

- [ ] **Step 1: Write the failing packaged-web test**

Assert that the packaged app starts without Vite, returns exact health, exchanges one browser ticket, completes onboarding through the real backend, and remains running after the browser closes.

- [ ] **Step 2: Write the failing installer lifecycle test**

Assert install, idempotent reinstall, open, persistent stop, login observation, start, data-preserving update, blocked unsafe update, occupied-port failure, uninstall with retained data, and explicit purge rejection in noninteractive mode.

- [ ] **Step 3: Run both tests and confirm RED**

Run: `pnpm test:packaged-web && pnpm test:installer`

Expected: FAIL because the commands and acceptance harness are absent.

- [ ] **Step 4: Add the test commands and clean-runner workflow**

Do not install Node.js or pnpm inside the product-under-test user account. Upload redacted service, installer, and Playwright diagnostics only on failure.

- [ ] **Step 5: Document the verified user path and safety limits**

Update the README with install, open, status, start, stop, update, uninstall, data location, testnet-only scope, manual resume policy, and recovery command. Do not advertise production readiness before the acceptance workflow passes on published artifacts.

- [ ] **Step 6: Run the release candidate gate**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm make && pnpm test:packaged-web && pnpm test:installer`

Expected: every command exits 0, with no warning that weakens a security or trading-safety assertion.

- [ ] **Step 7: Commit the task**

```bash
git add e2e/packaged-web.spec.ts e2e/installer-lifecycle.spec.ts .github/workflows/installer-acceptance.yml package.json README.md
git commit -m "test(release): prove the installed Catbots lifecycle"
```

## Task 15: Publish the tested installer without drift

**Files:**

- Modify: `.github/workflows/release.yml`
- Create: `scripts/verify-published-installer.mjs`
- Create: `apps/desktop/tests/published-installer.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: the release-tested `scripts/install.sh`, the controlled `catbots.fun` deployment path, and the published stable manifest.
- Produces: a byte-for-byte website installer check and a release status that can truthfully say ready.

- [ ] **Step 1: Write the failing publication-integrity test**

Assert that the served installer bytes equal the release artifact bytes and that the stable manifest identifies the same release accepted in Task 14.

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @catbots/desktop exec vitest run tests/published-installer.test.ts`

Expected: FAIL because the publication verifier does not exist.

- [ ] **Step 3: Add gated publication and post-deploy verification**

Publish only after the signed artifacts and clean-machine acceptance pass. Fail the release if website bytes or the stable release identity differ.

- [ ] **Step 4: Run the final production gate**

Run: `pnpm typecheck && pnpm test && pnpm test:e2e && pnpm make && pnpm test:packaged-web && pnpm test:installer && node scripts/verify-published-installer.mjs`

Expected: all commands exit 0 against the release candidate and the published website.

- [ ] **Step 5: Mark readiness only after external credentials pass**

Change the README status from testnet preview to production-ready local testnet only after Apple signing, notarization, both architectures, clean-machine acceptance, and publication-integrity checks pass.

- [ ] **Step 6: Commit the task**

```bash
git add .github/workflows/release.yml scripts/verify-published-installer.mjs apps/desktop/tests/published-installer.test.ts README.md
git commit -m "release: publish the verified Catbots installer"
```

## Execution notes

The current checkout contains unrelated uncommitted product work, including files that Tasks 2, 4, 6, 12, 13, and 14 modify. Before implementation, choose one safe base:

1. Commit the existing product work and create an isolated worktree from that commit.
2. Continue in the current checkout and stage only the active task's files after reviewing overlapping diffs.

Do not create a worktree from the current `HEAD` and assume that it contains the uncommitted runtime work. It does not.

Apple signing, notarization, and website publication require external credentials. Complete the implementation and fixture tests without those credentials, but keep the production gate closed until the real release workflow passes.
