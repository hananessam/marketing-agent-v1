import Link from "next/link";
import type { ReactNode } from "react";
import { ACTION_LABEL, ANOMALY_LABEL, DATA_ISSUE_LABEL, METRIC_LABEL, dateRange, formatChange, formatMetric, humanize } from "@/lib/format";
import type { AnalyticsOutput, Metric, Recommendation } from "@/lib/types";
import { Badge, Button, Card } from "@/components/ui";

type Facts = AnalyticsOutput["facts"];

// ---------------------------------------------------------------- headline numbers

const sum = (facts: Facts, period: "current" | "previous", m: "spend" | "conversions" | "revenue") =>
  facts.reduce((t, f) => t + (f[period][m] ?? 0), 0);

export type Totals = { spend: number; conversions: number; revenue: number; roas: number | null };
export function totalsFor(facts: Facts, period: "current" | "previous"): Totals {
  const spend = sum(facts, period, "spend");
  const revenue = sum(facts, period, "revenue");
  return { spend, conversions: sum(facts, period, "conversions"), revenue, roas: spend ? revenue / spend : null };
}

const change = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : (cur - prev) / prev);

function Tile({ metric, value, delta, goodWhen, days }: { metric: Metric; value: number | null; delta: number | null; goodWhen: "up" | "down" | "neutral"; days: number }) {
  const meta = METRIC_LABEL[metric];
  const flat = delta === null || Math.abs(delta) < 0.02;
  const good = !flat && goodWhen !== "neutral" && (delta! > 0) === (goodWhen === "up");
  const bad = !flat && goodWhen !== "neutral" && !good;
  const tone = flat || goodWhen === "neutral" ? "text-zinc-500" : good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" title={meta.hint}>
      <p className="text-xs font-medium text-zinc-500">{meta.name}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{formatMetric(metric, value)}</p>
      <p className={`mt-1 text-xs ${tone}`}>
        {delta === null ? "No comparison yet" : flat ? "About the same" : <><span aria-hidden>{delta > 0 ? "▲" : "▼"}</span> {formatChange(delta)} <span className="sr-only">{bad ? "(worse)" : good ? "(better)" : ""}</span></>}
        <span className="text-zinc-500"> vs previous {days} days</span>
      </p>
    </div>
  );
}

export function Headline({ facts, days }: { facts: Facts; days: number }) {
  const cur = totalsFor(facts, "current");
  const prev = totalsFor(facts, "previous");
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile metric="spend" value={cur.spend} delta={change(cur.spend, prev.spend)} goodWhen="neutral" days={days} />
      <Tile metric="conversions" value={cur.conversions} delta={change(cur.conversions, prev.conversions)} goodWhen="up" days={days} />
      <Tile metric="revenue" value={cur.revenue} delta={change(cur.revenue, prev.revenue)} goodWhen="up" days={days} />
      <Tile metric="roas" value={cur.roas} delta={change(cur.roas, prev.roas)} goodWhen="up" days={days} />
    </div>
  );
}

// ---------------------------------------------------------------- attention strip

export type AttentionItem = { key: string; tone: "warn" | "bad" | "info" | "good"; title: string; detail: string; href?: string; cta?: string };

const BORDER = {
  warn: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40",
  bad: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40",
  info: "border-blue-300 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40",
  good: "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40",
};

