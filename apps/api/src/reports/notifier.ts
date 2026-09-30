import { Logger } from "@nestjs/common";
import type { AnalyticsOutput } from "../analytics/analytics.service";

export interface Notifier {
  readonly enabled: boolean;
  sendReport(workspaceId: string, output: AnalyticsOutput): Promise<void>;
}
export const NOTIFIER = Symbol("NOTIFIER");

export function formatReportMessage(output: AnalyticsOutput, dashboardUrl: string): string {
  const { current } = output.periods;
  const lines = [`*Marketing report* ${current.startDate} → ${current.endDate}`];
  if (output.report) {
    lines.push(output.report.summary, "");
    output.report.recommendations.forEach((r, i) =>
      lines.push(`${i + 1}. *${r.title}*${r.requiresApproval ? " _(needs approval)_" : ""}\n   ${r.action}`));
  }
  if (output.dataQualityIssues.length) lines.push("", `:warning: ${output.dataQualityIssues.length} data-quality issue(s) — see dashboard`);
  lines.push("", `<${dashboardUrl}|Open dashboard>`);
  return lines.join("\n");
}

export class NoopNotifier implements Notifier {
  readonly enabled = false;
  async sendReport() {}
}

/** Posts to a Slack incoming webhook. Only hooks.slack.com over https is accepted. */
export class SlackNotifier implements Notifier {
  private readonly log = new Logger("SlackNotifier");
  readonly enabled = true;
  constructor(private readonly webhookUrl: string, private readonly dashboardUrl: string, private readonly fetchFn: typeof fetch = fetch) {}

  async sendReport(_workspaceId: string, output: AnalyticsOutput) {
    const res = await this.fetchFn(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: formatReportMessage(output, this.dashboardUrl) }),
    });
    if (!res.ok) throw new Error(`Slack responded ${res.status}`);
    this.log.log("report sent to Slack");
  }
}

export function createNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) return new NoopNotifier();
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "hooks.slack.com") throw new Error("not a Slack webhook");
  } catch {
    new Logger("Notifier").warn("SLACK_WEBHOOK_URL is not an https://hooks.slack.com URL; notifications disabled");
    return new NoopNotifier();
  }
  return new SlackNotifier(url, env.WEB_ORIGIN ?? "http://localhost:3000");
}
