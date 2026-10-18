# Strategy Lab release and Paper Beta implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a testable Strategy Lab release, verify it with a real LLM provider, and add a safe Paper Beta runtime without exposing live-money controls.

**Architecture:** Keep the Electron main process as the only owner of local state. The packaged app runs the existing local web service and uses one-time browser tickets for access. Release installation uses a signed manifest, staged files, an install journal, and atomic activation. Paper Beta runs saved strategy revisions through the existing strategy runtime and deployment service. The capability policy enables paper trading only after the scheduler, audit log, recovery, and end-to-end tests pass.

**Tech Stack:** TypeScript, Electron Forge, Vite, React, React Flow, Vitest, Playwright, SQLite, macOS LaunchAgent, shell bootstrap script, GitHub Actions.

---

## Current baseline

- [x] Strategy Lab chat, visual flow, validation, and backtest work in the desktop app.
- [x] PR #6 keeps paper trading, live trading, and exchange credentials hidden and blocked.
- [x] The packaged app can own a background web service and issue one-time browser tickets.
- [x] The local service can install and remove its LaunchAgent definition.
- [x] The baseline test suite passes with 637 tests and 2 opt-in tests skipped.

## Task 1: Add provider acceptance tests

**Files:**

- Modify: `apps/desktop/tests/lmstudio-workbench.e2e.test.ts`
- Create: `apps/desktop/tests/provider-workbench.e2e.test.ts`
- Modify: `apps/desktop/package.json`
- Modify: `README.md`

- [x] Keep the LM Studio test opt-in and remove assumptions that depend on one model name.
- [x] Add an opt-in OpenAI-compatible acceptance test that reads the URL, model, and API key from environment variables.
- [x] Add an opt-in Anthropic-compatible acceptance test with the same strategy and backtest assertions.
- [x] Prevent test failures and logs from printing API keys or authorization headers.
- [ ] Run the LM Studio test when `http://127.0.0.1:1234/v1/models` responds. Record an external gate when no provider is running.

## Task 2: Test the packaged background service

**Files:**

