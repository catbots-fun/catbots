# Catbots production web runtime and installer

**Status:** Approved for implementation planning

**Date:** 2026-10-17

**Product scope:** macOS local-first desktop app with a browser UI

**Initial trading scope:** Paper trading and Hyperliquid testnet

## Purpose

Catbots must run as a real local product without Node.js, pnpm, or a terminal after installation. A signed Electron Main process owns the database, credentials, bot runtime, and exchange connections. The same process serves the browser UI on loopback and can also show the native window.

Installation, upgrade, start, stop, and uninstall must preserve trading safety. An interrupted service must never resume a bot without a user action. An upgrade must not replace the app while a deployment is active, an order is in flight, or an order outcome is unknown.

This document explains the target architecture and its invariants. The implementation plan will split this design into testable changes.

## User experience

### Install Catbots

The public installation command is:

```bash
curl -fsSL --proto '=https' --tlsv1.2 https://catbots.fun/install.sh | bash
```

The installer:

1. Detects the Mac architecture and supported macOS version.
2. Downloads the signed release manifest and the matching app archive.
3. Verifies the manifest signature, the archive checksum, the app signature, the Apple Team ID, and notarization.
4. Installs Catbots in `~/Applications/Catbots.app`.
5. Installs the command in `~/.local/bin/catbots`.
6. Installs the user LaunchAgent at `~/Library/LaunchAgents/fun.catbots.web.plist`.
7. Starts the local service at `http://127.0.0.1:5180`.
8. Waits for the installed release to report its exact identity.
9. Opens an authenticated browser session.

The installer never asks for `sudo`. A first install does not require Node.js or pnpm.

### Control Catbots

The installed command exposes a small interface:

```bash
catbots open
catbots status
catbots start
catbots stop
catbots update
catbots uninstall
```

The commands have these meanings:

- `catbots open` starts the service when necessary, creates a one-time browser ticket, and opens the UI.
- `catbots status` prints the installed release, service state, local URL, and any action that the user must take.
- `catbots start` records the desired service state as running, loads the LaunchAgent, and waits for exact health.
- `catbots stop` requests a trading-safety check, stops the service, and records the desired service state as stopped.
- `catbots update` runs the same verified transaction engine that performs a first install.
- `catbots uninstall` removes the app, the command, and the LaunchAgent. It preserves user data.

`catbots uninstall --purge-data` deletes user data only after an interactive full-word confirmation. A noninteractive purge fails closed.

### Use the browser UI

The browser UI is the production renderer. It uses the same handlers as the native renderer and never owns product state. Closing a browser tab does not stop Catbots or a running bot.

The browser authenticates through a short-lived, one-time ticket minted by the application owner. The ticket becomes an `HttpOnly`, `SameSite=Strict` session cookie and cannot be reused.

### Recover after a restart

Catbots starts again after login when the desired service state is running. The application marks any previously running deployment as interrupted. It does not resume trading automatically.

The UI explains why the deployment stopped and asks the user to inspect and start it again.

## Product boundary

### Included

This design includes:

- a packaged web renderer that does not depend on a Vite development server;
- one application process that owns every writable product service;
- a loopback HTTP server for static assets, RPC, events, health, and browser authentication;
- a user-only control channel for the command and the installer;
- a user LaunchAgent for login startup;
- a rootless macOS installer, updater, and uninstaller;
- signed arm64 and x64 releases;
- an install journal, data snapshot, app rollback, and crash recovery;
- an application-wide maintenance gate for safe upgrades and uninstalls;
- automated release and clean-machine acceptance checks.

### Excluded from the first production gate

This design does not enable:

- Hyperliquid mainnet or other real-money execution;
- Windows or Linux installation;
- a remote web server or LAN access;
- automatic bot resume after a restart;
- silent force-stop, force-upgrade, or force-uninstall;
- automatic position closure or order cancellation during maintenance;
- selection of arbitrary older releases from the public command;
- a second Node.js backend or helper daemon;
- an in-app automatic updater.

Mainnet stays disabled until a later safety review covers key custody, order reconciliation, position controls, recovery, and operator warnings.

## Architecture

### One application owner

One packaged Electron Main process owns:

