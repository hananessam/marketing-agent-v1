import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey();
const workspaceId = () => text("workspace_id").notNull().references(() => workspaces.id);
const createdAt = () => text("created_at").notNull().$defaultFn(() => new Date().toISOString());

export const workspaces = sqliteTable("workspaces", { id: id(), name: text("name").notNull(), createdAt: createdAt() });

export const brandProfiles = sqliteTable("brand_profiles", {
  id: id(), workspaceId: workspaceId(),
  voice: text("voice").notNull(),
  approvedClaims: text("approved_claims", { mode: "json" }).$type<string[]>().notNull(),
  prohibited: text("prohibited", { mode: "json" }).$type<string[]>().notNull(),
  allowedDomains: text("allowed_domains", { mode: "json" }).$type<string[]>().notNull().default([]),
});

export const products = sqliteTable("products", {
  id: id(), workspaceId: workspaceId(), name: text("name").notNull(), description: text("description").notNull(),
});

export const audiences = sqliteTable("audiences", {
  id: id(), workspaceId: workspaceId(), name: text("name").notNull(), description: text("description").notNull(),
});

export const campaigns = sqliteTable("campaigns", {
  id: id(), workspaceId: workspaceId(),
  name: text("name").notNull(),
  channel: text("channel").notNull(),
  status: text("status", { enum: ["draft", "approved", "active", "paused"] }).notNull(),
  /** Where the campaign came from: manual/agent drafts, demo seed, or a connector. */
  source: text("source", { enum: ["manual", "seed", "meta_ads", "ga4"] }).notNull().default("manual"),
  brief: text("brief", { mode: "json" }),
  plan: text("plan", { mode: "json" }),
  createdAt: createdAt(),
});

export const campaignAssets = sqliteTable("campaign_assets", {
  id: id(), workspaceId: workspaceId(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  kind: text("kind").notNull(), // email_subject, ad_headline, ...
  variant: text("variant").notNull(),
  content: text("content").notNull(),
  status: text("status", { enum: ["draft", "approved", "rejected"] }).notNull(),
  createdAt: createdAt(),
});

export const campaignMetrics = sqliteTable(
  "campaign_metrics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: workspaceId(),
    campaignId: text("campaign_id").notNull().references(() => campaigns.id),
    channel: text("channel").notNull(),
    date: text("date").notNull(),
    impressions: integer("impressions").notNull(),
    clicks: integer("clicks").notNull(),
    spend: real("spend").notNull(),
    conversions: integer("conversions").notNull(),
    revenue: real("revenue").notNull(),
    ingestedAt: text("ingested_at").notNull(),
  },
  (t) => [uniqueIndex("metrics_uniq").on(t.workspaceId, t.campaignId, t.date), index("metrics_date").on(t.workspaceId, t.date)],
);

export const experiments = sqliteTable("experiments", {
  id: id(), workspaceId: workspaceId(),
  campaignId: text("campaign_id").notNull().references(() => campaigns.id),
  hypothesis: text("hypothesis").notNull(), variable: text("variable").notNull(),
});

export const agentRuns = sqliteTable("agent_runs", {
  id: id(), workspaceId: workspaceId(),
  kind: text("kind").notNull(), // analytics | planner
  status: text("status", { enum: ["running", "succeeded", "failed", "awaiting_approval"] }).notNull(),
  idempotencyKey: text("idempotency_key"),
  input: text("input", { mode: "json" }), output: text("output", { mode: "json" }),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("runs_idem").on(t.workspaceId, t.idempotencyKey)]);

export const toolCalls = sqliteTable("tool_calls", {
  id: id(), workspaceId: workspaceId(),
  runId: text("run_id").notNull().references(() => agentRuns.id),
  tool: text("tool").notNull(),
  args: text("args", { mode: "json" }), result: text("result", { mode: "json" }),
  status: text("status", { enum: ["ok", "error", "blocked"] }).notNull(),
  createdAt: createdAt(),
});

export const approvals = sqliteTable("approvals", {
  id: id(), workspaceId: workspaceId(),
  runId: text("run_id").references(() => agentRuns.id),
  action: text("action").notNull(),
  summary: text("summary").notNull(), // exact action + affected campaign
  payload: text("payload", { mode: "json" }),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull(),
  decidedBy: text("decided_by"), decidedAt: text("decided_at"),
  createdAt: createdAt(),
});

export const reportSchedules = sqliteTable("report_schedules", {
  id: id(), workspaceId: workspaceId(),
  cron: text("cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  days: integer("days").notNull(),
  notify: integer("notify", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
});

export const connections = sqliteTable("connections", {
  id: id(), workspaceId: workspaceId(),
  provider: text("provider", { enum: ["meta_ads", "ga4"] }).notNull(),
  /** Non-secret account identifier (Meta ad account id / GA4 property id). */
  accountId: text("account_id").notNull(),
  /** AES-256-GCM blob (base64) holding OAuth tokens. Never returned by the API. */
  encryptedSecret: text("encrypted_secret").notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
  status: text("status", { enum: ["ok", "needs_reauth", "error", "never_synced", "pending_account"] }).notNull().default("never_synced"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  lastSummary: text("last_summary", { mode: "json" }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("connections_uniq").on(t.workspaceId, t.provider, t.accountId)]);

/** One row per in-flight OAuth consent. Single-use: deleted when the callback consumes it. */
export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  workspaceId: workspaceId(),
  provider: text("provider", { enum: ["meta_ads", "ga4"] }).notNull(),
  /** Set when re-authorizing an existing connection. */
  connectionId: text("connection_id"),
  codeVerifier: text("code_verifier"),
  expiresAt: text("expires_at").notNull(),
  createdAt: createdAt(),
});

/** Something the agent proposes to do (or the user asks for). External ones are recorded in shadow mode, not performed. */
export const actions = sqliteTable("actions", {
  id: id(), workspaceId: workspaceId(),
  type: text("type", { enum: ["create_task", "pause_campaign", "change_budget", "schedule_email", "publish_campaign"] }).notNull(),
  status: text("status", { enum: ["awaiting_approval", "executing", "executed", "shadowed", "rejected", "failed"] }).notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  /** What would happen, written at proposal time so the approver sees it before deciding. */
  preview: text("preview", { mode: "json" }).$type<{ summary: string; details: Record<string, unknown> }>().notNull(),
  result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
  source: text("source", { enum: ["recommendation", "campaign", "manual"] }).notNull(),
  sourceRef: text("source_ref"),
  approvalId: text("approval_id"),
  requestedBy: text("requested_by").notNull(),
  /** Hash of type + payload + source. Unique while the action is live, so the same proposal cannot run twice. */
  idempotencyKey: text("idempotency_key"),
  createdAt: createdAt(),
  executedAt: text("executed_at"),
}, (t) => [uniqueIndex("actions_idem").on(t.workspaceId, t.idempotencyKey), index("actions_ws").on(t.workspaceId, t.status)]);

export const tasks = sqliteTable("tasks", {
  id: id(), workspaceId: workspaceId(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  campaignId: text("campaign_id"),
  status: text("status", { enum: ["open", "done"] }).notNull().default("open"),
  actionId: text("action_id"),
  createdAt: createdAt(),
  doneAt: text("done_at"),
}, (t) => [index("tasks_ws").on(t.workspaceId, t.status)]);
