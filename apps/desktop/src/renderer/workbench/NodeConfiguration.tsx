import { PlayIcon, ArrowLeftIcon } from '@phosphor-icons/react';
import { nodePresentation, nodeVisualCategory } from './node-presentation';
import { useState, type ReactNode } from 'react';
import { Badge, Banner, Button, Input, Select, Switch, Tabs } from '@cloudflare/kumo';
import type { CatbotsDesktopApi, ChatFlowDraft } from '@catbots/contracts';
import type { FlowRun } from '@catbots/strategy-runtime/node-examples';
import { configFields, editorDefinition } from './flow-editor-model';
import { flowDocumentKey, useFlowWorkspaceState, type FlowWorkspaceState } from './flow-workspace-state';
import { runLiveNode, marketCaption } from './live-node-run';
import { NodeDataPanel, type DataPort } from './NodeDataPanel';
import { NodeDetailLayout } from './NodeDetailLayout';
type Node = ChatFlowDraft['document']['nodes'][number];
export function NodeConfiguration({ draft, node, disabled, onSave, onClose, onDebug, initialRun, nodeApi, workspace: sharedWorkspace, onSelectNode, connections }: {
  connections?: ReactNode; workspace?: FlowWorkspaceState; nodeApi?: CatbotsDesktopApi['nodes']; initialRun?: FlowRun | null; draft: ChatFlowDraft; node: Node; disabled?: boolean; onSave?: (node: Node) => Promise<void>; onClose(): void; onDebug?(run: FlowRun): void; onSelectNode?(id: string): void;
}) {
  const def = editorDefinition(node)!;
  const visual = nodePresentation[nodeVisualCategory(def.category, node.type)];
  const NodeIcon = visual.icon;
  const localWorkspace = useFlowWorkspaceState();
  const workspace = sharedWorkspace ?? localWorkspace;
  const config = workspace.edits[node.id]?.config ?? node.config;
  const market = workspace.market;
  const running = workspace.running;
  const error = workspace.errors[node.id] ?? '';
  const setError = (value: string) => workspace.setError(node.id, value);
  const [tab, setTab] = useState('parameters');
  const [saving, setSaving] = useState(false);
  // Both panels always inspect the same execution. Never mix an old input with a new output.
  const record = workspace.selectedRunId ? workspace.history.find(item => item.run.runId === workspace.selectedRunId) : workspace.results[node.id];
  const run = record?.run ?? initialRun ?? null;
  const dirty = JSON.stringify(config) !== JSON.stringify(node.config);
  const conflict = dirty && workspace.edits[node.id]?.base !== JSON.stringify(node.config);
  const anyDirty = draft.document.nodes.some(item => workspace.edits[item.id] && JSON.stringify(workspace.edits[item.id]!.config) !== JSON.stringify(item.config));
  const stale = !!record && (record.documentKey !== flowDocumentKey(draft) || record.run.market !== market || anyDirty);
  const trace = run?.trace.find(item => item.nodeId === node.id);
  const fields = Object.entries(configFields(node.type, node.version).properties ?? {});
  const label = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, value => value.toUpperCase());
  const ports = (direction: 'inputs' | 'outputs'): DataPort[] => Object.entries(def[direction]).map(([name, type]) => ({
    name, type, value: trace?.[direction][name],
    connections: draft.document.edges.filter(edge => direction === 'inputs' ? edge.target === node.id && edge.targetPort === name : edge.source === node.id && edge.sourcePort === name).map(edge => {
      const nodeId = direction === 'inputs' ? edge.source : edge.target;
      const connected = draft.document.nodes.find(item => item.id === nodeId);
      return { nodeId, label: editorDefinition(connected)?.title ?? nodeId, port: direction === 'inputs' ? edge.sourcePort : edge.targetPort };
    }),
  }));
  const execute = async () => {
    workspace.setRunning(true); setError('');
    try { const next = await runLiveNode(draft.document, node.id, nodeApi, market); workspace.record({ ...next, documentKey: flowDocumentKey(draft) }); onDebug?.(next.run); }
    catch { setError('Market run failed. Check the market, timeframe and connection. No sample data was used.'); }
    finally { workspace.setRunning(false); }
  };
  const save = async () => {
    const parsed = def.config.safeParse(config);
    if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')); return; }
    setSaving(true); setError('');
    try { await onSave?.({ ...node, config: parsed.data as Record<string, unknown> }); workspace.saved(node.id, config); }
    catch { setError('Could not save. The flow may have changed; review the current revision before retrying.'); }
    finally { setSaving(false); }
  };
  return <NodeDetailLayout header={<header className="node-detail-header">
    <div className={`node-detail-identity node-category-${nodeVisualCategory(def.category, node.type)}`}><span className="strategy-node-icon"><NodeIcon size={22} weight="duotone" aria-hidden="true" /></span><h2>{def.title}</h2><Badge variant="secondary">{visual.label}</Badge></div>
    {onSelectNode && <Select size="sm" label="Node" value={node.id} onValueChange={id => onSelectNode(String(id))} renderValue={id => editorDefinition(draft.document.nodes.find(item => item.id === id))?.title ?? String(id)}>{draft.document.nodes.map(item => <Select.Option key={item.id} value={item.id}>{editorDefinition(item)?.title ?? item.type} · {item.id}</Select.Option>)}</Select>}
    <Button size="sm" variant="ghost" onClick={onClose}><ArrowLeftIcon size={14} aria-hidden="true" />Back to canvas</Button>
  </header>} input={<NodeDataPanel key={`in:${node.id}:${run?.runId}`} direction="input" ports={ports('inputs')} trigger={def.category === 'trigger'} onSelectNode={onSelectNode} />} output={<NodeDataPanel key={`out:${node.id}:${run?.runId}`} direction="output" ports={ports('outputs')} onSelectNode={onSelectNode} />} parameters={<>
    <div className="node-parameters-heading"><h3>Configuration</h3><Button size="sm" variant="primary" loading={running} disabled={anyDirty || disabled || running || saving || !market.trim()} onClick={() => void execute()}><PlayIcon size={14} weight="fill" aria-hidden="true" />Execute step</Button></div>
    <Tabs tabs={[{ value: 'parameters', label: 'Parameters' }, { value: 'settings', label: 'Settings' }]} value={tab} onValueChange={setTab} />
    {error && <Banner variant="error" title="Node needs attention" description={error} />}
    {conflict && <Banner variant="alert" title="Saved configuration changed" description="Your edits are kept. Review them against the latest flow or Reset before saving." />}
    {tab === 'parameters' ? <div className="node-parameter-fields">
      {fields.length === 0 && <p>No parameters required. This node uses connected inputs or the run context.</p>}
      {fields.map(([key, field]) => {
        const value = config[key] ?? field.default;
        const update = (value: unknown) => workspace.edit(node.id, { ...config, [key]: value }, node.config);
        return field.enum ? <Select key={key} size="base" label={label(key)} value={String(value ?? '')} onValueChange={value => update(String(value))}>{field.enum.map(value => <Select.Option key={value} value={value}>{value}</Select.Option>)}</Select>
          : field.type === 'boolean' ? <Switch key={key} label={label(key)} checked={value === true} onCheckedChange={update} />
          : <Input key={key} size="base" label={label(key)} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} value={String(value ?? '')} min={field.minimum} max={field.maximum} disabled={saving} onChange={event => update(field.type === 'number' || field.type === 'integer' ? event.target.value === '' ? '' : Number(event.target.value) : event.target.value)} />;
      })}
      <div className="provider-actions"><Button size="sm" disabled={!dirty || conflict || disabled || !onSave || saving} loading={saving} onClick={() => void save()}>Save configuration</Button><Button size="sm" variant="ghost" disabled={!dirty || saving} onClick={() => { workspace.reset(node.id); setError(''); }}>Reset</Button></div>
      {dirty && <Badge variant="info">Unsaved changes</Badge>}
      {anyDirty && <p>Save or reset unsaved node settings before executing.</p>}
      {disabled && <p>Wait for AI to finish before saving changes.</p>}{connections}
    </div> : <dl className="node-contract-details"><div><dt>Definition</dt><dd>{node.type} · v{node.version}</dd></div><div><dt>Package</dt><dd>{def.packageName}</dd></div><div><dt>Execution</dt><dd>{def.category === 'trigger' ? 'Starts an evaluation' : def.activation ? `Runs when ${def.activation} is active` : 'Evaluates connected input data'}</dd></div><div><dt>Run scope</dt><dd>Selected node and required upstream nodes. Fresh manual state; orders are proposals only.</dd></div></dl>}
    <section className="node-run-context"><h4>Run context</h4><p><strong>{market}</strong> · From workspace</p><p>Exchange market data · Simulation only</p><p>Change the shared market above the Flow tabs. Account equity is unavailable in node tests.</p>
      {!!workspace.history.length && <Select size="sm" label="Execution" value={record?.run.runId ?? ''} onValueChange={id => workspace.setSelectedRunId(String(id))} renderValue={id => { const item = workspace.history.find(item => item.run.runId === id); return item ? `${item.run.market} · ${new Date(item.snapshot.fetchedAt).toLocaleTimeString()}` : String(id); }}>{workspace.history.map(item => <Select.Option key={item.run.runId} value={item.run.runId}>{item.run.market} · {new Date(item.snapshot.fetchedAt).toLocaleString()} · {item.run.runId.slice(0, 8)}</Select.Option>)}</Select>}
      {record && <><p>Run ID: {record.run.runId}</p><p>{marketCaption(record.snapshot)}</p></>}
      {trace && <Badge variant="info">{trace.status} · {run!.trace.length} nodes evaluated</Badge>}
      {run && !trace && <p>This node was not evaluated in the selected execution.</p>}
      {stale && <Banner variant="alert" title="Previous run · stale" description="These values belong to an earlier market or configuration. Save changes and execute again to refresh." />}
    </section>
  </>} />;
}