- SQLite and its repositories;
- local configuration;
- encrypted provider and exchange credentials;
- application handlers;
- the bot workbench;
- exchange adapters;
- deployment state;
- `FlowRunner` and its runtime worker;
- the HTTP server;
- native IPC;
- lifecycle and shutdown.

The LaunchAgent starts this process in `serve-web` mode. Browser tabs, Finder launches, the `catbots` command, and the installer are clients. They cannot construct repositories, open SQLite, or submit an exchange order directly.

Electron's single-instance lock is acquired before any product store opens. A losing process contacts the existing owner or exits without touching product data.

### Process intents

Argument parsing happens before product construction:

```ts
type ProcessIntent =
  | { readonly kind: 'serve-web'; readonly window: 'never'; readonly port: 5180 }
  | { readonly kind: 'open-ui' }
  | { readonly kind: 'control'; readonly command: ControlCommand }
  | { readonly kind: 'installer'; readonly command: InstallerCommand };
```

Only `serve-web` may construct the application owner. `open-ui` asks the owner to show a surface. `control` uses the local control channel. `installer` operates on staged files and installation state without opening the product database.

An architecture test enforces this boundary. The test rejects imports from application-owner internals in the client and installer entry points. Constructor instrumentation confirms that only one process creates the database and exchange services.

### Shared application handlers

Native IPC and web RPC invoke one `createApplicationHandlers` instance. The transports validate their own envelopes, then call the same typed methods.

The design does not duplicate product rules in the web server. A rule change must affect both presentation surfaces through the shared handler graph.

### Local web gateway

The gateway binds only to `127.0.0.1:5180`. It serves:

- production assets from the packaged renderer bundle;
- typed RPC requests;
- server-sent events;
- browser-ticket exchange;
- a public read-only health response;
- no administrative mutation endpoint over HTTP.

The existing loopback protections remain mandatory:

- reject non-loopback bindings;
- validate the `Host` header exactly;
- validate `Origin` and Fetch Metadata headers;
- use an `HttpOnly`, `SameSite=Strict` session cookie;
- allowlist methods and content types;
- cap request bodies;
- redact secrets and internal errors;
- set a strict Content Security Policy;
- prevent static-path traversal;
- disable directory listings;
- reject symlink escapes from the asset root.

The service does not expose provider keys, exchange secrets, wallet material, or browser tickets through logs or health responses.

### User-only control channel

Administrative commands use a Unix domain socket under a user-owned directory with mode `0700`. The socket and its parent directory reject ownership or permission mismatches.

The control protocol supports:

```ts
type ControlCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'mint-browser-ticket' }
  | {
      readonly kind: 'prepare-maintenance';
      readonly reason: 'upgrade' | 'uninstall';
      readonly targetRelease?: ReleaseId;
    }
  | { readonly kind: 'shutdown'; readonly leaseId: MaintenanceLeaseId };
```

The protocol is versioned and length-bounded. Every response includes the service instance ID and protocol version. The client rejects an unknown version or identity.

### Exact health identity

A successful TCP connection does not prove that Catbots started. The health response identifies the exact owner:

```ts
type ServiceIdentity = Readonly<{
  product: 'catbots';
  bundleId: 'com.catbots.desktop';
  releaseId: ReleaseId;
  version: string;
  commit: string;
  architecture: 'arm64' | 'x64';
  protocolVersion: number;
  dataSchemaVersion: number;
  instanceId: ServiceInstanceId;
  readiness: 'starting' | 'ready' | 'maintenance' | 'repair';
  resumePolicy: 'manual-only';
  maintenanceOperationId?: TransactionId;
}>;
```

The installer compares the complete expected identity. It fails closed when another process owns port 5180. It never finds or kills a process by port number.

## Trading-safe maintenance

### Maintenance gate

Upgrade, uninstall, and stop request an application-wide maintenance lease. The application blocks new deployments and order submissions before it inspects state.

The request is blocked when one or more conditions exist:

```ts
type MaintenanceBlocker =
  | { readonly kind: 'active-deployment'; readonly deploymentId: string; readonly mode: 'paper' | 'live' }
  | { readonly kind: 'in-flight-order'; readonly clientOrderId: string }
  | { readonly kind: 'unknown-order-outcome'; readonly clientOrderId: string }
  | { readonly kind: 'database-repair-required' }
  | { readonly kind: 'runtime-not-quiescent'; readonly state: string };
```

