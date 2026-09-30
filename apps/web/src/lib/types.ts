export type Metric = "impressions" | "clicks" | "spend" | "conversions" | "revenue" | "ctr" | "conversionRate" | "cpc" | "cpa" | "roas";

export type Campaign = { id: string; name: string; channel: string; status: "draft" | "approved" | "active" | "paused"; createdAt: string };
export type Asset = { id: string; kind: string; variant: string; content: string; status: "draft" | "approved" | "rejected" };
export type CampaignDetail = Campaign & {
  brief: { objective: string; product: string; audience: string; channels: string[]; durationDays: number; budget?: number; constraints: string[] };
  plan: {
    positioning: string; keyMessage: string; audienceSegments: string[]; risks: string[];
    channels: { name: string; role: string; contentTypes: string[]; successMetrics: string[] }[];
  };
  assets: Asset[];
  experiments: { id: string; hypothesis: string; variable: string }[];
};

export type Approval = { id: string; action: string; summary: string; status: "pending" | "approved" | "rejected"; payload: { campaignId: string }; decidedBy: string | null; createdAt: string };

export type GenerateResult = { runId: string; status: string; reused: boolean; output: { campaignId?: string; planErrors?: string[]; contentErrors?: string[]; error?: string } };

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
