"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { humanize, timeAgo } from "@/lib/format";
import type { AnalyticsOutput, AnalyticsRun, Campaign, Company, Connection, ProposeResult, Recommendation, Task } from "@/lib/types";
import { CompanyForm } from "@/components/company-form";
import { Tile } from "@/components/tile";
import { Button, Card, Empty, ErrorBox, PageHeader } from "@/components/ui";

const PROVIDER_NAME = { ga4: "Google Analytics", meta_ads: "Meta Ads" } as const;

/** First run: the home page is only the company form. Once it is saved, the home page is the Overview. */
export default function HomePage() {
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  if (company.isLoading) return null; // the frame shows the loading state
  if (company.error) return <ErrorBox error={company.error.message} />;
  if (company.data && !company.data.onboarded) return <Onboarding company={company.data} />;
  return <Home />;
}

function Onboarding({ company }: { company: Company }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Tell us about your company</h1>
      <p className="mb-6 mt-1 text-sm text-zinc-500">
        This takes a few minutes. The assistant uses it to write drafts in your voice and to check them against your rules. Nothing is ever published without your approval.
      </p>
      <CompanyForm initial={company} mode="onboarding" />
    </>
  );
}

function Home() {
  const qc = useQueryClient();
  const [now] = useState(() => Date.now()); // fixed at mount so rendering stays pure

  const runs = useQuery({ queryKey: ["analytics-runs"], queryFn: () => api<AnalyticsRun[]>("/analytics/runs") });
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });
  const connections = useQuery({ queryKey: ["connections"], queryFn: () => api<Connection[]>("/connections").catch(() => [] as Connection[]) });

  const run = useMutation({
    // Pressing the button means "look again now", not "show me the report from earlier today".
    mutationFn: () => api<{ status: string; output: AnalyticsOutput }>("/analytics/run", { method: "POST", body: { days: 7, refresh: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["analytics-runs"] }),
  });
  // The newest finished check decides what is shown: if it failed (for example there is no data any more), an older report is not.
  const newest = runs.data?.find((r) => r.status !== "running");
  const latest = newest?.status === "succeeded" ? newest : undefined;
  const failed = newest?.status === "failed" ? newest : run.data?.status === "failed" ? run.data : null;

  const notices = notesFor(campaigns.data ?? [], connections.data ?? []);

  return (
    <>
      <PageHeader title="Home" actions={<Button onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Checking your numbers…" : latest ? "Refresh" : "Check my numbers"}</Button>} />

      {notices.length > 0 && (
        <ul className="mb-5 space-y-2">
          {notices.map((n) => (
            <li key={n.text} className="flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">
              <span>{n.text}</span><Link href={n.href} className="shrink-0 font-medium underline">{n.cta}</Link>
            </li>
          ))}
        </ul>
      )}

      {run.error && <div className="mb-4"><ErrorBox error={run.error.message} /></div>}
      {failed && <div className="mb-4"><ErrorBox error="We couldn't check your numbers just now. Please try again." details={[failed.output.error, failed.output.note].filter((x): x is string => Boolean(x))} /></div>}
      {runs.isLoading && <Empty>Loading…</Empty>}

      {runs.data && !latest && !run.isPending && (
        <Card title="Ready when you are">
          <p className="text-sm text-zinc-500">We compare your last week with the week before and tell you what to do next. To use your own numbers, connect your accounts in <Link href="/settings" className="underline">Settings</Link>.</p>
          <div className="mt-4"><Button onClick={() => run.mutate()}>Check my numbers</Button></div>
        </Card>
      )}

      {latest && <Report run={latest} now={now} campaigns={campaigns.data ?? []} />}
      <Todo />
    </>
  );
}

function notesFor(campaigns: Campaign[], connections: Connection[]) {
  const out: { text: string; href: string; cta: string }[] = [];
  const waiting = campaigns.filter((c) => c.source === "manual" && c.status === "draft").length;
  if (waiting > 0) out.push({ text: `${waiting} ${waiting === 1 ? "campaign is" : "campaigns are"} waiting for your approval.`, href: "/campaigns", cta: "Review" });
  for (const c of connections) {
    if (c.status === "needs_reauth" || c.status === "error") out.push({ text: `${PROVIDER_NAME[c.provider]} needs to be reconnected.`, href: "/settings", cta: "Fix" });
  }
  if (campaigns.some((c) => c.source === "seed")) out.push({ text: "You are looking at sample data.", href: "/settings", cta: "Use my own" });
  return out.slice(0, 3);
}

function Report({ run, now, campaigns }: { run: AnalyticsRun; now: number; campaigns: Campaign[] }) {
  const o = run.output;
  const names = new Map(o.facts.map((f) => [f.campaignId, f.name]));
  const source = new Map(campaigns.map((c) => [c.id, c.source]));
  // Google Analytics rows describe website visits, not ad spend: adding them to paid totals would double count.
  const paid = o.facts.filter((f) => source.get(f.campaignId) !== "ga4");
  const sum = (p: "current" | "previous", m: "spend" | "conversions" | "revenue") => paid.reduce((t, f) => t + (f[p][m] ?? 0), 0);
  const cur = { spend: sum("current", "spend"), conversions: sum("current", "conversions"), revenue: sum("current", "revenue") };
  const prev = { spend: sum("previous", "spend"), conversions: sum("previous", "conversions"), revenue: sum("previous", "revenue") };
  const roas = (t: typeof cur) => (t.spend ? t.revenue / t.spend : null);
  const change = (a: number | null, b: number | null) => (a === null || b === null || b === 0 ? null : (a - b) / b);
  const incomplete = o.dataQualityIssues.length > 0;

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-500">
        Last 7 days compared with the 7 before · updated {timeAgo(run.createdAt, now)}{incomplete ? " · some data is incomplete, so treat the changes with care" : ""}
      </p>

      {paid.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile metric="spend" value={cur.spend} delta={change(cur.spend, prev.spend)} goodWhen="neutral" />
          <Tile metric="conversions" value={cur.conversions} delta={change(cur.conversions, prev.conversions)} goodWhen="up" />
          <Tile metric="revenue" value={cur.revenue} delta={change(cur.revenue, prev.revenue)} goodWhen="up" />
          <Tile metric="roas" value={roas(cur)} delta={change(roas(cur), roas(prev))} goodWhen="up" />
        </div>
      )}

      {o.report && (
        <section aria-labelledby="next">
          <h2 id="next" className="mb-3 text-lg font-semibold">What to do next</h2>
          <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">{humanize(o.report.summary, names)}</p>
          <ol className="space-y-3">
            {o.report.recommendations.map((r, i) => <Step key={i} rec={r} index={i} runId={run.id} names={names} />)}
          </ol>
        </section>
      )}
    </div>
  );
}