The application returns every blocker and an exact route where the user can resolve it. The installer does not stop a deployment, close a position, cancel an order, or assume the result of an unknown order.

When no blocker exists, the application:

1. Persists the maintenance operation ID.
2. Stops accepting new work.
3. Stops the runtime worker.
4. Checkpoints SQLite until the WAL contains zero frames.
5. Returns a lease bound to the service instance and operation ID.

Repeating the same operation returns the achieved state. A different operation conflicts until the first operation finishes or recovery resolves it.

### Manual resume policy

Startup converts a previously running deployment to `interrupted` before the runtime accepts commands. This rule applies after login, crash, upgrade, rollback, and manual restart.

No installer flag can bypass the manual resume policy.

## Release trust

### Release artifacts

Each GitHub release contains separate arm64 and x64 app archives. It also contains a signed manifest:

```ts
type ReleaseManifest = Readonly<{
  schemaVersion: 1;
  releaseId: ReleaseId;
  version: string;
  commit: string;
  publishedAt: string;
  minimumMacOS: string;
  bundleId: 'com.catbots.desktop';
  teamId: TeamId;
  protocolVersion: number;
  dataSchemaVersion: number;
  artifacts: Readonly<Record<'arm64' | 'x64', Readonly<{
    url: string;
    sha256: Sha256;
    bytes: number;
  }>>>;
}>;
```

Artifact URLs must identify immutable GitHub release assets. The installer rejects redirects to an unapproved host.

### Verification order

The installer verifies trust in this order:

1. Verify the manifest with the embedded release public key.
2. Select the artifact for the current architecture.
3. Check the declared byte length and SHA-256 digest.
4. Extract into a new private staging directory.
5. Reject archive paths that are absolute, contain `..`, or escape through a symlink.
6. Verify the bundle ID and architecture.
7. Verify the Developer ID signature and pinned Apple Team ID.
8. Verify the hardened runtime and Gatekeeper assessment.
9. Verify the notarization ticket.
10. Start the candidate only through the installer transaction.

The release workflow signs, notarizes, staples, and verifies each app before it publishes the manifest. The website receives the exact `install.sh` file that CI tested.

### Key rotation and revocation

The bootstrap installer contains the current release public key and one next key. A manifest may activate the next key only when the current key signs that manifest. A release may revoke an older key after supported installers trust the replacement.

Changing the pinned Apple Team ID requires a separately reviewed bootstrap release. A normal manifest cannot change it.

## Installer transaction

### Managed paths

The installer manages only these user paths:

- `~/Applications/Catbots.app`;
- `~/.local/bin/catbots`;
- `~/Library/LaunchAgents/fun.catbots.web.plist`;
- a private installer-state directory under `~/Library/Application Support/Catbots Installer`;
- product data under `~/Library/Application Support/Catbots` only for an explicit purge.

Before a write, the installer resolves the target and rejects:

- the root directory;
- a path outside the approved roots;
- a symlinked managed target;
- a target owned by another user;
- a writable parent that violates the expected permission policy.

The implementation must not use `eval`, untrusted globs, `pkill`, or a port-derived process ID.

### State model

The installer is a typed transaction engine inside the signed staged app. The shell bootstrap only downloads, verifies, and invokes that engine.

```ts
type InstallPhase =
  | 'prepared'
  | 'release-verified'
  | 'maintenance-prepared'
  | 'data-snapshotted'
  | 'old-app-staged'
  | 'new-app-installed'
  | 'launch-agent-written'
  | 'candidate-verifying'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'complete';
```

Every phase is written atomically to a journal before the next destructive action. The journal contains release identity, paths, desired service state, and operation IDs. It never contains credentials, browser tickets, wallet material, or arbitrary error bodies.

The transaction uses `fsync` for the new journal file and its parent directory before an atomic rename. App replacement follows the same durability rule.

### Reconciliation

The public operation is convergent:

```ts
const outcome = await installer.reconcile({
  desiredRelease: await releases.resolve('stable'),
  desiredService: 'running',
  preserveData: true,
});
```