- Create: `e2e/packaged-web.spec.ts`
- Create: `e2e/native-lifecycle.spec.ts`
- Delete: `e2e/desktop-smoke.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `package.json`

- [x] Start the packaged service with a temporary data directory.
- [x] Read the service identity and request a one-time browser ticket through the control socket.
- [x] Open the authenticated renderer in Playwright and finish onboarding with a fake provider.
- [x] Create a bot, ask the agent to build a strategy, run a backtest, and verify persisted state after restart.
- [x] Shut down through the control protocol and verify that the test leaves no LaunchAgent or application data behind.

## Task 3: Add release verification and managed paths

**Files:**

- Create: `apps/desktop/src/main/installer/release-manifest.ts`
- Create: `apps/desktop/src/main/installer/managed-paths.ts`
- Create: `apps/desktop/tests/release-manifest.test.ts`
- Create: `apps/desktop/tests/managed-paths.test.ts`

- [x] Parse a versioned release manifest with the app URL, SHA-256 digest, size, signature, and minimum macOS version.
- [x] Reject unknown fields, invalid versions, insecure URLs, digest mismatches, and invalid signatures.
- [x] Resolve every managed path from an explicit installation root. Reject broad roots and paths outside that root.
- [x] Keep fixture keys in tests. Do not treat a fixture key as a production signing key.

## Task 4: Make installation recoverable

**Files:**

- Create: `apps/desktop/src/main/installer/install-journal.ts`
- Create: `apps/desktop/src/main/installer/snapshot-manager.ts`
- Create: `apps/desktop/src/main/installer/install-transaction.ts`
- Create: `apps/desktop/src/main/installer/recovery.ts`
- Create: `apps/desktop/tests/install-journal.test.ts`
- Create: `apps/desktop/tests/install-transaction.test.ts`
- Create: `apps/desktop/tests/installer-recovery.test.ts`

- [x] Add a durable atomic journal store with release identity, managed paths, desired service state, and operation IDs.
- [ ] Wire the installer transaction so it writes the journal before each state change.
- [ ] Stage and verify the app before changing the active installation.
- [x] Add a durable product-data snapshot store with restore and retention behavior.
- [ ] Activate with a same-volume rename and restore the snapshot after any failure.
- [ ] Recover or roll back an interrupted transaction at the next installer start.

## Task 5: Add uninstall and purge commands

**Files:**

- Create: `apps/desktop/src/main/installer/uninstall.ts`
- Create: `apps/desktop/tests/uninstall.test.ts`
- Modify: `apps/desktop/src/main/service/cli-command.ts`

- [ ] Stop the service and remove only paths owned by Catbots.
- [ ] Preserve profiles, bots, logs, and provider configuration during a normal uninstall.
- [ ] Require an explicit `--purge-data` option to remove user data.
- [ ] Make repeated uninstall and purge commands return success.

## Task 6: Add the curl bootstrap installer

**Files:**

- Create: `scripts/install.sh`
- Create: `apps/desktop/tests/install-script.test.ts`
- Modify: `package.json`

- [ ] Download the signed manifest over HTTPS.
- [ ] Verify the manifest signature and the artifact digest before opening the package.
- [ ] Run the packaged installer command and print its final health result.
- [ ] Support `--version`, `--uninstall`, and `--purge-data` without editing the script.
- [ ] Fail closed when a verification tool, signature, digest, or health check fails.

## Task 7: Build and verify release artifacts

**Files:**

- Create: `.github/workflows/release.yml`
- Create: `scripts/generate-release-manifest.mjs`
- Create: `scripts/verify-release-artifacts.mjs`
- Create: `apps/desktop/tests/release-artifacts.test.ts`

- [ ] Build the macOS package on a pinned runner and Node version.
- [ ] Sign and notarize the app when Apple credentials are present.
- [ ] Generate and sign the release manifest after notarization.
- [ ] Verify the published artifact, manifest, signature, and checksum from a clean job.
- [ ] Keep publication disabled until the Apple credentials and the production manifest key pass the verification job.

## Task 8: Add the Paper Beta scheduler

**Files:**

- Create: `apps/desktop/src/main/execution/paper-scheduler.ts`
- Create: `apps/desktop/src/main/execution/paper-market-source.ts`
- Create: `apps/desktop/tests/paper-scheduler.test.ts`
- Modify: `apps/desktop/src/main/execution/deployment-service.ts`
- Modify: `apps/desktop/src/main/main.ts`

- [ ] Schedule interval triggers from the saved strategy revision.
- [ ] Accept market and external-data events through typed adapters.
- [ ] Evaluate each run with one immutable input snapshot.
- [ ] Send actions only to the paper deployment service.
- [ ] Resume active paper deployments after an app restart without replaying completed triggers.

## Task 9: Expose Paper Beta only after safety checks

**Files:**

- Modify: `apps/desktop/src/shared/capabilities.ts`
- Modify: `apps/desktop/src/renderer/App.tsx`
- Modify: `apps/desktop/src/main/api/router.ts`
- Create: `e2e/paper-beta.spec.ts`

- [ ] Show start and stop controls only for valid saved revisions.
- [ ] Require a visible Paper label and a confirmation before the first start.
- [ ] Stream every trigger, condition result, action, fill, error, start, and stop to the audit log.
- [ ] Show positions, equity, profit and loss, drawdown, and the last evaluation time.
- [ ] Keep live trading and exchange credentials disabled.

## Task 10: Run the release gate

- [x] Run `pnpm test`.
- [x] Run the packaged background-service Playwright test twice from clean temporary directories.
- [ ] Run the real-provider acceptance test with an account-owner credential or a local provider.
- [ ] Install, start, stop, update, roll back, uninstall, and purge on a clean macOS user account.
- [ ] Record the signer identity, notarization result, artifact digest, and release URL.
- [ ] Publish Strategy Lab Beta only when every required gate passes.
- [ ] Publish Paper Beta only when Tasks 8 and 9 pass and live trading remains disabled.

## External release gates

The repository can test fixture signatures and unsigned local packages. A public release still needs these account-owned inputs:

- Apple Developer ID Application and Installer certificates.
- Apple notarization credentials.
- A production release-manifest signing key stored in GitHub Actions secrets.
- Permission to publish the package, manifest, and `install.sh` on the Catbots website.
- A real LLM provider credential, or a local model server, for the final provider acceptance run.
