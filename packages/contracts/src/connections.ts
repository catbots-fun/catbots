import { z } from "zod";
export type AdapterDescriptor = {
  id: string;
  name: string;
  environments: ("production" | "testnet")[];
  authentication: ("public-address" | "wallet" | "api-key" | "oauth")[];
  capabilities: {
    accountDiscovery: boolean;
    markets: string[];
    trading: boolean;
  };
};
export const TradingAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["main", "subaccount", "portfolio"]),
  address: z.string(),
  equity: z.string(),
  withdrawable: z.string(),
  positions: z.number().int().nonnegative(),
  accountMode: z.string().optional(),
  usdcBalance: z.string().optional(),
});
export const ExchangeConnectionSchema = z.object({
  id: z.string().uuid(),
  adapterId: z.string(),
  name: z.string(),
  environment: z.enum(["production", "testnet"]),
  owner: z.string(),
  permission: z.enum(["view-only", "trading-authorized"]),
  authorizationCheckedAt: z.string().datetime().optional(),
  accounts: z.array(TradingAccountSchema),
  updatedAt: z.string().datetime(),
});
export type ExchangeConnection = z.infer<typeof ExchangeConnectionSchema>;
export type TradingAccount = z.infer<typeof TradingAccountSchema>;

export const ExecutionTargetSchema = z
  .object({
    botId: z.string().uuid(),
    connectionId: z.string().uuid(),
    accountId: z.string().min(1),
    market: z.string().regex(/^[A-Z0-9]{1,20}-PERP$/),
    maxPositionUsd: z.number().finite().positive().max(1e9),
    maxOrderUsd: z.number().finite().positive().max(1e9),
  })
  .strict()
  .refine(
    (value) => value.maxOrderUsd <= value.maxPositionUsd,
    "Order limit cannot exceed position limit",
  );
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;
export type ExecutionTargetView = {
  target: ExecutionTarget | null;
  adapterId?: string;
  environment?: "production" | "testnet";
  accountName?: string;
  checks?: { label: string; passed: boolean; detail: string }[];
  ready: boolean;
};

export const ConnectionCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("bot_overview"), botIds: z.array(z.string().uuid()).max(100) }).strict(),
  z
    .object({
      action: z.literal("start_flow"),
      botId: z.string().uuid(),
      version: z.number().int().positive(),
      confirmation: z.string().min(1),
    })
    .strict(),
  z
    .object({ action: z.literal("reconcile_flow"), botId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("stop_flow"), botId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("get_flow_runtime"), botId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("get_target"), botId: z.string().uuid() })
    .strict(),
  z
    .object({ action: z.literal("save_target"), target: ExecutionTargetSchema })
    .strict(),
  z
    .object({ action: z.literal("check_target"), botId: z.string().uuid() })
    .strict(),
  z.object({ action: z.literal("open_wallet_browser"), id: z.string().uuid().optional() }).strict(),
  z
    .object({
      action: z.literal("prepare_authorization"),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("verify_authorization"),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("complete_authorization"),
      id: z.string().uuid(),
      signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("connect"),
      adapterId: z.string().min(1).max(64),
      name: z.string().trim().min(1).max(80),
      environment: z.enum(["production", "testnet"]),
      owner: z.string().trim().min(1).max(200),
    })
    .strict(),
  z.object({ action: z.literal("refresh"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("remove"), id: z.string().uuid() }).strict(),
]);
export type ConnectionCommand = z.infer<typeof ConnectionCommandSchema>;
export type FlowDeployment = {
  id: string;
  botId: string;
  version: number;
  environment: "production" | "testnet";
  target: ExecutionTarget;
  status: "running" | "stopping" | "stopped" | "failed" | "interrupted";
  startedAt: string;
  lastRunAt?: string;
  error?: string;
  cycles: number;
  orders: {
    id: string;
    status: string;
    at: string;
    quantity?: number;
    price?: number;
    fee?: number;
    side?: string;
    exchangeOrderId?: string;
    nodeId?: string;
  }[];
  events: string[];
  position?: number;
  riskCheckedAt?: string;
  protection?: {
    mode: "exchange";
    status: string;
    orders: {
      id: string;
      kind: string;
      triggerPrice: number;
      status: string;
    }[];
  };
  trace?: unknown;
};
export type ExchangeActivity = {
  fetchedAt: string;
  positions: { market: string; size: string; entryPrice: string | null; unrealizedPnl: string }[];
  orders: { id: string; market: string; side: string; size: string; price: string }[];
};
export type BotExecutionOverview = {
  botId: string;
  deployment?: FlowDeployment;
  target?: ExecutionTarget;
  environment?: "production" | "testnet";
  accountName?: string;
  activity?: ExchangeActivity;
  activityError?: string;
};
export type ConnectionsView = {
  botOverview?: BotExecutionOverview[];
  history?: FlowDeployment[];
  deployment?: FlowDeployment;
  executionTarget?: ExecutionTargetView;
  authorization?: {
    connectionId: string;
    owner: string;
    environment: string;
    typedData: unknown;
  };
  adapters: AdapterDescriptor[];
  connections: ExchangeConnection[];
};