Running the operation again produces one of four outcomes:

- `installed`;
- `upgraded`;
- `already-current`;
- `rolled-back`.

An interrupted transaction reads the journal and either finishes forward or rolls back. It does not infer state from file names alone.

### Upgrade sequence

An upgrade follows this sequence:

1. Acquire the installer lock.
2. Recover any existing journal.
3. Verify the target release.
4. Reject a downgrade unless a future recovery policy explicitly permits it.
5. Inspect disk space for the archive, extracted app, data snapshot, old app, and safety margin.
6. Ask the application owner for a maintenance lease.
7. Stop the owner through the control channel.
8. Confirm that the owner exited.
9. Snapshot durable product data.
10. Move the old app to the transaction rollback path.
11. Move the staged app into `~/Applications/Catbots.app`.
12. Write the LaunchAgent atomically.
13. Start the new release in installer-bound maintenance mode.
14. Require health to echo the operation ID and exact release identity.
15. Commit the application migration and installer transaction.
16. Start the canonical service only when the desired service state is running.
17. Verify exact canonical health.
18. Remove temporary files according to the retention policy.

The candidate release cannot accept browser RPC or trading work while it is bound to the installer operation.

### Rollback

Before an application data migration commits, rollback restores both the previous app and the data snapshot. After a migration commits, rollback is allowed only when the previous release declares compatibility with the new data schema.

If backward compatibility is absent, the installer keeps the new app in repair mode and prints manual recovery instructions. It does not start an old app against a newer schema.

The rollback path restores the previous LaunchAgent and the previous desired service state. It never resumes a deployment.

### Stop persistence

`catbots stop` unloads the LaunchAgent and records `stopped`. The implementation does not keep an installed job that exits at every login.

`catbots start` writes or restores the LaunchAgent definition and records `running`. An update preserves the recorded state.

### Snapshot retention

The installer keeps the newest successful pre-upgrade snapshot and any snapshot for an unresolved transaction. It removes older successful snapshots only after the new release passes canonical health.

If free space cannot satisfy the declared requirement, the transaction stops before maintenance and reports the required and available bytes.

## LaunchAgent contract

The LaunchAgent:

- runs as the current user;
- starts the signed app in `serve-web` mode;
- uses no shell interpolation;
- writes bounded operational logs without secrets;
- restarts after an unexpected exit;
- does not restart after `catbots stop`;
- does not open a browser or native window at login.

The CLI uses `launchctl` with the current graphical user domain. It verifies the loaded job label and executable path after every change.

## Failure behavior

Every failure reports the failed stage, a stable error code, and the next safe action. Messages do not claim that installation succeeded until canonical health matches the requested release.

Required failures include:

- unsupported macOS version;
- unsupported architecture;
- invalid manifest signature;
- artifact size or digest mismatch;
- unsafe archive entry;
- invalid app signature;
- notarization or Gatekeeper failure;
- Apple Team ID mismatch;
- unsafe managed path;
- active deployment;
- in-flight order;
- unknown order outcome;
- database repair state;
- non-quiescent runtime;
- insufficient disk space;
- occupied port;
- service identity mismatch;
- service start timeout;
- incompatible downgrade;
- rollback failure.

A rollback failure preserves the journal, the app copies, and the data snapshot. The error directs the user to a recovery command that inspects state without changing it.

## Verification

### Unit tests

Unit tests cover:

- process-intent parsing before product construction;
- single-owner construction boundaries;
- browser-ticket issue, expiry, exchange, and replay rejection;
- exact health identity comparison;
- Host, Origin, Fetch Metadata, body-size, and content-type checks;
- static asset resolution and traversal rejection;
- maintenance blockers and idempotent leases;
- manual resume after every shutdown cause;
- manifest parsing and signature verification;
- archive-entry validation;
- managed-path validation;
- every installer journal transition;
- idempotent start, stop, install, update, uninstall, and recovery;
- downgrade and schema-compatibility rules.

### Integration tests

Integration tests cover:

