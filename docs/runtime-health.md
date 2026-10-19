# Runtime observations

Deploy exposes local runtime observations alongside evaluation and order history. This is a partial delivery for issue #15, not an unattended-trading health certificate.

- **Waiting for runtime data:** a controller is active but no runtime snapshot has returned in this activation.
- **Responsive:** the local loop has progressed within 15 seconds and has received a runtime snapshot. It does not certify exchange health, protection, or market-data freshness.
- **Stalled:** no local progress for more than 15 seconds, or the wall clock moved behind the last observation. A pending network call can cause this. The observation does not cancel or retry orders.
- **Inactive:** no active controller in this process. Review the separate deployment status to distinguish stopped, failed and interrupted runs.

Heartbeat advances on loop entry and after the evaluation snapshot returns. Snapshot received is local receipt time for that snapshot, not an exchange/source timestamp and not the age of its candles. A slow-timeframe workflow can remain responsive between scheduled snapshots.

Observation timestamps live only in the current active controller. They reset on start/restart and disappear when it becomes inactive; durable evaluation timestamps and the audit journal remain separate historical evidence. Old saved deployments without this additive field are displayed as Unknown.

Recovery is **Operation pending** during a reserved account operation or active unresolved submission, **Review required** for failed/interrupted deployments, unresolved orders or unverified manual closes, and otherwise **Not assessed**. Not assessed is deliberately not a claim that the account is reconciled or safe.

The UI polls every two seconds after each completed request. Failed requests or requests outstanding for five seconds withdraw the displayed observation and timestamps. A later successful request completed within the deadline restores them; a late response does not. A hung request is not retried concurrently; backend disconnection cannot leave an indefinitely positive status on screen.

No notifications, external destinations, exchange-source freshness checks or automated trading decisions are added here. These remain open work under #15. Tests use local deterministic venues; no user accounts or live orders are used.
