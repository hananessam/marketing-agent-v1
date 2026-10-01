"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import { label } from "@/lib/format";
import type { Campaign } from "@/lib/types";
import { Badge, Card, Empty, ErrorBox, PageHeader, statusTone } from "@/components/ui";

const SOURCE = { manual: "drafted here", seed: "demo data", meta_ads: "from Meta Ads", ga4: "from Google Analytics" } as const;

export default function CampaignsPage() {
  const q = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });
  return (
    <>
      <PageHeader title="Campaigns" actions={<Link href="/campaigns/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">New campaign</Link>} />
      {q.error && <ErrorBox error={q.error.message} />}
      {q.isLoading && <Empty>Loading…</Empty>}
      {q.data && q.data.length === 0 && <Card><Empty>No campaigns yet.</Empty></Card>}
      {q.data && q.data.length > 0 && (
        <Card className="!p-0">
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {q.data.map((c) => (
              <li key={c.id}>
                <Link href={`/campaigns/${c.id}`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                  <span><span className="font-medium">{c.name}</span><span className="block text-xs text-zinc-500">{c.channel.split(",").map(label).join(", ")} · {SOURCE[c.source]}</span></span>
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