function Step({ rec, index, runId, names }: { rec: Recommendation; index: number; runId: string; names: Map<string, string> }) {
  const qc = useQueryClient();
  const title = humanize(rec.title, names);
  const add = useMutation({
    mutationFn: () => api<ProposeResult>("/actions", {
      method: "POST",
      body: {
        type: "create_task", source: "recommendation", sourceRef: `${runId}:${index}`, requestedBy: "dashboard",
        payload: { title: title.slice(0, 120), description: `${humanize(rec.action, names)}\n\nWhy: ${humanize(rec.rationale, names)}`.slice(0, 2000), campaignId: rec.campaignId },
      },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  return (
    <li className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="font-medium"><span className="mr-2 text-zinc-500">{index + 1}.</span>{title}</h3>
      <p className="mt-2 text-sm">{humanize(rec.action, names)}</p>
      <p className="mt-1 text-sm text-zinc-500">{humanize(rec.rationale, names)}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="secondary" onClick={() => add.mutate()} disabled={add.isPending || add.isSuccess}>{add.isSuccess ? "Added to your to-do list ✓" : "Add to my to-do list"}</Button>
        {add.error && <span className="text-sm text-red-600 dark:text-red-400">{add.error.message}</span>}
      </div>
    </li>
  );
}

function Todo() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api<Task[]>("/tasks?status=open") });
  const done = useMutation({
    mutationFn: (t: Task) => api(`/tasks/${t.id}`, { method: "PATCH", body: { status: "done" } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });
  if (!tasks.data?.length) return null;
  return (
    <section aria-labelledby="todo" className="mt-8">
      <h2 id="todo" className="mb-3 text-lg font-semibold">Your to-do list</h2>
      <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
        {tasks.data.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-3">
            <input type="checkbox" className="h-4 w-4" disabled={done.isPending} onChange={() => done.mutate(t)} aria-label={`Mark "${t.title}" as done`} />
            <span className="text-sm">{t.title}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
