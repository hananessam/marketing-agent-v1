"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { dateRange, formatMetric, label, timeAgo } from "@/lib/format";
import type { CampaignPerformance, Metric, PeriodTotals } from "@/lib/types";
import { Tile } from "@/components/home-parts";
import { Badge, Card, Empty, ErrorBox, PageHeader, statusTone } from "@/components/ui";

const SOURCE_LABEL = { manual: "Drafted here", seed: "Sample data", meta_ads: "From Meta Ads", ga4: "From Google Analytics" } as const;
const delta = (cur: number | null | undefined, prev: number | null | undefined) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / prev);

/** Daily bars with a text alternative; the table below carries the exact numbers. */
function Bars({ title, values, dates, metric }: { title: string; values: number[]; dates: string[]; metric: Metric }) {
  const top = Math.max(...values, 1);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-500">{title}</p>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`${title} per day, from ${dates[0]} to ${dates[dates.length - 1]}. Exact values are in the table below.`}>
        {values.map((v, i) => (
          <div key={dates[i]} className="flex-1 rounded-t bg-zinc-400 hover:bg-zinc-600 dark:bg-zinc-600 dark:hover:bg-zinc-400"
            style={{ height: `${Math.max((v / top) * 100, v > 0 ? 3 : 0)}%` }} title={`${dates[i]}: ${formatMetric(metric, v)}`} />
        ))}
      </div>
    </div>
  );
}

export function CampaignPerformanceView({ id }: { id: string }) {
  const [days, setDays] = useState(7);
  const [now] = useState(() => Date.now());
  const q = useQuery({ queryKey: ["campaign-performance", id, days], queryFn: () => api<CampaignPerformance>(`/campaigns/${id}/performance?days=${days}`) });

  if (q.isLoading) return <Empty>Loading…</Empty>;
  if (q.error) return <ErrorBox error={q.error.message} />;
  const p = q.data!;
  const c = p.campaign;
  const t = p.totals;
  const prev = p.previousTotals;
  const ga4 = c.source === "ga4"; // website visits only: no views, spend or ad efficiency
  const staleDays = p.latestDate ? Math.floor((now - Date.parse(`${p.latestDate}T00:00:00Z`)) / 86_400_000) : null;

  const tiles: { metric: Metric; key: keyof PeriodTotals; good: "up" | "down" | "neutral"; name?: string }[] = ga4
    ? [{ metric: "clicks", key: "clicks", good: "up" }, { metric: "conversions", key: "conversions", good: "up" }, { metric: "revenue", key: "revenue", good: "up" }, { metric: "conversionRate", key: "conversionRate", good: "up" }]
    : [{ metric: "spend", key: "spend", good: "neutral" }, { metric: "conversions", key: "conversions", good: "up" }, { metric: "revenue", key: "revenue", good: "up" }, { metric: "roas", key: "roas", good: "up" },
       { metric: "ctr", key: "ctr", good: "up" }, { metric: "cpa", key: "cpa", good: "down" }];

  return (
    <div className="space-y-5">
      <Link href="/campaigns" className="text-sm text-zinc-500 underline">← All campaigns</Link>
      <PageHeader
        title={c.name}
        subtitle={`${label(c.channel)} · ${SOURCE_LABEL[c.source]}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(c.status)}>{c.status}</Badge>
            <label className="sr-only" htmlFor="perf-days">Period</label>
            <select id="perf-days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
              <option value={7}>Last 7 days</option><option value={14}>Last 14 days</option><option value={30}>Last 30 days</option>
            </select>
          </div>
        }
      />

      {c.source === "seed" && <p className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">This is sample data, not a real campaign.</p>}

      {!t || !p.range ? (
        <Card title="No numbers yet">
          <p className="text-sm text-zinc-500">
            We don&apos;t have any data for this campaign.{" "}
            {c.source === "meta_ads" || c.source === "ga4" ? <>Open <Link href="/connections" className="underline">Connections</Link> and press “Sync now”.</> : "Once it is running and connected, its numbers will appear here."}
          </p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-zinc-500">
            {dateRange(p.range.startDate, p.range.endDate)}
            {prev && p.previousRange ? ` compared with ${dateRange(p.previousRange.startDate, p.previousRange.endDate)}` : " · no earlier period to compare with yet"}
            {t.daysWithData < p.days && ` · ${t.daysWithData} of ${p.days} days have data`}
          </p>
          {staleDays !== null && staleDays >= 3 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              The latest data is from {timeAgo(`${p.latestDate}T00:00:00Z`, now)} ({p.latestDate}). Recent days may be missing.
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            {tiles.map((x) => <Tile key={x.metric} metric={x.metric} value={t[x.key] as number | null} delta={delta(t[x.key] as number | null, prev?.[x.key] as number | null | undefined)} goodWhen={x.good} days={p.days} />)}
          </div>

          <Card title="Day by day">
            <div className="grid gap-6 md:grid-cols-2">
              <Bars title={ga4 ? "Visits" : "Spend"} metric={ga4 ? "clicks" : "spend"} dates={p.daily.map((d) => d.date)} values={p.daily.map((d) => (ga4 ? d.clicks : d.spend))} />
              <Bars title="Conversions" metric="conversions" dates={p.daily.map((d) => d.date)} values={p.daily.map((d) => d.conversions)} />
            </div>
            <details className="mt-5 text-sm">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Show the numbers</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[520px] text-xs">
                  <thead><tr className="text-left text-zinc-500">
                    <th className="py-1 pr-3 font-medium">Date</th>
                    {!ga4 && <th className="py-1 pr-3 font-medium">Views</th>}
                    <th className="py-1 pr-3 font-medium">{ga4 ? "Visits" : "Clicks"}</th>
                    {!ga4 && <th className="py-1 pr-3 font-medium">Spend</th>}
                    <th className="py-1 pr-3 font-medium">Conversions</th><th className="py-1 font-medium">Revenue</th>
                  </tr></thead>
                  <tbody>
                    {[...p.daily].reverse().map((d) => (
                      <tr key={d.date} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="py-1 pr-3">{d.date}</td>
                        {!ga4 && <td className="py-1 pr-3 font-mono">{formatMetric("impressions", d.impressions)}</td>}
                        <td className="py-1 pr-3 font-mono">{formatMetric("clicks", d.clicks)}</td>
                        {!ga4 && <td className="py-1 pr-3 font-mono">{formatMetric("spend", d.spend)}</td>}
                        <td className="py-1 pr-3 font-mono">{formatMetric("conversions", d.conversions)}</td>
                        <td className="py-1 font-mono">{formatMetric("revenue", d.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </Card>

          {ga4 && <p className="text-xs text-zinc-500">Google Analytics reports website visits, so there are no views, spend or ad-efficiency figures here. “Visits” are sessions and “Conversions” are key events you set up in Analytics.</p>}
        </>
      )}
    </div>
  );
}
