export type Metric = "impressions" | "clicks" | "spend" | "conversions" | "revenue" | "ctr" | "conversionRate" | "cpc" | "cpa" | "roas";

export type Campaign = { id: string; name: string; channel: string; status: "draft" | "approved" | "active" | "paused"; source: "manual" | "seed" | "meta_ads" | "ga4"; createdAt: string };
export type Asset = { id: string; kind: string; variant: string; content: string; status: "draft" | "approved" | "rejected"; issues: string[]; maxLength: number | null };
export type CampaignDetail = Campaign & {
  brief: null | { objective: string; product: string; audience: string; channels: string[]; durationDays: number; budget?: number; constraints: string[] };
  plan: null | {
    positioning: string; keyMessage: string; audienceSegments: string[]; risks: string[];
    channels: { name: string; role: string; contentTypes: string[]; successMetrics: string[] }[];
  };
  assets: Asset[];
  experiments: { id: string; hypothesis: string; variable: string }[];
  /** The newest approval request for this campaign, if any. */
  approval: { id: string; status: "pending" | "approved" | "rejected"; decidedBy: string | null; decidedAt: string | null; note: string | null; createdAt: string } | null;
  /** The newest attempt to post this campaign to the ad platforms, if any. */
  publish: PublishInfo | null;
};

export type Approval = { id: string; action: string; summary: string; status: "pending" | "approved" | "rejected"; payload: { campaignId: string; note?: string }; decidedBy: string | null; createdAt: string };

export type GenerateResult = { runId: string; status: string; reused: boolean; output: { campaignId?: string; needsFixes?: string[]; planErrors?: string[]; contentErrors?: string[]; error?: string } };

export type Recommendation = {
  title: string; actionType: string; campaignId: string; action: string; rationale: string; measurableOutcome: string;
  evidence: { campaignId: string; metric: Metric; period: "current" | "previous"; value: number }[];
  requiresApproval: boolean; policyAction: string;
};
export type PeriodStats = Record<Metric, number | null> & { daysWithData: number };
export type AnalyticsOutput = {
  periods: { current: { startDate: string; endDate: string }; previous: { startDate: string; endDate: string } };
  dataQualityIssues: { campaignId: string; type: string; detail: string }[];
  anomalies: { campaignId: string; type: string; severity: "high" | "medium" | "info"; description: string; lowConfidence: boolean }[];
  facts: { campaignId: string; name: string; channel: string; current: PeriodStats; previous: PeriodStats; changes: Record<Metric, number | null>; dataQuality: { lowConfidence: boolean } }[];
  report: { summary: string; biggestChanges: string[]; recommendations: Recommendation[]; caveats: string[] } | null;
  note?: string; error?: string; errors?: string[];
};
export type AnalyticsRun = { id: string; status: string; output: AnalyticsOutput; createdAt: string };

export type ToolCall = { id: string; tool: string; args: unknown; result: unknown; status: "ok" | "error" | "blocked"; createdAt: string; runId: string };

export type Schedule = { id: string; cron: string; timezone: string; days: number; notify: boolean; createdAt: string };
export type EnqueueResult = { jobId: string; deduped: boolean };
export type JobInfo = { jobId: string; state: string; attemptsMade: number; failedReason?: string };

export type Provider = "ga4" | "meta_ads";
export type Connection = {
  id: string; provider: Provider; accountId: string; accountName: string | null;
  status: "ok" | "needs_reauth" | "error" | "never_synced" | "pending_account";
  tokenExpiresAt: string | null; conversionAction: string | null;
  /** null when background jobs are off on the server */
  autoSync: { cron: string; timezone: string } | null;
  lastSyncAt: string | null; lastError: string | null;
  lastSummary: { campaigns: number; rows: number; range: { startDate: string; endDate: string }; skipped: Record<string, number> } | null;
  createdAt: string;
};
export type OAuthStatus = Record<"google" | "meta", { configured: boolean }>;
export type Account = { id: string; name: string };
export type SyncOutcome =
  | { status: "succeeded"; runId: string; summary: NonNullable<Connection["lastSummary"]> }
  | { status: "failed"; runId: string; error: string; needsReauth: boolean };

export type PeriodTotals = { impressions: number; clicks: number; spend: number; conversions: number; revenue: number; ctr: number; conversionRate: number; cpc: number; cpa: number | null; roas: number | null; daysWithData: number };
export type CampaignPerformance = {
  campaign: { id: string; name: string; channel: string; status: Campaign["status"]; source: Campaign["source"] };
  days: number; latestDate: string | null;
  range: { startDate: string; endDate: string } | null; previousRange: { startDate: string; endDate: string } | null;
  daily: { date: string; impressions: number; clicks: number; spend: number; conversions: number; revenue: number }[];
  totals: PeriodTotals | null; previousTotals: PeriodTotals | null;
};

export type ActionKind = "create_task" | "pause_campaign" | "change_budget" | "publish_campaign";
export type ActionStatus = "awaiting_approval" | "executing" | "executed" | "shadowed" | "rejected" | "failed";
export type AgentAction = {
  id: string; type: ActionKind; status: ActionStatus; payload: Record<string, unknown>;
  preview: { summary: string; details: Record<string, unknown> }; result: Record<string, unknown> | null;
  source: "recommendation" | "campaign" | "manual"; sourceRef: string | null; approvalId: string | null;
  requestedBy: string; createdAt: string; executedAt: string | null;
};
export type ProposeResult = { action: AgentAction; reused: boolean };
export type Task = { id: string; title: string; description: string; campaignId: string | null; status: "open" | "done"; actionId: string | null; createdAt: string; doneAt: string | null };

export type CompanyItem = { id?: string; name: string; description: string };
export type Company = {
  name: string; onboarded: boolean; sample: boolean; voice: string;
  approvedClaims: string[]; prohibited: string[]; allowedDomains: string[];
  products: (CompanyItem & { id: string })[]; audiences: (CompanyItem & { id: string })[];
};

export type PublishingStatus = {
  mode: "demo" | "shadow" | "live"; maxDailyBudget: number; minDailyBudget: number | null; currency: string | null;
  meta: { connected: boolean; connectionId: string | null; accountName: string | null; canPublish: boolean; missing: string[]; defaults: { dailyBudget: number; country: string; pageId: string; landingUrl: string } | null };
  google: { available: boolean; reason: string };
};
export type MetaDetails = PublishingStatus & { accountActive: boolean | null; pages: { id: string; name: string }[] };
export type PublishInfo = { id: string; status: ActionStatus; result: Record<string, unknown> | null; createdAt: string; executedAt: string | null };
