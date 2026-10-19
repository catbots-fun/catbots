# Confirmed position close

Scope: explicit Close position & stop for saved directional Testnet deployments. Native-protected DCA, arbitrary action workflows and Mainnet are excluded until their cancellation/protection coordination is implemented.

The user confirms `CLOSE <market>` for an exact deployment ID. The runtime reserves the account, stops and waits for in-flight work, refuses unresolved orders, and reads fresh exchange inventory. It closes only inventory matching that deployment's confirmed position, with reduce-only market IOC sizing. Foreign orders, changed positions, unsupported flows and invalid confirmation fail closed.

Close intent is persisted before submission. Timeout retains the pending order and account exclusion across restart. Recovery queries that same order and never resends. Terminal partial fills remain visible; retry requires another explicit close request and uses a new identity. Full closure is reported only after a confirmed terminal outcome and a fresh flat snapshot. A close request prevents resuming the old controller; once closure is verified, a new deployment can be started explicitly.

Pause entries, Stop runtime, and Close position & stop remain distinct. Close does not cancel arbitrary orders or flatten another bot's inventory. No live trades are part of implementation/testing. Tests use deterministic venues. This is partial issue #12, not complete unattended or Mainnet acceptance.

## Using the control

In Deploy, enter the displayed `CLOSE <market>` phrase and select **Close position & stop**. A partial or uncertain result is not success. Use **Reconcile with exchange** to verify the saved order and current inventory; only confirm another close after reviewing the remaining position. `Close verified` describes the exchange snapshot at verification time, not a continuous guarantee that the account stays flat. Orders or manual account changes after verification require a new inspection.

Close, reconciliation and in-progress startup are serialized at the account boundary. Connection authorization changes, target edits and bot removal are blocked during the operation. Unresolved manual closes retain account exclusion and prevent starting a replacement bot. Full closure allows an explicitly started new deployment, rather than reuse of the old controller's position state.
