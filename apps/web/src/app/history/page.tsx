"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { Campaign, ToolCall } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, statusTone } from "@/components/ui";

const TOOL_LABEL: Record<string, string> = {
  get_campaign_metrics: "Looked up campaign numbers",
  list_campaigns: "Listed your campaigns",
  get_brand_guidelines: "Read your brand rules",
  get_product_information: "Read your products",
  get_audience_segments: "Read your audiences",
};

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** A short human line for what the call was about, e.g. the campaign and dates for a metrics lookup. */
function detail(c: ToolCall, names: Map<string, string>): string {
  const a = asObject(c.args);
  if (c.tool === "get_campaign_metrics") {
    const who = typeof a.campaignId === "string" ? names.get(a.campaignId) ?? a.campaignId : "a campaign";
    return typeof a.startDate === "string" ? `${who}, ${a.startDate} to ${a.endDate}` : who;
  }
  return "";
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium">{title}</p>
      <pre className="max-h-64 overflow-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-950">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

export default function HistoryPage() {
  const [limit, setLimit] = useState(100);
  const [tool, setTool] = useState("all");
  const [now] = useState(() => Date.now()); // fixed at mount so rendering stays pure

  const calls = useQuery({ queryKey: ["tool-history", limit], queryFn: () => api<ToolCall[]>(`/tools/audit/calls?limit=${limit}`) });
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });
  const names = new Map((campaigns.data ?? []).map((c) => [c.id, c.name]));

  const all = calls.data ?? [];
  const tools = [...new Set(all.map((c) => c.tool))].sort();
  const shown = tool === "all" ? all : all.filter((c) => c.tool === tool);

  return (
    <>
      <PageHeader
        title="Tool history"
        subtitle="Every lookup the assistant made to produce your numbers and drafts, with what it asked for and what it got back. These only read information; none of them change your accounts."
        actions={tools.length > 1 ? (
          <select aria-label="Filter by tool" value={tool} onChange={(e) => setTool(e.target.value)} className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950">
            <option value="all">All tools</option>
            {tools.map((t) => <option key={t} value={t}>{TOOL_LABEL[t] ?? t}</option>)}
          </select>
        ) : undefined}
      />

      {calls.error && <ErrorBox error={calls.error.message} />}
      {calls.isLoading && <Empty>Loading…</Empty>}
      {calls.data && all.length === 0 && <Card><Empty>Nothing yet. Entries appear here when the assistant checks your numbers or writes a draft.</Empty></Card>}
      {calls.data && all.length > 0 && shown.length === 0 && <Card><Empty>No entries for that tool.</Empty></Card>}

      <ul className="space-y-2">
        {shown.map((c) => {
          const d = detail(c, names);
          const error = typeof asObject(c.result).error === "string" ? (asObject(c.result).error as string) : null;
          return (
            <li key={c.id}>
              <details className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  <span className="font-medium">{TOOL_LABEL[c.tool] ?? c.tool}</span>
                  {d && <span className="text-zinc-500">{d}</span>}
                  <time className="ml-auto text-xs text-zinc-500" dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>{timeAgo(c.createdAt, now)}</time>
                  {error && <span className="basis-full text-xs text-red-600 dark:text-red-400">{error}</span>}
                </summary>
                <div className="space-y-3 border-t border-zinc-200 p-4 dark:border-zinc-800">
                  <p className="text-xs text-zinc-500"><span className="font-mono">{c.tool}</span> · {new Date(c.createdAt).toLocaleString()}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Json title="What it asked for" value={c.args} />
                    <Json title="What it got back" value={c.result} />
                  </div>
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      {calls.data && calls.data.length >= limit && limit < 200 && (
        <div className="mt-4"><Button variant="secondary" onClick={() => setLimit(200)}>Show older entries</Button></div>
      )}
      {calls.data && calls.data.length >= limit && limit >= 200 && <p className="mt-4 text-xs text-zinc-500">Showing the latest 200 entries.</p>}
    </>
  );
}