- packaged `web.html` and its hashed assets without Vite;
- native IPC and web RPC against the same handler graph;
- one owner under concurrent launches;
- a browser close while the runtime remains active;
- LaunchAgent start, stop, login behavior, and desired-state persistence;
- occupied port behavior without killing the listener;
- SQLite WAL checkpoint before shutdown;
- candidate maintenance mode and operation-ID binding;
- update with preserved profile, credentials, bots, logs, and settings;
- uninstall with preserved data;
- purge confirmation and noninteractive rejection.

### Fault-injection tests

The transaction test suite kills the installer after every journaled phase. The next invocation must either finish forward or restore the previous verified state.

Fault injection covers:

- process termination;
- system restart;
- disk full during download, extraction, snapshot, journal write, app move, and rollback;
- failed `fsync`;
- corrupted journal;
- missing staged file;
- failed service start;
- mismatched health identity;
- incompatible migrated data.

### Release checks

CI builds arm64 and x64 artifacts and then runs:

```bash
codesign --verify --deep --strict --verbose=2 Catbots.app
spctl --assess --type execute --verbose=4 Catbots.app
stapler validate Catbots.app
```

CI also checks the bundle ID, Team ID, architecture, embedded version, packaged assets, manifest digest, and release URLs.

A clean-machine acceptance job verifies the public user path from install through uninstall. The job must not have Node.js or pnpm installed.

## Production gate

The first production release is ready only when all conditions pass:

- A clean supported Mac installs Catbots with the public command and no `sudo`.
- Both Apple Silicon and Intel artifacts pass signature, Gatekeeper, and notarization checks.
- The installed app serves the production browser UI without a Vite process.
- Browser and native surfaces use the real application backend.
- Closing the browser does not stop the runtime.
- Concurrent starts create one application owner and one database owner.
- Login startup works when desired state is running.
- `catbots stop` remains stopped after logout and login.
- Reinstalling the same release is idempotent.
- Upgrading preserves the local profile, encrypted credentials, bots, logs, and settings.
- Every journal cut point recovers forward or rolls back in tests.
- Unsafe trading state blocks stop, update, and uninstall with an actionable message.
- No restart, upgrade, or rollback resumes a bot automatically.
- A port conflict does not kill or replace the conflicting process.
- Uninstall preserves user data, and purge requires interactive confirmation.
- The installer served by `catbots.fun` is byte-for-byte the installer tested by release CI.
- Hyperliquid mainnet remains unavailable in the production UI and runtime.

## Delivery sequence

Implementation proceeds in these verifiable units:

1. Add failing tests for process intents, one-owner construction, packaged assets, and exact health identity.
2. Package and serve `web.html` with no Vite dependency.
3. Add the Unix control socket, one-time browser tickets, single-instance ownership, and graceful signal shutdown.
4. Add the `catbots` command, desired service state, and LaunchAgent lifecycle.
5. Add the maintenance gate, signed release reader, transaction journal, snapshots, app replacement, and rollback.
6. Add the arm64 and x64 release workflow, Developer ID signing, notarization, stapling, and signed manifest.
7. Add fault-injection and clean-machine acceptance tests.
8. Publish the tested installer to `catbots.fun` only after the release gate passes.

Each unit begins with a failing test and ends with focused verification. A unit does not expand Hyperliquid execution permissions.

## External release requirements

Production publishing depends on credentials that do not belong in the repository:

- an Apple Developer ID Application certificate;
- the Apple Team ID;
- notarization credentials;
- a release-manifest signing key;
- GitHub Actions secrets for signing and publishing;
- a controlled `catbots.fun` deployment path.

Development can implement and test every local boundary before these credentials exist. The production gate remains closed until CI verifies the real signed artifacts.

## Decisions

This design makes these choices:

- The packaged Electron Main process is the only application owner.
- The browser UI is a local client, not a separate backend.
- The local service uses port 5180 and fails closed on a conflicting listener.
- Administrative commands use a Unix domain socket.
- Browser access uses one-time tickets and secure local sessions.
- The signed staged app owns install and rollback policy.
- The shell bootstrap stays small and contains no product migration logic.
- Upgrades require a maintenance lease and a zero-frame SQLite WAL checkpoint.
- The candidate app starts in installer-bound maintenance mode.
- Downgrades are rejected by default.
- Normal uninstall preserves data.
- Every restart requires a manual trading resume.
- The first production scope supports Paper and Hyperliquid testnet only.
