import { decide, type ActionType } from "@marketing/shared";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import {
  buildFacts, detectAnomalies, metricValue,
  type Anomaly, type CampaignFacts, type CampaignInput, type DataQualityIssue,
} from "./analysis";
import type { Recommender } from "./recommender";
import type { ModelReport } from "./report.schema";

export const MAX_ATTEMPTS = 2;
const MAX_RECOMMENDATIONS = 3;

const POLICY_ACTION: Record<string, ActionType> = {
  pause_creative: "pause",
  reallocate_budget: "change_budget",
  exclude_audience: "publish",
  new_variant: "draft",
  fix_landing_page: "draft",
  investigate_tracking: "report",
};

export type AnalyticsDeps = {
  loadData: (range: { startDate: string; endDate: string }) => Promise<CampaignInput[]>;
  recommender: Recommender;
  endDate: string;
  days: number;
};

const State = Annotation.Root({
  campaigns: Annotation<CampaignInput[]>(),
  periods: Annotation<ReturnType<typeof buildFacts>["periods"]>(),
  facts: Annotation<CampaignFacts[]>(),
  dataQualityIssues: Annotation<DataQualityIssue[]>(),
  anomalies: Annotation<Anomaly[]>(),
  report: Annotation<ModelReport | undefined>(),
  errors: Annotation<string[]>(),
  attempts: Annotation<number>(),
});
export type AnalyticsState = typeof State.State;

const approxEqual = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.005);

export function validateReport(report: ModelReport, facts: CampaignFacts[]): string[] {
  const errors: string[] = [];
  const byId = new Map(facts.map((f) => [f.campaignId, f]));
  if (report.recommendations.length === 0) errors.push("Provide at least one recommendation.");
  if (report.recommendations.length > MAX_RECOMMENDATIONS) errors.push(`Provide at most ${MAX_RECOMMENDATIONS} recommendations.`);
  report.recommendations.forEach((r, i) => {
    const tag = `recommendation ${i + 1}`;
    if (!byId.has(r.campaignId)) errors.push(`${tag}: unknown campaignId "${r.campaignId}".`);
    if (r.evidence.length === 0) errors.push(`${tag}: evidence is required.`);
    for (const e of r.evidence) {
      const f = byId.get(e.campaignId);
      if (!f) { errors.push(`${tag}: evidence references unknown campaign "${e.campaignId}".`); continue; }
      const actual = metricValue(f, e.period, e.metric);
      if (actual === null || !approxEqual(e.value, actual))
        errors.push(`${tag}: ${e.campaignId} ${e.period} ${e.metric} is ${actual}, not ${e.value}.`);
    }
  });
  return errors;
}

export function buildAnalyticsGraph(deps: AnalyticsDeps) {
  return new StateGraph(State)
    .addNode("load_data", async () => {
      const { periods } = buildFacts([], deps.endDate, deps.days);
      const campaigns = await deps.loadData({ startDate: periods.previous.startDate, endDate: periods.current.endDate });
      return { campaigns };
    })
    .addNode("assess", (s) => {
      const built = buildFacts(s.campaigns, deps.endDate, deps.days);
      return { ...built, anomalies: detectAnomalies(built.facts), attempts: 0, errors: [] };
    })
    .addNode("recommend", async (s) => {
      const report = await deps.recommender.recommend({
        periods: s.periods, facts: s.facts, anomalies: s.anomalies, dataQualityIssues: s.dataQualityIssues,
        feedback: s.errors.length ? s.errors : undefined,
      });
      return { report, attempts: s.attempts + 1 };
    })
    .addNode("validate", (s) => ({ errors: validateReport(s.report!, s.facts) }))
    .addEdge(START, "load_data")
    .addEdge("load_data", "assess")
    // Nothing to analyze: skip the model entirely rather than let it guess.
    .addConditionalEdges("assess", (s) => (s.facts.some((f) => f.current.daysWithData + f.previous.daysWithData > 0) ? "recommend" : END))
    .addEdge("recommend", "validate")
    .addConditionalEdges("validate", (s) => (s.errors.length && s.attempts < MAX_ATTEMPTS ? "recommend" : END))
    .compile();
}

const SEVERITY_RANK = { high: 0, medium: 1, info: 2 } as const;

/**
 * Attach deterministic approval requirements (the model's opinion on approval is never used)
 * and order recommendations by the severity of their campaign's confirmed anomalies.
 */
export function withApproval(report: ModelReport, anomalies: Anomaly[] = []) {
  const rank = (campaignId: string) =>
    Math.min(3, ...anomalies.filter((a) => a.campaignId === campaignId && !a.lowConfidence).map((a) => SEVERITY_RANK[a.severity]));
  const recommendations = report.recommendations
    .map((r, i) => {
      const policyAction = POLICY_ACTION[r.actionType] ?? "delete";
      return { r: { ...r, policyAction, requiresApproval: decide(policyAction) !== "auto" }, i };
    })
    .sort((a, b) => rank(a.r.campaignId) - rank(b.r.campaignId) || a.i - b.i) // stable
    .map((x) => x.r);
  return { ...report, recommendations };
}
