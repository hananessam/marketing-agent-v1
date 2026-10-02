"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { humanize, timeAgo } from "@/lib/format";
import type { AnalyticsOutput, AnalyticsRun, Approval, Campaign, Connection } from "@/lib/types";
import { Attention, CampaignTable, Changes, DataIssues, GettingStarted, Headline, NextSteps, periodLabel, type AttentionItem } from "@/components/home-parts";
import { Button, Card, Empty, ErrorBox, PageHeader } from "@/components/ui";

const PROVIDER_NAME = { ga4: "Google Analytics", meta_ads: "Meta Ads" } as const;
const STALE_DAYS = 2;

export default function HomePage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [now] = useState(() => Date.now()); // fixed at mount so rendering stays pure

  const runs = useQuery({ queryKey: ["analytics-runs"], queryFn: () => api<AnalyticsRun[]>("/analytics/runs") });
  const approvals = useQuery({ queryKey: ["approvals", "pending"], queryFn: () => api<Approval[]>("/approvals?status=pending") });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Connection[]>("/connections").catch(() => [] as Connection[]) });
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });

  const run = useMutation({
    mutationFn: () => api<{ runId: string; status: string; reused: boolean; output: AnalyticsOutput }>("/analytics/run", { method: "POST", body: { days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-runs"] }),
  });

  const latest = runs.data?.find((r) => r.status === "succeeded");
  const failed = run.data?.status === "failed" ? run.data : null;
  const loading = runs.isLoading;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="How your marketing is doing, what changed, and what to do next."
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="period">Compare</label>
            <select id="period" value={days} onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
            </select>
            <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Analyzing…" : latest ? "Refresh analysis" : "Run analysis"}</Button>
          </div>
        }
      />

      {run.isPending && (
        <div role="status" className="mb-4 rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          Analyzing your campaigns. This usually takes 15 to 30 seconds. You can keep this page open.
        </div>
      )}
      {run.error && <div className="mb-4"><ErrorBox error={run.error.message} /></div>}
      {run.data?.reused && <p className="mb-4 text-sm text-zinc-500">You already ran this comparison, so we showed the saved result instead of running it again.</p>}
      {failed && <div className="mb-4"><ErrorBox error="We couldn't finish the analysis." details={failureDetails(failed.output)} /></div>}
      {runs.error && <ErrorBox error={runs.error.message} />}
      {loading && <Empty>Loading…</Empty>}

      {runs.data && !latest && !run.isPending && (
        <GettingStarted hasConnections={(connections.data ?? []).length > 0} running={run.isPending} onRun={() => run.mutate()} />
      )}

      {latest && (
        <Report
          run={latest} now={now}
          attention={attentionItems({ latest, approvals: approvals.data, connections: connections.data, campaigns: campaigns.data, now })}
          campaigns={campaigns.data ?? []}
        />
      )}
    </>
  );
}

function failureDetails(o: AnalyticsOutput): string[] {
  const notes = [o.error, o.note, ...(o.errors ?? [])].filter((x): x is string => Boolean(x));
  return notes.length ? notes : ["Please try again in a moment."];
}

function attentionItems(a: { latest: AnalyticsRun; approvals?: Approval[]; connections?: Connection[]; campaigns?: Campaign[]; now: number }): AttentionItem[] {
  const items: AttentionItem[] = [];
  const pending = a.approvals?.length ?? 0;
  if (pending > 0) items.push({ key: "approvals", tone: "warn", title: `${pending} ${pending === 1 ? "approval is" : "approvals are"} waiting for you`, detail: "Nothing is published or spent until you decide.", href: "/approvals", cta: "Review" });

  for (const c of a.connections ?? []) {
    if (c.status === "needs_reauth" || c.status === "error") {
      items.push({ key: `conn-${c.id}`, tone: "bad", title: `${PROVIDER_NAME[c.provider]} needs attention`, detail: c.status === "needs_reauth" ? "Access expired or was removed, so new data is not coming in." : "The last data refresh failed.", href: "/connections", cta: c.status === "needs_reauth" ? "Reconnect" : "Fix" });
    }
  }

  if (a.campaigns?.some((c) => c.source === "seed")) {
    items.push({ key: "demo", tone: "info", title: "You are looking at sample data", detail: (a.connections ?? []).length ? "Remove the sample campaigns once your own data has arrived." : "Connect your own accounts to see your real campaigns here.", href: "/connections", cta: (a.connections ?? []).length ? "Manage" : "Connect accounts" });
  }

  const issues = a.latest.output.dataQualityIssues.length;
  if (issues > 0) items.push({ key: "quality", tone: "warn", title: `Some of your data is incomplete (${issues} ${issues === 1 ? "issue" : "issues"})`, detail: "Changes on those campaigns are marked as unconfirmed. Details are further down." });

  const ageDays = (a.now - Date.parse(a.latest.createdAt)) / 86_400_000;
  if (ageDays >= STALE_DAYS) items.push({ key: "stale", tone: "warn", title: `This analysis is ${Math.floor(ageDays)} days old`, detail: "Press “Refresh analysis” for up-to-date numbers." });

  if (items.length === 0) items.push({ key: "clear", tone: "good", title: "All clear", detail: "Nothing needs your attention right now." });
  return items;
}

function Report({ run, now, attention, campaigns }: { run: AnalyticsRun; now: number; attention: AttentionItem[]; campaigns: Campaign[] }) {
  const o = run.output;
  const names = new Map(o.facts.map((f) => [f.campaignId, f.name]));
  const source = new Map(campaigns.map((c) => [c.id, c.source]));
  // GA4 rows describe website visits, not ad spend; adding them to paid totals would double count.
  const paid = o.facts.filter((f) => source.get(f.campaignId) !== "ga4");
  const days = Math.round((Date.parse(o.periods.current.endDate) - Date.parse(o.periods.current.startDate)) / 86_400_000) + 1;
  const report = o.report;

  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-500">
        {periodLabel(o.periods)} · analysis from {timeAgo(run.createdAt, now)}
      </p>

      <Attention items={attention} />

      {paid.length > 0 && <Headline facts={paid} days={days} />}

      {report && (
        <>
          <Card title="In short">
            <p className="text-sm leading-relaxed">{humanize(report.summary, names)}</p>
            {report.caveats.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Things to keep in mind</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">{report.caveats.map((c, i) => <li key={i}>{humanize(c, names)}</li>)}</ul>
              </details>
            )}
          </Card>

          <Card title="What to do next">
            <NextSteps recs={report.recommendations} names={names} runId={run.id} />
          </Card>
        </>
      )}

      {o.anomalies.length > 0 && (
        <Card title="What changed">
          <Changes items={o.anomalies} names={names} />
        </Card>
      )}

      {o.dataQualityIssues.length > 0 && (
        <Card title="Gaps in your data">
          <DataIssues items={o.dataQualityIssues} names={names} />
          <p className="mt-3 text-xs text-zinc-500">Missing or late data can make a campaign look better or worse than it is, so we treat those changes as unconfirmed.</p>
        </Card>
      )}

      <Card title="All campaigns">
        <CampaignTable facts={o.facts} />
        <p className="mt-3 text-xs text-zinc-500">Arrows compare the latest period with the one before. Green is an improvement, red is a decline; spend is shown without a colour because spending more is not good or bad on its own.</p>
      </Card>

      <p className="text-xs text-zinc-500">All numbers come from your connected accounts. The AI only explains them and suggests actions; it cannot change anything.</p>
    </div>
  );
}
