"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { api, errorDetails } from "@/lib/api";
import { ACTION_STATUS, ACTION_TYPE_LABEL } from "@/lib/format";
import type { AgentAction, Approval } from "@/lib/types";
import { ActionDetails } from "@/components/action-details";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, inputClass, statusTone } from "@/components/ui";

const REVIEWER_KEY = "reviewer-name";
const listeners = new Set<() => void>();
// localStorage is only a per-browser convenience; it may be unavailable.
const readReviewer = () => { try { return localStorage.getItem(REVIEWER_KEY) ?? ""; } catch { return ""; } };
const writeReviewer = (v: string) => {
  try { localStorage.setItem(REVIEWER_KEY, v); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export default function ApprovalsPage() {
  const qc = useQueryClient();
  const reviewer = useSyncExternalStore(subscribe, readReviewer, () => "");
  const updateReviewer = writeReviewer;

  const q = useQuery({ queryKey: ["approvals", "all"], queryFn: () => api<Approval[]>("/approvals") });
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Approvals gate two things: campaign sign-offs, and actions the agent wants to take (pause, budget, publish...).
  const actions = useQuery({ queryKey: ["actions"], queryFn: () => api<AgentAction[]>("/actions?limit=200") });
  const actionFor = new Map((actions.data ?? []).filter((x) => x.approvalId).map((x) => [x.approvalId as string, x]));
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approved" | "rejected" }) =>
      api(`/approvals/${v.id}/decision`, { method: "POST", body: { decision: v.decision, decidedBy: reviewer.trim(), ...(notes[v.id]?.trim() ? { note: notes[v.id].trim() } : {}) } }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["approvals"] });
      qc.invalidateQueries({ queryKey: ["actions"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["campaign"] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  const pending = q.data?.filter((a) => a.status === "pending") ?? [];
  const decided = q.data?.filter((a) => a.status !== "pending") ?? [];

  return (
    <>
      <PageHeader title="Approvals" subtitle="Every risky action waits here. Approving a campaign marks it ready; it does not publish or send anything." />
      <Card className="mb-4">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Your name (recorded in the audit trail)</span>
          <input className={`${inputClass} max-w-xs`} value={reviewer} onChange={(e) => updateReviewer(e.target.value)} placeholder="e.g. Hanan" />
        </label>
      </Card>
      {decide.error && <div className="mb-4"><ErrorBox error={decide.error.message} details={errorDetails(decide.error)} /></div>}
      {q.error && <ErrorBox error={q.error.message} />}
      {q.isLoading && <Empty>Loading…</Empty>}

      {q.data && (
        <div className="space-y-4">
          <Card title={`Pending (${pending.length})`}>
            {pending.length === 0 && <Empty>Nothing waiting for approval.</Empty>}
            <ul className="space-y-3">
              {pending.map((a) => {
                const act = actionFor.get(a.id);
                const campaignId = act ? (act.payload.campaignId as string | undefined) : a.payload.campaignId;
                return (
                <li key={a.id} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
                  <div className="flex items-center gap-2">
                    <Badge tone="warn">{act ? `Agent action: ${ACTION_TYPE_LABEL[act.type]}` : "Campaign sign-off"}</Badge>
                    <span className="text-xs text-zinc-500">{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="mt-2 text-sm">{a.summary}</p>
                  {act && <details open className="mt-3 rounded-md bg-zinc-50 p-3 dark:bg-zinc-950"><summary className="cursor-pointer text-xs font-medium text-zinc-500">What exactly would happen</summary><div className="mt-2"><ActionDetails action={act} /></div></details>}
                  <label className="mt-3 block text-sm"><span className="mb-1 block text-xs font-medium text-zinc-500">Note for the team (optional; useful when rejecting, so they know what to change)</span>
                    <textarea rows={2} maxLength={500} className={inputClass} value={notes[a.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))} placeholder="e.g. The headline sounds too pushy" />
                  </label>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {campaignId && <Link href={`/campaigns/${campaignId}`} className="text-sm underline">{act ? "Open the campaign" : "Review assets"}</Link>}
                    <span className="grow" />
                    <Button disabled={!reviewer.trim() || decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "approved" })}>Approve</Button>
                    <Button variant="danger" disabled={!reviewer.trim() || decide.isPending} onClick={() => decide.mutate({ id: a.id, decision: "rejected" })}>Reject</Button>
                  </div>
                  {!reviewer.trim() && <p className="mt-2 text-xs text-zinc-500">Enter your name above to decide.</p>}
                </li>
                );
              })}
            </ul>
          </Card>
          {decided.length > 0 && (
            <Card title="History">
              <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                {decided.map((a) => {
                  const act = actionFor.get(a.id);
                  return (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                    <span>{a.summary}
                      {act && a.status === "approved" && <span className="mt-0.5 block text-xs text-zinc-500">Result: {ACTION_STATUS[act.status].label}{act.status === "shadowed" ? " (nothing outside this app changed)" : ""}</span>}
                      {a.payload.note && <span className="mt-0.5 block text-xs text-zinc-500">Note: {a.payload.note}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2"><Badge tone={statusTone(a.status)}>{a.status}</Badge><span className="text-xs text-zinc-500">{a.decidedBy}</span></span>
                  </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
