# Lifecycle audit

**Goal:** Extend #14 with start/resume, stop, interruption, reconciliation and native protection evidence.
**Architecture:** Extend the existing journal kinds; required start write before scheduling; best-effort safety lifecycle writes with a persistent, sanitized warning on the deployment. Recovery state remains authoritative. Native protection transitions are logged after recovery persistence and must never abort mandatory protection actions.
**Tech Stack:** TypeScript, SQLite, React/Kumo, Vitest.
**Spec:** docs/execution-audit.md and issue #14.

## Global Constraints
- No live trades, user-runtime restart, pruning or credentials.
- Missing audit evidence does not authorize resend. Preserve pending order state on unresolved reconciliation.
- Log state transitions, not unchanged protection polls.
- Retention/export remains follow-up. UI remains English/React/Kumo.

## Review Focus
Start audit failure before scheduling, restart interruption durability, stop during in-flight work, reconciliation failure preserving pending state, and protection logging failures not interrupting installation/cancellation. Warnings must be visible without leaking raw storage errors.

### Task 1: Lifecycle journal and safety tests
**Interfaces:** lifecycle, reconciliation and protection audit kinds; optional FlowDeployment.auditWarning; read-only history labels and warning banner.
1. Add RED tests for start/resume/stop/restart, unresolved/successful reconciliation, native protection transitions and storage failures.
2. Implement lifecycle recording and best-effort warning persistence. Expected: targeted tests GREEN.
3. Update documentation, full root tests and typecheck. Expected: all pass.
4. Commit, one fresh reviewer, fix Important/Critical findings with RED/GREEN, push and open PR against main. Keep #14 open.
