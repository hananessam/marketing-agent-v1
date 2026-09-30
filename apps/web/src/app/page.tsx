"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { formatChange, formatMetric, label } from "@/lib/format";
import type { AnalyticsOutput, AnalyticsRun, Metric } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, statusTone } from "@/components/ui";

const TABLE_METRICS: Metric[] = ["ctr", "conversionRate", "cpa", "roas", "spend"];
// For these, an increase is bad.
const LOWER_IS_BETTER = new Set<Metric>(["cpa", "cpc"]);

export default function AnalyticsPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const runs = useQuery({ queryKey: ["analytics-runs"], queryFn: () => api<AnalyticsRun[]>("/analytics/runs") });
  const run = useMutation({
    mutationFn: () => api<{ runId: string; status: string; reused: boolean; output: AnalyticsOutput }>("/analytics/run", { method: "POST", body: { days } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-runs"] }),
  });

  const latest = runs.data?.find((r) => r.status === "succeeded");
  const failed = run.data && run.data.status === "failed" ? run.data : null;

  return (
    <>
      <PageHeader
        title="Performance analysis"
        subtitle="Compares the last period with the one before, checks data quality, and proposes next actions."
        actions={
          <div className="flex items-center gap-2">
            <select aria-label="Period length" value={days} onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
            </select>
            <Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Analyzing…" : "Run analysis"}</Button>
          </div>
        }
      />
      {run.error && <div className="mb-4"><ErrorBox error={run.error.message} /></div>}
      {run.data?.reused && <p className="mb-4 text-sm text-zinc-500">A run for this period already exists, so the stored result is shown. Nothing was re-run.</p>}
      {failed && <div className="mb-4"><ErrorBox error="The analysis run failed" details={failureDetails(failed.output)} /></div>}
      {runs.isLoading && <Empty>Loading…</Empty>}
      {runs.error && <ErrorBox error={runs.error.message} />}
      {runs.data && !latest && <Card><Empty>No completed analysis yet. Click “Run analysis”.</Empty></Card>}
      {latest && <Report run={latest} />}
    </>
  );
}

function failureDetails(o: AnalyticsOutput): string[] {
  return [o.error, o.note, ...(o.errors ?? [])].filter((x): x is string => Boolean(x));
}

function Report({ run }: { run: AnalyticsRun }) {
  const o = run.output;
  const names = new Map(o.facts.map((f) => [f.campaignId, f.name]));
  const report = o.report;
  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500">
        {o.periods.current.startDate} → {o.periods.current.endDate} vs {o.periods.previous.startDate} → {o.periods.previous.endDate}
      </p>

      {o.dataQualityIssues.length > 0 && (
        <Card title="Data quality">
          <ul className="space-y-1 text-sm">
            {o.dataQualityIssues.map((i, n) => (
              <li key={n}><Badge tone="warn">{label(i.type)}</Badge> <span className="font-medium">{names.get(i.campaignId) ?? i.campaignId}</span>: {i.detail}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-zinc-500">Changes on these campaigns are treated as unconfirmed.</p>
        </Card>
      )}

      {report && (
        <>
          <Card title="Summary"><p className="text-sm leading-relaxed">{report.summary}</p></Card>
          <Card title="Recommended actions">
            <ol className="space-y-4">
              {report.recommendations.map((r, i) => (
                <li key={i} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{i + 1}. {r.title}</span>
                    <Badge tone="info">{label(r.actionType)}</Badge>
                    <Badge tone={r.requiresApproval ? "warn" : "good"}>{r.requiresApproval ? "needs approval" : "no approval needed"}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">{names.get(r.campaignId) ?? r.campaignId}</p>
                  <p className="mt-2 text-sm">{r.action}</p>
                  <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{r.rationale}</p>
                  <p className="mt-1 text-sm"><span className="font-medium">Success looks like:</span> {r.measurableOutcome}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {r.evidence.map((e, n) => (
                      <span key={n} className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                        {e.metric} ({e.period}): {formatMetric(e.metric, e.value)}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
          {report.caveats.length > 0 && (
            <Card title="Caveats"><ul className="list-disc space-y-1 pl-5 text-sm">{report.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul></Card>
          )}
        </>
      )}

      {o.anomalies.length > 0 && (
        <Card title="Detected changes">
          <ul className="space-y-1.5 text-sm">
            {o.anomalies.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(a.severity)}>{a.severity}</Badge>
                <span className="font-medium">{names.get(a.campaignId) ?? a.campaignId}</span>
                <span>{a.description}</span>
                {a.lowConfidence && <Badge tone="warn">unconfirmed: data gaps</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Campaign metrics" className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="pb-2 font-medium">Campaign</th>
              {TABLE_METRICS.map((m) => <th key={m} className="pb-2 font-medium">{label(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {o.facts.map((f) => (
              <tr key={f.campaignId} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-2 pr-3">{f.name}<div className="text-xs text-zinc-500">{label(f.channel)}</div></td>
                {TABLE_METRICS.map((m) => {
                  const ch = f.changes[m];
                  const worse = ch !== null && Math.abs(ch) >= 0.1 && (LOWER_IS_BETTER.has(m) ? ch > 0 : ch < 0);
                  const better = ch !== null && Math.abs(ch) >= 0.1 && !worse && m !== "spend";
                  return (
                    <td key={m} className="py-2 pr-3 align-top">
                      {formatMetric(m, f.current[m])}
                      <div className={`text-xs ${worse ? "text-red-600 dark:text-red-400" : better ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}`}>{formatChange(ch)}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
