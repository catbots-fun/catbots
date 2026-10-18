import { ExecutionLogPanel } from './ExecutionLogPanel';
import { FlowAuditPanel } from './FlowAuditPanel';
import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  Collapsible,
  LayerCard,
  Select,
  Table,
} from "@cloudflare/kumo";
import type { CatbotsDesktopApi, FlowDeployment } from "@catbots/contracts";
const displayTime = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const amount = (value: number | undefined) => value === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
export function executionMetrics(run: FlowDeployment) {
  const fills = run.orders.filter((order) => order.status === "filled");
  let position = 0,
    average = 0,
    realized = 0,
    fees = 0;
  for (const fill of fills) {
    if (
      fill.quantity === undefined ||
      fill.price === undefined ||
      fill.fee === undefined ||
      !["buy", "sell"].includes(fill.side ?? "")
    )
      return undefined;
    const delta = (fill.side === "buy" ? 1 : -1) * fill.quantity;
    if (position === 0 || position * delta > 0)
      average =
        (Math.abs(position) * average + fill.quantity * fill.price) /
        (Math.abs(position) + fill.quantity);
    else {
      realized +=
        Math.min(Math.abs(position), fill.quantity) *
        (fill.price - average) *
        Math.sign(position);
      if (fill.quantity > Math.abs(position)) average = fill.price;
    }
    position += delta;
    fees += fill.fee;
  }
  return { fees, realized, net: realized - fees };
}
export function FlowExecutionResults({
  botId,
  api,
  logs = false,
}: {
  botId: string;
  api?: CatbotsDesktopApi["connections"];
  logs?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [runs, setRuns] = useState<FlowDeployment[]>([]),
    [selected, setSelected] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setRuns([]);
    setSelected("");
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const view = await api?.command({ action: "get_flow_runtime", botId });
        if (active && view) {
          setRuns(
            [
              ...(view.deployment ? [view.deployment] : []),
              ...(view.history ?? []),
            ].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
          );
          setError("");
        }
      } catch {
        if (active) setError("Execution history unavailable.");
      }
      if (active) setLoading(false);
      if (active) timer = setTimeout(() => void load(), 5000);
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, botId]);
  const run = runs.find((item) => item.id === selected) ?? runs[0];
  const fills = run?.orders.filter((order) => order.status === "filled") ?? [];
  const metrics = run ? executionMetrics(run) : undefined;
  return (
    <section className="deploy-panel performance-panel" aria-label={logs ? "Execution logs" : "Trading performance"}>
      <header className="performance-heading"><div><h2>{logs ? "Execution logs" : "Performance"}</h2><p className="backtest-muted">{logs ? 'Inspect execution events and node data.' : 'Track results for each trading run.'}</p></div></header>
      {logs && <FlowAuditPanel botId={botId} api={api}/>}
      {error && (
        <Banner
          variant="error"
          title="Could not load results"
          description={error}
        />
      )}
      {!run ? (
        <p role="status">{loading ? "Loading trading history…" : error ? "History could not be loaded. Retrying…" : logs ? "No runtime snapshot available. Audit history is shown separately above." : "No runtime snapshot available."}</p>
      ) : (
        <>
          <Select
            size="base"
            label="Run history"
            value={run.id}
            onValueChange={(value) => setSelected(String(value))}
            renderValue={() => `v${run.version} · ${displayTime(run.startedAt)}`}
          >
            {runs.map((item) => (
              <Select.Option key={item.id} value={item.id}>
                v{item.version} · {displayTime(item.startedAt)} · {item.status}
              </Select.Option>
            ))}
          </Select>
          <div className="performance-context">
            <strong>{run.target.market}</strong>
            <Badge variant={run.environment==='testnet'?'info':'secondary'}>{run.environment==='testnet'?'Testnet':'Mainnet'}</Badge>
            <Badge variant={run.status==='running'?'success':run.status==='failed'?'error':'neutral'}>{run.status.charAt(0).toUpperCase()+run.status.slice(1)}</Badge>
            <span className="backtest-muted">{run.lastRunAt ? `Evaluated ${displayTime(run.lastRunAt)}` : 'Waiting for first evaluation'}</span>
          </div>
          {!logs && <>
            <div className="performance-metrics">
              <LayerCard className="deploy-card"><span className="backtest-muted">Realized PnL after fees</span><strong className="performance-value">{amount(metrics?.net)} <small>USDC</small></strong><span className="backtest-muted">Excludes funding & unrealized PnL</span></LayerCard>
              <LayerCard className="deploy-card"><span className="backtest-muted">Trading fees</span><strong className="performance-value">{amount(metrics?.fees)} <small>USDC</small></strong><span className="backtest-muted">Recorded fills in this run</span></LayerCard>
              <LayerCard className="deploy-card"><span className="backtest-muted">Filled orders</span><strong className="performance-value">{fills.length}</strong><span className="backtest-muted">{run.orders.length} recorded {run.orders.length===1 ? "order" : "orders"}</span></LayerCard>
            </div>
            {!metrics && <Banner variant="alert" title="Incomplete fill data" description="PnL and fees cannot be calculated for this run."/>}
          </>}
          {run.error && <Banner variant="error" title="Execution needs attention" description={run.error}/>}
          {run.auditWarning && <Banner variant="alert" title="Audit history may be incomplete" description={run.auditWarning}/>}
          {logs ? <ExecutionLogPanel key={run.id} run={run}/> : <LayerCard className="deploy-card">
          <div className="deploy-runtime-heading"><h3>Order history</h3><Badge variant="neutral">{run.orders.length} {run.orders.length===1 ? "order" : "orders"}</Badge></div>
          <p className="backtest-muted">Newest first · Times in {Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
          {run.orders.length === 0 ? <p>No orders yet. Orders will appear when the strategy sends a signal.</p> :
          <div className="backtest-table-scroll">
            <Table aria-label="Exchange orders">
              <Table.Header>
                <Table.Row>
                  {[
                    "Time",
                    "Status",
                    "Side",
                    "Quantity",
                    "Price",
                    "Fee (USDC)",
                    "Exchange ID",
                  ].map((label) => (
                    <Table.Head key={label}>{label}</Table.Head>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {run.orders
                  .slice(-100)
                  .reverse()
                  .map((order) => (
                    <Table.Row key={order.id}>
                      <Table.Cell><time dateTime={order.at} title={order.at}>{displayTime(order.at)}</time></Table.Cell>
                      <Table.Cell>
                        <Badge variant={order.status === "filled" ? "success" : ["failed", "uncertain"].includes(order.status) ? "warning" : "neutral"}>{order.status}</Badge>
                      </Table.Cell>
                      <Table.Cell>{order.side ? order.side.charAt(0).toUpperCase()+order.side.slice(1) : "—"}</Table.Cell>
                      <Table.Cell>{order.quantity ?? "—"}</Table.Cell>
                      <Table.Cell>{order.price ?? "—"}</Table.Cell>
                      <Table.Cell>{amount(order.fee)}</Table.Cell>
                      <Table.Cell>
                        <span title={order.id}>
                          {order.exchangeOrderId ?? "Not confirmed"}
                        </span>
                      </Table.Cell>
                    </Table.Row>
                  ))}
              </Table.Body>
            </Table>
          </div>}
          {run.orders.length > 100 && <p className="backtest-muted">Showing the latest 100 orders for this run.</p>}
          </LayerCard>}
          <Collapsible.Root>
            <Collapsible.Trigger render={<Button size="sm" variant="ghost"/>}>Run details</Collapsible.Trigger>
            <Collapsible.Panel><LayerCard className="deploy-card">
              <p>Started: {displayTime(run.startedAt)}</p>
              <p>Last evaluation: {run.lastRunAt ? displayTime(run.lastRunAt) : 'Pending'}</p>
              <p>Last risk check: {run.riskCheckedAt ? displayTime(run.riskCheckedAt) : '—'}</p>
              <p>Recorded net quantity: {amount(run.position)} · Not a live exchange position</p>
              <p>Run ID: {run.id}</p>
            </LayerCard></Collapsible.Panel>
          </Collapsible.Root>


        </>
      )}
    </section>
  );
}
