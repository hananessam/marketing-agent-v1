"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Recommendation } from "@/lib/types";
import type { ProposeResult } from "@/lib/types";
import { Button, ErrorBox, inputClass } from "@/components/ui";

/** Shared by every place that proposes an action: refreshes the lists that change. */
export function usePropose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { type: string; payload: unknown; source: "recommendation" | "campaign" | "manual"; sourceRef?: string }) =>
      api<ProposeResult>("/actions", { method: "POST", body: { ...body, requestedBy: "dashboard" } }),
    onSuccess: () => {
      for (const key of ["actions", "tasks", "approvals"]) qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function ProposeOutcome({ result }: { result: ProposeResult }) {
  const a = result.action;
  if (a.type === "create_task") {
    return <p className="text-sm text-emerald-600 dark:text-emerald-400">{result.reused ? "This task already exists." : "Added to your tasks."} <Link href="/tasks" className="underline">View tasks</Link></p>;
  }
  return (
    <p className="text-sm text-emerald-600 dark:text-emerald-400">
      {result.reused ? "This is already waiting for approval." : "Sent for your approval."} Nothing changes until you approve it, and while shadow mode is on, approving only records what would have happened.{" "}
      <Link href="/approvals" className="underline">Open approvals</Link>
    </p>
  );
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What you can do with one recommendation. */
export function ActionButtons({ rec, runId, index, text }: { rec: Recommendation; runId: string; index: number; text: { title: string; action: string; rationale: string; outcome: string } }) {
  const propose = usePropose();
  const [budget, setBudget] = useState(false);
  const [direction, setDirection] = useState<"decrease" | "increase">("decrease");
  const [percent, setPercent] = useState(5);
  const ref = `${runId}:${index}`;

  const addTask = () => propose.mutate({
    type: "create_task", source: "recommendation", sourceRef: ref,
    payload: { title: cut(text.title, 120), description: cut(`${text.action}\n\nWhy: ${text.rationale}\n\nHow you will know it worked: ${text.outcome}`, 2000), campaignId: rec.campaignId },
  });
  const pause = () => propose.mutate({ type: "pause_campaign", source: "recommendation", sourceRef: ref, payload: { campaignId: rec.campaignId, reason: cut(text.rationale, 500) } });
  const changeBudget = () => propose.mutate({ type: "change_budget", source: "recommendation", sourceRef: ref, payload: { campaignId: rec.campaignId, direction, percent, reason: cut(text.rationale, 500) } });

  return (
    <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={addTask} disabled={propose.isPending}>Add to my tasks</Button>
        {rec.actionType === "pause_creative" && <Button variant="secondary" onClick={pause} disabled={propose.isPending}>Propose pausing…</Button>}
        {rec.actionType === "reallocate_budget" && <Button variant="secondary" onClick={() => setBudget((v) => !v)} disabled={propose.isPending}>Propose a budget change…</Button>}
      </div>
      {budget && (
        <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <label><span className="mb-1 block text-xs font-medium text-zinc-500">Change</span>
            <select className={`${inputClass} !w-auto`} value={direction} onChange={(e) => setDirection(e.target.value as "decrease" | "increase")}>
              <option value="decrease">Decrease</option><option value="increase">Increase</option>
            </select></label>
          <label><span className="mb-1 block text-xs font-medium text-zinc-500">By (max 10%)</span>
            <input type="number" min={1} max={10} className={`${inputClass} !w-24`} value={percent} onChange={(e) => setPercent(Number(e.target.value))} /></label>
          <Button onClick={changeBudget} disabled={propose.isPending || percent < 1 || percent > 10}>Send for approval</Button>
        </div>
      )}
      {propose.error && <div className="mt-2"><ErrorBox error={propose.error.message} /></div>}
      {propose.data && <div className="mt-2"><ProposeOutcome result={propose.data} /></div>}
    </div>
  );
}
