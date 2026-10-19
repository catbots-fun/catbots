import { MarketPicker } from './MarketPicker';
import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Input,
  LayerCard,
  Select,
  Collapsible,
  Table,
} from "@cloudflare/kumo";
import type {
  CatbotsDesktopApi,
  ConnectionsView,
  ExecutionTarget,
  ExecutionTargetView,
  FlowDeployment,
} from "@catbots/contracts";
export function ExecutionTargetPanel({
  botId,
  directional = false,
  nodeApi,
  workspaceMarket = "ETH-PERP",
  version,
  api,
}: {
  botId: string;
  directional?: boolean;
  nodeApi?: CatbotsDesktopApi['nodes'];
  workspaceMarket?: string;
  version?: number;
  api?: CatbotsDesktopApi["connections"];
}) {
  const [data, setData] = useState<ConnectionsView>({
      adapters: [],
      connections: [],
    }),
    [saved, setSaved] = useState<ExecutionTargetView>(),
    [target, setTarget] = useState<ExecutionTarget>({
      botId,
      connectionId: "",
      accountId: "",
      market: workspaceMarket,
      maxPositionUsd: 500,
      maxOrderUsd: 100,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (api) {
      setBusy(true);
      api
        .command({ action: "get_target", botId })
        .then((view) => {
          if (active) {
            setData(view);
            setSaved(view.executionTarget);
            if (view.executionTarget?.target)
              setTarget(view.executionTarget.target);
          }
        })
        .catch(() => {
          if (active) setError("Could not load execution target.");
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }
    return () => {
      active = false;
    };
  }, [api, botId]);
  const [deployment, setDeployment] = useState<FlowDeployment>(),
    [healthAvailable, setHealthAvailable] = useState(false),
    [confirmation, setConfirmation] = useState(""),
    [closeConfirmation, setCloseConfirmation] = useState('');
  useEffect(() => { setCloseConfirmation(''); }, [botId, deployment?.id]);
  useEffect(() => {
    setHealthAvailable(false);
    setDeployment(undefined);
    if (!api) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let watchdog: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let timedOut = false;
      watchdog = setTimeout(() => { timedOut = true; if (active) setHealthAvailable(false); }, 5000);
      try {
        const view = await api.command({ action: "get_flow_runtime", botId });
        if (active) { setDeployment(view.deployment); setHealthAvailable(!timedOut); }
      } catch {
        if (active) {
          setHealthAvailable(false);
          setError(
            "Runtime status unavailable. Check the backend and exchange.",
          );
        }
      } finally {
        clearTimeout(watchdog);
      }
      if (active) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(watchdog);
    };
  }, [api, botId]);
  const running =
    deployment?.status === "running" || deployment?.status === "stopping";
  const closePosition = async () => {
    if (!api || !deployment) return;
    setBusy(true); setError('');
    try {
      const next = await api.command({ action: 'close_flow_position', botId, deploymentId: deployment.id, confirmation: closeConfirmation });
      setDeployment(next.deployment);
    } catch {
      setError('Close could not be confirmed. Refresh and reconcile with the exchange before retrying; a request may already have been sent.');
    } finally { setCloseConfirmation(''); setBusy(false); }
  };
  const toggleEntries = async () => {
    if (!api || !deployment) return;
    setBusy(true); setError('');
    try {
      const next = await api.command({ action: 'set_flow_entries_paused', botId, deploymentId: deployment.id, paused: !deployment.entriesPaused });
      setDeployment(next.deployment);
    } catch {
      setError('Could not change entry controls. Refresh runtime status before retrying.');
    } finally { setBusy(false); }
  };
  const runtime = async (start: boolean) => {
    if (!api || (start && !version)) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.command(
        start
          ? { action: "start_flow", botId, version: version!, confirmation }
          : { action: "stop_flow", botId },
      );
      setDeployment(next.deployment);
      setConfirmation("");
    } catch {
      setError(
        "Runtime could not start or stop. Check readiness, market minimum ($10), available funds and open orders. Inspect the exchange if a previous order was unresolved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const connection = data.connections.find(
    (item) => item.id === target.connectionId,
  );
  const dirty = JSON.stringify(target) !== JSON.stringify(saved?.target);
  const run = async (check: boolean) => {
    if (!api) return;
    setBusy(true);
    setError("");
    try {
      const next = await api.command(
        check
          ? { action: "check_target", botId }
          : { action: "save_target", target },
      );
      setSaved(next.executionTarget);
      setData(next);
    } catch {
      setError(
        "Could not save or check target. Select an account and keep the order limit within the position limit.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="deploy-panel" aria-label="Bot deployment">
      <header>
        <h2>Deploy</h2>
        <p className="backtest-muted">Manage your trading target and monitor execution.</p>
      </header>
      {deployment && (
        <LayerCard className="deploy-card deploy-runtime">
          <div className="deploy-runtime-heading"><h3>Bot runtime</h3>
            <Badge variant={running ? "success" : deployment.status === "failed" ? "error" : "secondary"}>
              {deployment.status.charAt(0).toUpperCase() + deployment.status.slice(1)}
            </Badge>{" "}
            Flow v{deployment.version} · {deployment.environment === "testnet" ? "Testnet" : "Mainnet"} ·{" "}
            {deployment.target.market}
          {deployment.entryPauseSupported && <Button
            size="base" variant="secondary" disabled={busy || deployment.status !== 'running'}
            onClick={() => void toggleEntries()}
          >{deployment.entriesPaused ? 'Resume entries' : 'Pause entries'}</Button>}
          <Button
            size="base"
            variant="secondary"
            disabled={busy || deployment.status !== 'running'}
            onClick={() => void runtime(false)}
          >
            Stop runtime
          </Button>
          </div>
          {deployment.entriesPaused && <p role="status">Entries paused. Risk checks and exits continue while the runtime is running. Orders already submitted still await their outcome.</p>}
          <p className="backtest-muted">Stop runtime stops local checks; it does not close positions or cancel exchange protection.</p>
          {deployment.closePositionSupported && deployment.closeResult !== 'closed' && <div>
            <p>Close this deployment’s {deployment.target.market} position using a reduce-only market order, then stop. Partial or uncertain results require review.</p>
            <p>Type <code>{`CLOSE ${deployment.target.market}`}</code> to confirm.</p>
            <Input size="base" label="Close confirmation" value={closeConfirmation} disabled={busy} onChange={event => setCloseConfirmation(event.target.value)} />
            <Button size="base" variant="destructive" disabled={busy || deployment.status === 'stopping' || deployment.orders.some(order => ['uncertain','submitting'].includes(order.status)) || closeConfirmation !== `CLOSE ${deployment.target.market}`} onClick={() => void closePosition()}>Close position &amp; stop</Button>
          </div>}
          {deployment.closeResult && <p role="status">{deployment.closeResult === 'closed' ? 'Close verified: the exchange reported a flat position.' : deployment.closeResult === 'pending' ? 'Close submitted. Waiting for a confirmed result.' : 'Close needs attention. Inspect remaining position and reconcile before retrying.'}</p>}
          <dl className="deploy-stats">
            <div><dt>Evaluations</dt><dd>{deployment.cycles}</dd></div>
            <div><dt>Orders this run</dt><dd>{deployment.orders.length}</dd></div>
            <div><dt>Last evaluation</dt><dd>{deployment.lastRunAt ? new Date(deployment.lastRunAt).toLocaleTimeString() : 'Waiting'}</dd></div>
            <div><dt>Runtime observation</dt><dd>{!healthAvailable ? 'Unavailable' : !deployment.health ? 'Unknown' : ({waiting:'Waiting for runtime data',responsive:'Responsive',stalled:'Stalled',inactive:'Inactive'} as const)[deployment.health.state]}</dd></div>
            <div><dt>Heartbeat</dt><dd>{healthAvailable && deployment.health?.heartbeatAt ? new Date(deployment.health.heartbeatAt).toLocaleString() : 'Unknown'}</dd></div>
            <div><dt>Snapshot received</dt><dd>{healthAvailable && deployment.health?.snapshotReceivedAt ? new Date(deployment.health.snapshotReceivedAt).toLocaleString() : 'Unknown'}</dd></div>
            <div><dt>Recovery</dt><dd>{!healthAvailable || !deployment.health ? 'Unknown' : ({pending:'Operation pending',required:'Review required','not-assessed':'Not assessed'} as const)[deployment.health.recovery]}</dd></div>
          </dl>
          <p className="muted">Responsive describes the local runtime, not exchange health. Snapshot received is receipt time, not proof of fresh prices or candles.</p>
          {(deployment.orders.some((order) => order.status === "uncertain") ||
            deployment.closeResult === 'needs-attention' ||
            !!deployment.protection ||
            deployment.status === "failed") && (
            <Button
              size="base"
              variant="secondary"
              disabled={busy || running}
              onClick={async () => {
                if (!api) return;
                setBusy(true);
                try {
                  const view = await api.command({
                    action: "reconcile_flow",
                    botId,
                  });
                  setDeployment(view.deployment);
                  setError("");
                } catch {
                  setError(
                    "Exchange outcome is still unresolved. No order was resent.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Reconcile with exchange
            </Button>
          )}
          {deployment.protection && (
            <Banner
              variant="default"
              title={`Exchange protection: ${deployment.protection.status}`}
              description={deployment.protection.orders
                .map(
                  (order) =>
                    `${order.kind.toUpperCase()} ${order.triggerPrice} · ${order.status}`,
                )
                .join(" | ")}
            />
          )}
          {deployment.error && (
            <Banner
              variant="error"
              title="Runtime stopped"
              description={deployment.error}
            />
          )}

          <Collapsible.Root defaultOpen>
            <Collapsible.Trigger render={<Button size="sm" variant="secondary" />}>Recent orders ({deployment.orders.length})</Collapsible.Trigger>
            <Collapsible.Panel>
              {deployment.orders.length ? <div className="deploy-table"><Table aria-label="Recent bot orders"><Table.Header><Table.Row>{['Time','Side','Size','Price','Status'].map(label=><Table.Head key={label}>{label}</Table.Head>)}</Table.Row></Table.Header><Table.Body>{deployment.orders.slice(-10).reverse().map(order=><Table.Row key={order.id}><Table.Cell>{new Date(order.at).toLocaleTimeString()}</Table.Cell><Table.Cell>{order.side??'—'}</Table.Cell><Table.Cell>{order.quantity??'—'}</Table.Cell><Table.Cell>{order.price??'—'}</Table.Cell><Table.Cell><Badge>{order.status}</Badge></Table.Cell></Table.Row>)}</Table.Body></Table></div>:<p>No orders yet. Waiting for a strategy signal.</p>}
            </Collapsible.Panel>
          </Collapsible.Root>
          <Collapsible.Root>
            <Collapsible.Trigger render={<Button size="sm" variant="ghost" />}>
              Node activity
            </Collapsible.Trigger>
            <Collapsible.Panel>
              {deployment.events.map((event, index) => (
                <p key={index}>{event}</p>
              ))}
            </Collapsible.Panel>
          </Collapsible.Root>
        </LayerCard>
      )}
      {error && (
        <Banner
          variant="error"
          title="Target needs attention"
          description={error}
        />
      )}
      {target.market !== workspaceMarket && <div className="workspace-market">
        <Banner variant="alert" title="Trading and test markets differ" description={`Workspace tests use ${workspaceMarket}. This trading target uses ${target.market}.`} />
        <Button size="sm" variant="secondary" disabled={busy || running} onClick={() => { setTarget({ ...target, market: workspaceMarket }); setConfirmation(''); }}>Use {workspaceMarket} for trading</Button>
        <p className="backtest-muted">Save the target and check readiness before starting. Active runs keep their original market.</p>
      </div>}
      <LayerCard className="deploy-card">
        <Collapsible.Root key={running ? 'running' : 'editable'} defaultOpen={!running}>
          <Collapsible.Trigger render={<Button variant="ghost" size="base" />}>
            Trading target · {target.market}{running ? ' · View settings' : ' · Configure'}
          </Collapsible.Trigger>
          <Collapsible.Panel>
        <div className="deploy-fields">
          <Select
            size="base"
            label="Connection"
            disabled={busy || running}
            value={target.connectionId}
            renderValue={(value) =>
              data.connections.find((item) => item.id === value)?.name ??
              "Select connection"
            }
            onValueChange={(value) =>
              setTarget({
                ...target,
                connectionId: String(value),
                accountId: "",
              })
            }
          >
            {data.connections.map((item) => (
              <Select.Option key={item.id} value={item.id}>
                {item.name} ·{" "}
                {item.environment === "production" ? "Mainnet" : "Testnet"}
              </Select.Option>
            ))}
          </Select>
          <Select
            size="base"
            label="Trading account"
            disabled={busy || running || !connection}
            value={target.accountId}
            renderValue={(value) =>
              connection?.accounts.find((item) => item.id === value)?.name ??
              "Select account"
            }
            onValueChange={(value) =>
              setTarget({ ...target, accountId: String(value) })
            }
          >
            {connection?.accounts.map((item) => (
              <Select.Option key={item.id} value={item.id}>
                {item.name} · {item.address.slice(0, 6)}…
                {item.address.slice(-4)}
              </Select.Option>
            ))}
          </Select>
          <MarketPicker api={nodeApi} label="Trading market" value={target.market} disabled={busy || running} onChange={market => { setTarget({ ...target, market }); setConfirmation(''); }} />
          <Input
            size="base"
            label="Maximum position (USD)"
            type="number"
            min={1}
            disabled={busy || running}
            value={target.maxPositionUsd}
            onChange={(event) =>
              setTarget({
                ...target,
                maxPositionUsd: Number(event.target.value),
              })
            }
          />
          <Input
            size="base"
            label="Maximum order (USD)"
            type="number"
            min={1}
            disabled={busy || running}
            value={target.maxOrderUsd}
            onChange={(event) =>
              setTarget({ ...target, maxOrderUsd: Number(event.target.value) })
            }
          />
        </div>
        {connection && (
          <p>
            <Badge
              variant={
                connection.environment === "production" ? "secondary" : "info"
              }
            >
              {connection.environment === "production"
                ? "Mainnet · Real funds"
                : "Testnet · Test funds"}
            </Badge>{" "}
            {connection.adapterId}
          </p>
        )}
        <div className="provider-actions">
          <Button
            size="base"
            variant="primary"
            disabled={busy || running || !target.accountId || !api || !dirty}
            onClick={() => void run(false)}
          >
            Save target
          </Button>
          <Button
            size="base"
            variant="secondary"
            disabled={busy || running || dirty || !saved?.target}
            onClick={() => void run(true)}
          >
            Check readiness
          </Button>
        </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      </LayerCard>
      {!data.connections.length && !busy && (
        <p>Add an exchange account in Connections first.</p>
      )}
      {dirty && <Badge variant="warning">Unsaved changes</Badge>}
      <p className="deploy-runtime-note">{directional ? 'Keep the app open for exits. No exchange-native stop. Stopping leaves positions open.' : 'Keep the app open to run. Stopping leaves positions and exchange protection in place.'}</p>
      {saved?.checks && <LayerCard className="deploy-card">
        <div className="deploy-runtime-heading"><h3>Readiness</h3><Badge variant={saved.ready?'success':'warning'}>{saved.checks.filter(check=>check.passed).length}/{saved.checks.length} passed</Badge></div>
        <div className="deploy-checks">{saved.checks.map(check=><Badge key={check.label} variant={check.passed?'success':'warning'}>{check.passed?'✓':'!'} {check.label}</Badge>)}</div>
        {saved.checks.filter(check=>!check.passed).map(check=><Banner key={check.label} variant="alert" title={check.label} description={check.detail}/>)}
        <Collapsible.Root><Collapsible.Trigger render={<Button variant="ghost" size="sm"/>}>Check details</Collapsible.Trigger><Collapsible.Panel><div className="deploy-check-details">{saved.checks.map(check=><div key={check.label}><strong>{check.label}</strong><p>{check.detail}</p></div>)}</div></Collapsible.Panel></Collapsible.Root>
      </LayerCard>}
      {saved?.ready && !dirty && !running && (
        <LayerCard className="deploy-card deploy-start">
          <h3>Start flow v{version}</h3>
          <p>
            Target: {saved.accountName} · {target.market}. Type{" "}
            <strong>
              {connection?.environment}:{target.market}
            </strong>{" "}
            to confirm the network and market.
          </p>
          <Input
            size="base"
            label="Confirm execution target"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <Button
            size="base"
            variant="primary"
            disabled={
              busy ||
              !version ||
              confirmation !== `${connection?.environment}:${target.market}`
            }
            onClick={() => void runtime(true)}
          >
            {deployment && deployment.version === version
              ? "Start / resume bot"
              : "Start bot"}
          </Button>
        </LayerCard>
      )}

    </section>
  );
}
