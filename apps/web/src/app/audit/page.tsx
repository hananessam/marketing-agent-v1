"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { ToolCall } from "@/lib/types";
import { Badge, Card, Empty, ErrorBox, PageHeader, statusTone } from "@/components/ui";

export default function AuditPage() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<ToolCall[]>("/tools/audit/calls?limit=100") });
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every tool call the agents made, with arguments and results." />
      {q.error && <ErrorBox error={q.error.message} />}
      {q.isLoading && <Empty>Loading…</Empty>}
      {q.data && q.data.length === 0 && <Card><Empty>No tool calls yet.</Empty></Card>}
      <div className="space-y-2">
        {q.data?.map((c) => (
          <details key={c.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <summary className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm">
              <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              <span className="font-mono">{c.tool}</span>
              <span className="ml-auto text-xs text-zinc-500">{new Date(c.createdAt).toLocaleString()}</span>
            </summary>
            <div className="grid gap-3 border-t border-zinc-200 p-4 text-xs dark:border-zinc-800 md:grid-cols-2">
              <Json title="Arguments" value={c.args} />
              <Json title="Result" value={c.result} />
            </div>
          </details>
        ))}
      </div>
    </>
  );
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 font-medium">{title}</p>
      <pre className="max-h-64 overflow-auto rounded bg-zinc-100 p-2 dark:bg-zinc-950">{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}
