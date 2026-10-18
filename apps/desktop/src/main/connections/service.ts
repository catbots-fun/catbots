import { FlowRunner, validateFlowTarget } from "./flow-runner";
import { HyperliquidFlowVenue } from "./flow-venue";
import type { ExchangeActivity, BotExecutionOverview, ChatFlowDraft } from "@catbots/contracts";
import {
  ExecutionTargetSchema,
  type ExecutionTarget,
  type ExecutionTargetView,
} from "@catbots/contracts";
import { ConnectionAuthorization } from "./authorization";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  ConnectionCommandSchema,
  ExchangeConnectionSchema,
  type ExchangeConnection,
  type ConnectionsView,
} from "@catbots/contracts";
import { HyperliquidAdapter, type ExchangeAdapter } from "./adapters";
export class ConnectionsService {
  private runner: FlowRunner;
  private activityCache = new Map<string, {at:number; value:Promise<ExchangeActivity>}>();
  private accountActivity(connection: ExchangeConnection, account:string) {
    const key=JSON.stringify([connection.adapterId,connection.environment,account.toLowerCase()]);
    const cached=this.activityCache.get(key);
    if(cached && Date.now()-cached.at<15000) return cached.value;
    const adapter=this.adapters.find(item=>item.descriptor.id===connection.adapterId);
    const value=adapter?.activity ? adapter.activity(account,connection.environment) : Promise.reject(new Error('Unavailable'));
    this.activityCache.set(key,{at:Date.now(),value});
    return value;
  }
  private starting = new Set<string>();
  private connections: ExchangeConnection[] = [];
  constructor(
    private path: string,
    private adapters: ExchangeAdapter[] = [new HyperliquidAdapter()],
    private authorization?: ConnectionAuthorization,
    private openWalletBrowser?: (id?: string) => Promise<void>,
    private getFlow?: (botId: string) => ChatFlowDraft | undefined,
  ) {
    this.runner = new FlowRunner(`${path}.runtime`);
    if (existsSync(path))
      this.connections = z
        .array(ExchangeConnectionSchema)
        .max(100)
        .parse(JSON.parse(readFileSync(path, "utf8")));
  }
  assertBotRemovable(botId:string) {
    const run=this.runner.get(botId);
    if(this.starting.has(botId)||run && ['running','stopping','interrupted'].includes(run.status)) throw new Error('BOT_ACTIVE');
    if(run?.orders.some(order=>['uncertain','submitting'].includes(order.status))) throw new Error('BOT_UNRESOLVED');
  }
  async dispose() {
    await this.runner.dispose();
  }
  private view(): ConnectionsView {
    return structuredClone({
      adapters: this.adapters.map((adapter) => adapter.descriptor),
      connections: this.connections,
    });
  }
  private save(next: ExchangeConnection[]) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
    renameSync(temp, this.path);
    this.connections = next;
  }
  private readTargets(): Record<string, ExecutionTarget> {
    return existsSync(`${this.path}.targets`)
      ? z
          .record(z.string().uuid(), ExecutionTargetSchema)
          .parse(JSON.parse(readFileSync(`${this.path}.targets`, "utf8")))
      : {};
  }
  private targetView(botId: string): ExecutionTargetView {
    const target = this.readTargets()[botId] ?? null;
    const connection = this.connections.find(
      (item) => item.id === target?.connectionId,
    );
    const account = connection?.accounts.find(
      (item) => item.id === target?.accountId,
    );
    return {
      target,
      ready: false,
      ...(connection
        ? {
            adapterId: connection.adapterId,
            environment: connection.environment,
          }
        : {}),
      ...(account ? { accountName: account.name } : {}),
    };
  }
  private async targetCommand(
    input: Extract<
      ReturnType<typeof ConnectionCommandSchema.parse>,
      { action: "get_target" | "save_target" | "check_target" }
    >,
  ): Promise<ConnectionsView> {
    const botId =
      input.action === "save_target" ? input.target.botId : input.botId;
    if (input.action === "save_target") {
      if (
        this.starting.has(botId) ||
        ["running", "stopping"].includes(this.runner.get(botId)?.status ?? "")
      )
        throw new Error("Stop the bot before changing its target");
      const connection = this.connections.find(
        (item) => item.id === input.target.connectionId,
      );
      if (
        !connection ||
        !connection.accounts.some((item) => item.id === input.target.accountId)
      )
        throw new Error("Select an account belonging to this connection");
      const next = { ...this.readTargets(), [botId]: input.target };
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.targets.tmp`, JSON.stringify(next), {
        mode: 0o600,
      });
      renameSync(`${this.path}.targets.tmp`, `${this.path}.targets`);
    }
    const view = this.targetView(botId);
    if (input.action === "check_target") {
      const connection = this.connections.find(
        (item) => item.id === view.target?.connectionId,
      );
      let authorized = false;
      let freshAccount = false;
      if (connection) {
        try {
          authorized = !!(await this.authorization?.verify(connection, false));
        } catch {}
        try {
          const adapter = this.adapters.find(
            (item) => item.descriptor.id === connection.adapterId,
          );
          const accounts = await adapter?.discover(
            connection.owner,
            connection.environment,
          );
          freshAccount = !!accounts?.some(
            (item) => item.id === view.target?.accountId,
          );
        } catch {}
      }
      let runtime = false;
      let runtimeDetail = "No valid packaged workflow";
      try {
        const draft = this.getFlow?.(botId);
        if (!draft || draft.status !== "valid")
          throw new Error("Validate the current workflow first");
        if (!view.target) throw new Error("Save an execution target first");
        validateFlowTarget(draft.document, view.target, connection?.environment);
        runtime = true;
        runtimeDetail = draft.document.nodes.some(node => node.type === "strategy.directional") ? "Testnet Long/Short · Exits checked at each evaluation while app is open; no exchange-native stop" : "Market IOC · Native exchange TP/SL for DCA";
      } catch (error) {
        runtimeDetail = error instanceof Error ? error.message : runtimeDetail;
      }
      let marketReady = false;
      let marketDetail = runtime
        ? "Select an authorized account first"
        : "Resolve workflow readiness first";
      if (
        authorized &&
        freshAccount &&
        runtime &&
        connection &&
        view.target &&
        this.authorization
      ) {
        try {
          const key = await this.authorization.executionKey(connection);
          const snapshot = await new HyperliquidFlowVenue(
            connection,
            view.target,
            key,
          ).snapshot([]);
          if (this.runner.foreignOrders(botId, snapshot))
            throw new Error("Resolve unrelated open orders first");
          if (snapshot.available <= 0)
            throw new Error("No available collateral");
          if (view.target.maxOrderUsd < 10)
            throw new Error("Order limit is below the $10 exchange minimum");
          marketReady = true;
          marketDetail = "Market and collateral available";
        } catch (error) {
          marketDetail =
            error instanceof Error ? error.message : "Market preflight failed";
        }
      }
      view.ready = authorized && freshAccount && runtime && marketReady;
      view.checks = [
        {
          label: "Trading account",
          passed: freshAccount,
          detail: freshAccount
            ? "Account found on the selected network"
            : "Account unavailable; check connection and network",
        },
        {
          label: "API wallet permission",
          passed: authorized,
          detail: authorized
            ? "Verified with the exchange"
            : "Authorize or renew this connection first",
        },
        {
          label: "Workflow execution runtime",
          passed: runtime,
          detail: runtimeDetail,
        },
        {
          label: "Market and collateral",
          passed: marketReady,
          detail: marketDetail,
        },
      ];
    }
    return {
      ...this.view(),
      executionTarget: view,
      deployment: this.runner.get(botId),
    };
  }
  async command(raw: unknown): Promise<ConnectionsView> {
    const input = ConnectionCommandSchema.parse(raw);
    if (input.action === 'set_flow_entries_paused') return { ...this.view(), deployment: this.runner.setEntriesPaused(input.botId, input.deploymentId, input.paused) };
    if (input.action === 'get_flow_audit_summary') return { ...this.view(), auditSummary: this.runner.auditSummary(input.botId) };
    if (input.action === "get_flow_audit") {
      const records = this.runner.auditHistory(input.botId, input.after, input.limit + 1, input.through);
      const more = records.length > input.limit;
      if (more) records.pop();
      return {
        ...this.view(),
        auditPage: { records, ...(more ? { nextAfter: records.at(-1)!.sequence } : {}) },
      };
    }
    if (input.action === "bot_overview") {
      const targets=this.readTargets();
      const botOverview:BotExecutionOverview[]=[];
      // Bound concurrency; shared accounts reuse the same cached request.
      for(let offset=0;offset<input.botIds.length;offset+=4) {
        botOverview.push(...await Promise.all(input.botIds.slice(offset,offset+4).map(async botId=>{
          const deployment=this.runner.get(botId);
          const target=deployment?.target ?? targets[botId];
          const connection=this.connections.find(item=>item.id===target?.connectionId);
          const result:BotExecutionOverview={botId,deployment,target,environment:deployment?.environment??connection?.environment};
          if(!target) return result;
          const account=connection?.accounts.find(item=>item.id.toLowerCase()===target.accountId.toLowerCase());
          if(!connection || !account) return {...result,activityError:'Connection or account unavailable'};
          result.accountName=account.name;
          try {result.activity=await this.accountActivity(connection,account.address);}
          catch {result.activityError='Exchange data unavailable. Retry refresh.';}
          return result;
        })));
      }
      return {...this.view(),botOverview};
    }
    if (input.action === "get_flow_runtime")
      return {
        ...this.view(),
        deployment: this.runner.get(input.botId),
        history: this.runner.history(input.botId),
      };
    if (input.action === "reconcile_flow") {
      const deployment = this.runner.get(input.botId);
      const connection = this.connections.find(
        (item) => item.id === deployment?.target.connectionId,
      );
      if (!deployment || !connection || !this.authorization)
        throw new Error("Saved deployment unavailable");
      const key = await this.authorization.executionKey(connection);
      return {
        ...this.view(),
        deployment: await this.runner.reconcile(
          input.botId,
          new HyperliquidFlowVenue(connection, deployment.target, key),
        ),
      };
    }
    if (input.action === "stop_flow")
      return {
        ...this.view(),
        deployment: await this.runner.stop(input.botId),
      };
    if (input.action === "start_flow") {
      if (this.starting.has(input.botId))
        throw new Error("Bot is already starting");
      this.starting.add(input.botId);
      try {
        const target = this.readTargets()[input.botId];
        const connection = this.connections.find(
          (item) => item.id === target?.connectionId,
        );
        const draft = this.getFlow?.(input.botId);
        if (
          !target ||
          !connection ||
          !draft ||
          draft.status !== "valid" ||
          draft.version !== input.version ||
          !connection.accounts.some((item) => item.id === target.accountId)
        )
          throw new Error("Reload and validate the workflow and target");
        if (input.confirmation !== `${connection.environment}:${target.market}`)
          throw new Error("Network and market confirmation required");
        if (connection.adapterId !== "hyperliquid" || !this.authorization)
          throw new Error("Execution adapter unavailable");
        const key = await this.authorization.executionKey(connection);
        return {
          ...this.view(),
          deployment: await this.runner.start(
            input.botId,
            draft.version,
            draft.document,
            target,
            connection.environment,
            new HyperliquidFlowVenue(connection, target, key),
          ),
        };
      } finally {
        this.starting.delete(input.botId);
      }
    }
    if (
      input.action === "get_target" ||
      input.action === "save_target" ||
      input.action === "check_target"
    )
      return this.targetCommand(input);
    if (input.action === "list") return this.view();
    if (input.action === "open_wallet_browser") {
      if (!this.openWalletBrowser)
        throw new Error("Wallet browser unavailable");
      await this.openWalletBrowser(input.id);
      return this.view();
    }
    if (
      input.action === "prepare_authorization" ||
      input.action === "complete_authorization" ||
      input.action === "verify_authorization"
    ) {
      if (this.runner.connectionRunning(input.id))
        throw new Error(
          "Stop bots on this connection before changing or checking authorization",
        );
      const connection = this.connections.find((item) => item.id === input.id);
      if (!connection || !this.authorization)
        throw new Error("Secure authorization unavailable");
      if (input.action === "prepare_authorization")
        return {
          ...this.view(),
          authorization: this.authorization.prepare(connection),
        };
      const valid =
        input.action === "complete_authorization"
          ? await this.authorization.complete(
              connection,
              input.signature as `0x${string}`,
            )
          : await this.authorization.verify(connection);
      this.save(
        this.connections.map((item) =>
          item.id === connection.id
            ? {
                ...item,
                authorizationCheckedAt: new Date().toISOString(),
                permission: valid
                  ? ("trading-authorized" as const)
                  : ("view-only" as const),
              }
            : item,
        ),
      );
      return this.view();
    }
    if (input.action === "remove") {
      if (
        Object.values(this.readTargets()).some(
          (target) => target.connectionId === input.id,
        )
      )
        throw new Error(
          "This connection is selected by a bot. Change its execution target before removing it.",
        );
      this.save(this.connections.filter((item) => item.id !== input.id));
      return this.view();
    }
    const existing =
      input.action === "refresh"
        ? this.connections.find((item) => item.id === input.id)
        : undefined;
    if (input.action === "refresh" && !existing)
      throw new Error("Connection not found");
    const source = input.action === "connect" ? input : existing!;
    const adapter = this.adapters.find(
      (item) => item.descriptor.id === source.adapterId,
    );
    if (
      !adapter ||
      !adapter.descriptor.environments.includes(source.environment)
    )
      throw new Error("Adapter or environment unavailable");
    const accounts = await adapter.discover(source.owner, source.environment);
    const owner = adapter.normalizeOwner(source.owner);
    const duplicate = this.connections.find(
      (item) =>
        item.adapterId === source.adapterId &&
        item.environment === source.environment &&
        item.owner === owner,
    );
    // A refresh that was removed while fetching must not resurrect the connection.
    if (existing && !this.connections.some((item) => item.id === existing.id))
      return this.view();
    const connection: ExchangeConnection = {
      id: existing?.id ?? duplicate?.id ?? randomUUID(),
      adapterId: source.adapterId,
      name: source.name,
      environment: source.environment,
      owner,
      permission: existing?.permission ?? duplicate?.permission ?? "view-only",
      authorizationCheckedAt:
        existing?.authorizationCheckedAt ?? duplicate?.authorizationCheckedAt,
      accounts,
      updatedAt: new Date().toISOString(),
    };
    const next = this.connections.filter((item) => item.id !== connection.id);
    if (next.length >= 100) throw new Error("Connection limit reached");
    this.save([...next, connection]);
    return this.view();
  }
}
