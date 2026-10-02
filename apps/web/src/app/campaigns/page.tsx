"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Campaign } from "@/lib/types";
import { Badge, Card, Empty, ErrorBox, PageHeader, type Tone } from "@/components/ui";

function state(c: Campaign): { label: string; tone: Tone } {
  if (c.source === "manual") {
    if (c.status === "draft") return { label: "Needs your approval", tone: "warn" };
    if (c.status === "approved") return { label: "Approved", tone: "good" };
  }
  return { label: c.source === "seed" ? "Sample" : "Live data", tone: "neutral" };
}

export default function CampaignsPage() {
  const q = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });
  return (
    <>
      <PageHeader title="Campaigns" actions={<Link href="/campaigns/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">New campaign</Link>} />
      {q.error && <ErrorBox error={q.error.message} />}
      {q.isLoading && <Empty>Loading…</Empty>}
      {q.data?.length === 0 && <Card><Empty>No campaigns yet. Press “New campaign” and the assistant will write a first draft.</Empty></Card>}
      {q.data && q.data.length > 0 && (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {q.data.map((c) => {
            const s = state(c);
            return (
              <li key={c.id}>
                <Link href={`/campaigns/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
