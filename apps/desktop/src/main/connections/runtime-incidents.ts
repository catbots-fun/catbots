import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { RuntimeIncidentSchema, type RuntimeIncident, type FlowDeployment } from '@catbots/contracts';

const StateSchema = z.object({
  conditions: z.record(z.string(), z.array(RuntimeIncidentSchema.shape.code)),
  events: z.array(RuntimeIncidentSchema).max(200),
  lastAttemptAt: z.number().finite().optional(),
});
type State = z.infer<typeof StateSchema>;
function conditions(run: FlowDeployment, previous: RuntimeIncident['code'][]): RuntimeIncident['code'][] {
  const codes: RuntimeIncident['code'][] = [];
  if (run.status === 'failed') codes.push('runtime_failed');
  if (run.status === 'interrupted') codes.push('runtime_interrupted');
  if (run.health?.state === 'stalled') codes.push('runtime_stalled');
  if (run.failureCode === 'snapshot_unavailable') codes.push('exchange_snapshot_unavailable');
  if (run.failureCode === 'position_mismatch') codes.push('position_mismatch');
  if (run.orders.some(order => order.status === 'uncertain')) codes.push('order_uncertain');
  if (run.closeResult === 'needs-attention' || (previous.includes('close_unverified') && run.closeResult !== 'closed')) codes.push('close_unverified');
  if (run.protection && !['protected','flat'].includes(run.protection.status)) codes.push('protection_attention');
  return codes;
}

/** Read-only observer: never modifies the trading runtime or retries its orders. */
export class RuntimeIncidents {
  private state: State;
  private busy = false;
  constructor(private path: string, private notify: (event: RuntimeIncident) => Promise<void>) {
    this.state = existsSync(path) ? StateSchema.parse(JSON.parse(readFileSync(path,'utf8'))) : {conditions:{},events:[]};
  }
  list(botId: string) { return structuredClone(this.state.events.filter(event => event.botId === botId).reverse()); }
  private save(next: State) {
    mkdirSync(dirname(this.path),{recursive:true});
    writeFileSync(`${this.path}.tmp`,JSON.stringify(next),{mode:0o600});
    renameSync(`${this.path}.tmp`,this.path);
    this.state = next;
  }
  async scan(runs: FlowDeployment[], now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const next = structuredClone(this.state);
      for (const event of next.events) if (event.delivery === 'pending' && event.attempts >= 3) event.delivery = 'unavailable';
      for (const run of runs) {
        for (const event of next.events) if (event.botId === run.botId && event.deploymentId !== run.id && event.delivery === 'pending') event.delivery = 'unavailable';
        const key = JSON.stringify([run.botId,run.id]);
        const previous = next.conditions[key] ?? [];
        const current = conditions(run,previous);
        for (const code of new Set([...previous,...current])) {
          if (previous.includes(code) === current.includes(code)) continue;
          // Do not deliver obsolete queued detections or recoveries.
          for (const event of next.events) if (event.deploymentId === run.id && event.code === code && event.delivery === 'pending') event.delivery = 'unavailable';
          next.events.push({id:randomUUID(),botId:run.botId,deploymentId:run.id,code,phase:current.includes(code)?'detected':'cleared',at:new Date(now).toISOString(),delivery:'pending',attempts:0});
        }
        next.conditions[key] = current;
      }
      next.events = next.events.slice(-200);
      if (JSON.stringify(next) !== JSON.stringify(this.state)) this.save(next);
      // Global rate limit also bounds floods when many bots change at once.
      if (this.state.lastAttemptAt !== undefined && now - this.state.lastAttemptAt < 30000) return;
      const event = this.state.events.find(item => item.delivery === 'pending' && item.attempts < 3);
      if (!event) return;
      const reserved = structuredClone(this.state);
      reserved.lastAttemptAt = now;
      const attempt = reserved.events.find(item => item.id === event.id)!;
      attempt.attempts++;
      // Crash after reservation consumes an attempt; it cannot reset the retry budget.
      this.save(reserved);
      let shown = false;
      try { await this.notify(structuredClone(attempt)); shown = true; } catch { /* Never persist destination errors. */ }
      const finished = structuredClone(this.state);
      const result = finished.events.find(item => item.id === event.id)!;
      result.delivery = shown ? 'shown' : result.attempts >= 3 ? 'unavailable' : 'pending';
      this.save(finished);
    } finally { this.busy = false; }
  }
}