export function Attention({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="grid gap-3 md:grid-cols-2" aria-label="Things that need your attention">
      {items.map((i) => (
        <li key={i.key} className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${BORDER[i.tone]}`}>
          <div className="min-w-0">
            <p className="text-sm font-medium">{i.title}</p>
            <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{i.detail}</p>
          </div>
          {i.href && <Link href={i.href} className="shrink-0 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800">{i.cta ?? "Open"}</Link>}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- next steps

export function NextSteps({ recs, names }: { recs: Recommendation[]; names: Map<string, string> }) {
  if (recs.length === 0) return <p className="text-sm text-zinc-500">Nothing to do right now.</p>;
  return (
    <ol className="space-y-3">
      {recs.map((r, i) => (
        <li key={i} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <div className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900" aria-hidden>{i + 1}</span>
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">{humanize(r.title, names)}</h3>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone="info">{ACTION_LABEL[r.actionType] ?? r.actionType.replace(/_/g, " ")}</Badge>
                <Badge>{names.get(r.campaignId) ?? "Campaign"}</Badge>
                <Badge tone={r.requiresApproval ? "warn" : "good"}>{r.requiresApproval ? "Needs your approval first" : "Safe to do right away"}</Badge>
              </div>
              <p className="mt-3 text-sm"><span className="font-medium">What to do: </span>{humanize(r.action, names)}</p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400"><span className="font-medium text-zinc-900 dark:text-zinc-100">Why: </span>{humanize(r.rationale, names)}</p>
              <p className="mt-1 text-sm"><span className="font-medium">How you will know it worked: </span>{humanize(r.measurableOutcome, names)}</p>
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Show the numbers</summary>
                <table className="mt-2 w-full text-xs">
                  <thead><tr className="text-left text-zinc-500"><th className="py-1 pr-3 font-medium">Measure</th><th className="py-1 pr-3 font-medium">Period</th><th className="py-1 font-medium">Value</th></tr></thead>
                  <tbody>
                    {r.evidence.map((e, n) => (
                      <tr key={n} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="py-1 pr-3" title={METRIC_LABEL[e.metric].hint}>{METRIC_LABEL[e.metric].name}</td>
                        <td className="py-1 pr-3 text-zinc-500">{e.period === "current" ? "Latest period" : "Previous period"}</td>
                        <td className="py-1 font-mono">{formatMetric(e.metric, e.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- what changed

const SEVERITY = { high: { dot: "bg-red-500", text: "Big change" }, medium: { dot: "bg-amber-500", text: "Worth a look" }, info: { dot: "bg-blue-500", text: "Good to know" } } as const;

export function Changes({ items, names }: { items: AnalyticsOutput["anomalies"]; names: Map<string, string> }) {
  return (
    <ul className="space-y-2 text-sm">
      {items.map((a, i) => (
        <li key={i} className="flex items-start gap-2">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEVERITY[a.severity].dot}`} aria-hidden />
          <span>
            <span className="sr-only">{SEVERITY[a.severity].text}: </span>
            <span className="font-medium">{names.get(a.campaignId) ?? "Campaign"}</span>: {ANOMALY_LABEL[a.type] ?? a.type.replace(/_/g, " ")}.{" "}
            <span className="text-zinc-500">{humanize(a.description, names)}</span>
            {a.lowConfidence && <> <Badge tone="warn">Unconfirmed: data is incomplete</Badge></>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DataIssues({ items, names }: { items: AnalyticsOutput["dataQualityIssues"]; names: Map<string, string> }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((i, n) => (
        <li key={n}><span className="font-medium">{names.get(i.campaignId) ?? "Campaign"}</span>: {DATA_ISSUE_LABEL[i.type] ?? i.type}. <span className="text-zinc-500">{humanize(i.detail, names)}</span></li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- campaigns table

const COLUMNS: { metric: Metric; lowerIsBetter?: boolean; neutral?: boolean }[] = [
  { metric: "spend", neutral: true }, { metric: "conversions" }, { metric: "conversionRate" }, { metric: "cpa", lowerIsBetter: true }, { metric: "roas" },
];

export function CampaignTable({ facts }: { facts: Facts }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-500">
            <th className="pb-2 font-medium">Campaign</th>
            {COLUMNS.map((c) => <th key={c.metric} className="pb-2 font-medium" title={METRIC_LABEL[c.metric].hint}>{METRIC_LABEL[c.metric].name}</th>)}
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.campaignId} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-2 pr-3">{f.name}<div className="text-xs text-zinc-500">{f.channel.replace(/_/g, " ")}{f.dataQuality.lowConfidence ? " · incomplete data" : ""}</div></td>
              {COLUMNS.map((c) => {
                const ch = f.changes[c.metric];
                const big = ch !== null && Math.abs(ch) >= 0.1;
                const worse = big && !c.neutral && (c.lowerIsBetter ? ch > 0 : ch < 0);
                const better = big && !c.neutral && !worse;
                return (
                  <td key={c.metric} className="py-2 pr-3 align-top">
                    {formatMetric(c.metric, f.current[c.metric])}
                    <div className={`text-xs ${worse ? "text-red-600 dark:text-red-400" : better ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-500"}`}>
                      {ch === null ? "" : `${ch > 0 ? "▲" : ch < 0 ? "▼" : ""} ${formatChange(ch)}`}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- first run

export function GettingStarted({ hasConnections, onRun, running }: { hasConnections: boolean; onRun: () => void; running: boolean }) {
  const steps: { n: number; title: string; body: ReactNode; done?: boolean }[] = [
    { n: 1, title: "Connect your accounts", done: hasConnections, body: <>Link Google Analytics and Meta Ads on the <Link href="/connections" className="underline">Connections</Link> page. It is read-only: nothing can be changed in your ad accounts.</> },
    { n: 2, title: "Run your first analysis", body: "We compare the last week with the week before, look for problems, and write up what to do next." },
    { n: 3, title: "Review and approve", body: "Anything that spends money or sends messages waits for your approval first." },
  ];
  return (
    <Card title="Welcome. Here is how to get started">
      <ol className="space-y-4">
        {steps.map((s) => (
          <li key={s.n} className="flex gap-3">
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-emerald-600 text-white" : "bg-zinc-200 dark:bg-zinc-800"}`} aria-hidden>{s.done ? "✓" : s.n}</span>
            <div><p className="text-sm font-medium">{s.title}{s.done && <span className="sr-only"> (done)</span>}</p><p className="text-sm text-zinc-500">{s.body}</p></div>
          </li>
        ))}
      </ol>
      <div className="mt-5"><Button onClick={onRun} disabled={running}>{running ? "Analyzing…" : "Run my first analysis"}</Button></div>
    </Card>
  );
}

export const periodLabel = (p: AnalyticsOutput["periods"]) => `${dateRange(p.current.startDate, p.current.endDate)} compared with ${dateRange(p.previous.startDate, p.previous.endDate)}`;
