"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Campaign, Task } from "@/lib/types";
import { Card, Empty, ErrorBox, PageHeader } from "@/components/ui";

export default function TasksPage() {
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api<Task[]>("/tasks") });
  const campaigns = useQuery({ queryKey: ["campaigns"], queryFn: () => api<Campaign[]>("/campaigns") });
  const names = new Map((campaigns.data ?? []).map((c) => [c.id, c.name]));

  const toggle = useMutation({
    mutationFn: (t: Task) => api<Task>(`/tasks/${t.id}`, { method: "PATCH", body: { status: t.status === "open" ? "done" : "open" } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["tasks"] }),
  });

  const open = tasks.data?.filter((t) => t.status === "open") ?? [];
  const done = tasks.data?.filter((t) => t.status === "done") ?? [];

  return (
    <>
      <PageHeader title="Tasks" subtitle="Things to do, collected from the recommendations you chose to act on." />
      {tasks.error && <ErrorBox error={tasks.error.message} />}
      {toggle.error && <div className="mb-3"><ErrorBox error={toggle.error.message} /></div>}
      {tasks.isLoading && <Empty>Loading…</Empty>}
      {tasks.data && tasks.data.length === 0 && (
        <Card><Empty>No tasks yet. On the <Link href="/" className="underline">Overview</Link>, press “Add to my tasks” under a recommendation.</Empty></Card>
      )}
      {open.length > 0 && <Card title={`To do (${open.length})`}><TaskList tasks={open} names={names} onToggle={(t) => toggle.mutate(t)} busy={toggle.isPending} /></Card>}
      {done.length > 0 && <div className="mt-4"><Card title={`Done (${done.length})`}><TaskList tasks={done} names={names} onToggle={(t) => toggle.mutate(t)} busy={toggle.isPending} /></Card></div>}
    </>
  );
}

function TaskList({ tasks, names, onToggle, busy }: { tasks: Task[]; names: Map<string, string>; onToggle: (t: Task) => void; busy: boolean }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {tasks.map((t) => (
        <li key={t.id} className="flex items-start gap-3 py-3">
          <input type="checkbox" className="mt-1 h-4 w-4" checked={t.status === "done"} disabled={busy} onChange={() => onToggle(t)} aria-label={`Mark "${t.title}" as ${t.status === "done" ? "not done" : "done"}`} />
          <div className="min-w-0">
            <p className={`text-sm font-medium ${t.status === "done" ? "text-zinc-500 line-through" : ""}`}>{t.title}</p>
            {t.campaignId && names.get(t.campaignId) && <Link href={`/campaigns/${t.campaignId}`} className="text-xs text-zinc-500 underline">{names.get(t.campaignId)}</Link>}
            {t.description && (
              <details className="mt-1 text-sm">
                <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">Details</summary>
                <p className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">{t.description}</p>
              </details>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
