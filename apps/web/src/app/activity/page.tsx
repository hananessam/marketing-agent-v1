"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { ACTION_STATUS, ACTION_TYPE_LABEL, timeAgo } from "@/lib/format";
import type { AgentAction } from "@/lib/types";
import { ActionDetails } from "@/components/action-details";
import { Badge, Card, Empty, ErrorBox, PageHeader } from "@/components/ui";

export default function ActivityPage() {
  const [now] = useState(() => Date.now());
  const actions = useQuery({ queryKey: ["actions"], queryFn: () => api<AgentAction[]>("/actions?limit=100") });
  const mode = useQuery({ queryKey: ["actions-mode"], queryFn: () => api<{ mode: "shadow" | "live" }>("/actions/mode") });

  return (
    <>
      <PageHeader title="Activity" subtitle="Every action that was proposed, what happened to it, and who asked." />
      {mode.data?.mode === "shadow" && (
        <p className="mb-4 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          <span className="font-medium">Shadow mode is on.</span> Approved actions on ad accounts, budgets and email are recorded as “what would have happened” and never applied. Tasks are real.
        </p>
      )}
      {actions.error && <ErrorBox error={actions.error.message} />}
      {actions.isLoading && <Empty>Loading…</Empty>}
      {actions.data?.length === 0 && <Card><Empty>Nothing yet. Actions appear here when you act on a recommendation or prepare a launch.</Empty></Card>}
      <ul className="space-y-3">
        {actions.data?.map((a) => {
          const st = ACTION_STATUS[a.status];
          const error = typeof a.result?.error === "string" ? a.result.error : null;
          return (
            <li key={a.id} className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="info">{ACTION_TYPE_LABEL[a.type]}</Badge>
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="grow" />
                <span className="text-xs text-zinc-500">{a.requestedBy} · {timeAgo(a.createdAt, now)}</span>
              </div>
              <p className="mt-2 text-sm font-medium">{a.preview.summary}</p>
              {a.status === "shadowed" && <p className="mt-1 text-sm text-zinc-500">Approved and recorded. Nothing outside this app was changed.</p>}
              {a.status === "awaiting_approval" && <p className="mt-1 text-sm text-zinc-500">Waiting in the approvals inbox.</p>}
              {error && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Show details</summary>
                <div className="mt-2"><ActionDetails action={a} /></div>
              </details>
            </li>
          );
        })}
      </ul>
    </>
  );
}
