"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatMetric } from "@/lib/format";
import type { CampaignPerformance, Metric } from "@/lib/types";
import { Tile } from "@/components/tile";
import { Badge, Empty, ErrorBox, PageHeader } from "@/components/ui";

const delta = (cur: number | null | undefined, prev: number | null | undefined) => (cur == null || prev == null || prev === 0 ? null : (cur - prev) / prev);

/** Bars with a text alternative; hover shows the exact value. */
function Bars({ title, values, dates, metric }: { title: string; values: number[]; dates: string[]; metric: Metric }) {
  const top = Math.max(...values, 1);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-zinc-500">{title}</p>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`${title} per day, ${dates[0]} to ${dates[dates.length - 1]}`}>
        {values.map((v, i) => (
          <div key={dates[i]} className="flex-1 rounded-t bg-zinc-400 hover:bg-zinc-600 dark:bg-zinc-600 dark:hover:bg-zinc-400"
            style={{ height: `${Math.max((v / top) * 100, v > 0 ? 3 : 0)}%` }} title={`${dates[i]}: ${formatMetric(metric, v)}`} />
        ))}
      </div>
    </div>
  );
}

/** How a campaign is doing, for campaigns that were not drafted here (sample data, or synced from Meta / Google). */
export function CampaignPerformanceView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["campaign-performance", id], queryFn: () => api<CampaignPerformance>(`/campaigns/${id}/performance?days=7`) });
  if (q.isLoading) return <Empty>Loading…</Empty>;
  if (q.error) return <ErrorBox error={q.error.message} />;
  const { campaign: c, totals: t, previousTotals: prev, daily } = q.data!;
  const ga4 = c.source === "ga4"; // website visits only: no spend or ad efficiency

  return (
    <div className="space-y-5">
      <Link href="/campaigns" className="text-sm text-zinc-500 underline">← All campaigns</Link>
      <PageHeader title={c.name} actions={c.source === "seed" ? <Badge>Sample data</Badge> : undefined} />
      {!t ? (
        <p className="text-sm text-zinc-500">No numbers yet. <Link href="/settings" className="underline">Update your accounts</Link> to pull them in.</p>
      ) : (
        <>
          <p className="text-sm text-zinc-500">Last 7 days compared with the 7 before.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {ga4 ? (
              <>
                <Tile metric="clicks" value={t.clicks} delta={delta(t.clicks, prev?.clicks)} goodWhen="up" />
                <Tile metric="conversions" value={t.conversions} delta={delta(t.conversions, prev?.conversions)} goodWhen="up" />
                <Tile metric="revenue" value={t.revenue} delta={delta(t.revenue, prev?.revenue)} goodWhen="up" />
                <Tile metric="conversionRate" value={t.conversionRate} delta={delta(t.conversionRate, prev?.conversionRate)} goodWhen="up" />
              </>
            ) : (
              <>
                <Tile metric="spend" value={t.spend} delta={delta(t.spend, prev?.spend)} goodWhen="neutral" />
                <Tile metric="conversions" value={t.conversions} delta={delta(t.conversions, prev?.conversions)} goodWhen="up" />
                <Tile metric="revenue" value={t.revenue} delta={delta(t.revenue, prev?.revenue)} goodWhen="up" />
                <Tile metric="roas" value={t.roas} delta={delta(t.roas, prev?.roas)} goodWhen="up" />
              </>
            )}
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <Bars title={ga4 ? "Visits per day" : "Spend per day"} metric={ga4 ? "clicks" : "spend"} dates={daily.map((d) => d.date)} values={daily.map((d) => (ga4 ? d.clicks : d.spend))} />
            <Bars title="Conversions per day" metric="conversions" dates={daily.map((d) => d.date)} values={daily.map((d) => d.conversions)} />
          </div>
        </>
      )}
    </div>
  );
}
