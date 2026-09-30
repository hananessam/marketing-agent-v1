import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { addDays, type CampaignInput } from "./analysis";
import { buildAnalyticsGraph, withApproval } from "./graph";
import { RECOMMENDER, type Recommender } from "./recommender";

export type AnalyticsOutput = {
  periods: { current: { startDate: string; endDate: string }; previous: { startDate: string; endDate: string } };
  dataQualityIssues: { campaignId: string; type: string; detail: string }[];
  report: ReturnType<typeof withApproval> | null;
};

export const RunAnalyticsBody = z.object({
  endDate: z.iso.date().optional(),
  days: z.number().int().min(3).max(30).default(7),
});
export type RunAnalyticsBody = z.infer<typeof RunAnalyticsBody>;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly tools: ToolRunnerService,
    private readonly runs: RunsService,
    @Inject(RECOMMENDER) private readonly recommender: Recommender,
  ) {}

  async run(workspaceId: string, body: RunAnalyticsBody) {
    // Last complete day (UTC) unless told otherwise.
    const endDate = body.endDate ?? addDays(new Date().toISOString().slice(0, 10), -1);
    const days = body.days;
    const key = `analytics:${days}:${endDate}`;

    const existing = this.runs.findByKey(workspaceId, key);
    if (existing) return { runId: existing.id, status: existing.status, reused: true, output: existing.output };

    let runId: string;
    try {
      runId = this.runs.start(workspaceId, "analytics", { endDate, days }, key);
    } catch {
      // Lost a race with a concurrent identical request.
      const raced = this.runs.findByKey(workspaceId, key)!;
      return { runId: raced.id, status: raced.status, reused: true, output: raced.output };
    }

    try {
      const graph = buildAnalyticsGraph({
        endDate, days, recommender: this.recommender,
        loadData: (range) => this.loadData(workspaceId, runId, range),
      });
      const s = await graph.invoke({});

      if (s.report && s.errors.length === 0) {
        const output = {
          periods: s.periods, dataQualityIssues: s.dataQualityIssues, anomalies: s.anomalies, facts: s.facts,
          report: withApproval(s.report, s.anomalies),
        };
        this.runs.finish(workspaceId, runId, "succeeded", output);
        return { runId, status: "succeeded" as const, reused: false, output };
      }
      if (!s.report) {
        // No data to analyze: report that honestly instead of letting a model guess.
        const output = { periods: s.periods, dataQualityIssues: s.dataQualityIssues, anomalies: [], facts: s.facts, report: null, note: "No metrics available for the requested periods." };
        this.runs.finish(workspaceId, runId, "failed", output);
        return { runId, status: "failed" as const, reused: false, output };
      }
      const output = { errors: s.errors, attempts: s.attempts, rejectedReport: s.report };
      this.runs.finish(workspaceId, runId, "failed", output);
      return { runId, status: "failed" as const, reused: false, output };
    } catch (e) {
      const output = { error: e instanceof Error ? e.message : String(e) };
      this.runs.finish(workspaceId, runId, "failed", output);
      return { runId, status: "failed" as const, reused: false, output };
    }
  }

  get(workspaceId: string, runId: string) {
    return this.runs.get(workspaceId, runId);
  }

  list(workspaceId: string) {
    return this.runs.list(workspaceId, "analytics");
  }

  /** Data access goes through the audited read tools, never straight to the DB. */
  private async loadData(workspaceId: string, runId: string, range: { startDate: string; endDate: string }): Promise<CampaignInput[]> {
    const listed = await this.tools.run(workspaceId, runId, "list_campaigns", {});
    if (listed.status !== "ok") throw new Error(`list_campaigns failed: ${listed.error}`);
    const campaigns = (listed.result as { id: string; name: string; channel: string; status: string }[]).filter((c) => c.status === "active");

    const out: CampaignInput[] = [];
    for (const c of campaigns) {
      const m = await this.tools.run(workspaceId, runId, "get_campaign_metrics", { campaignId: c.id, ...range });
      if (m.status !== "ok") throw new Error(`get_campaign_metrics failed for ${c.id}: ${m.error}`);
      out.push({ campaignId: c.id, name: c.name, channel: c.channel, daily: (m.result as { daily: CampaignInput["daily"] }).daily });
    }
    return out;
  }
}
