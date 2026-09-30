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
