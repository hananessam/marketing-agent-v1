"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ApiError, api, errorDetails } from "@/lib/api";
import { friendlyIssue, label } from "@/lib/format";
import type { Approval, Asset, CampaignDetail } from "@/lib/types";
import { CampaignPerformanceView } from "@/components/campaign-performance";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, inputClass, statusTone } from "@/components/ui";

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["campaign", id], queryFn: () => api<CampaignDetail>(`/campaigns/${id}`) });
  const approvals = useQuery({ queryKey: ["approvals", "all"], queryFn: () => api<Approval[]>("/approvals") });

  if (q.isLoading) return <Empty>Loading…</Empty>;
  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <Card title="This campaign doesn't exist">
        <p className="text-sm text-zinc-500">The link may be old, or the campaign was removed. Your other campaigns are all still there.</p>
        <div className="mt-4 flex gap-2">
          <Link href="/campaigns" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">See all campaigns</Link>
          <Link href="/campaigns/new" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Create a new campaign</Link>
        </div>
      </Card>
    );
  }
  if (q.error) return <ErrorBox error={q.error.message} />;
  const c = q.data!;
  // Campaigns that were not drafted here (sample data, or synced from Meta / Google) have no brief, plan or copy.
  if (!c.brief && !c.plan && c.assets.length === 0) return <CampaignPerformanceView id={id} />;
  const approval = approvals.data?.find((a) => a.payload.campaignId === id);
  const editable = c.status === "draft";

  // group: channel -> kind -> assets
  const groups = new Map<string, Map<string, Asset[]>>();
  for (const a of c.assets) {
    const [channel] = a.variant.split(":");
    const byKind = groups.get(channel) ?? new Map<string, Asset[]>();
    byKind.set(a.kind, [...(byKind.get(a.kind) ?? []), a]);
    groups.set(channel, byKind);
  }
  const undecided = c.assets.filter((a) => a.status === "draft").length;
  const flawed = c.assets.filter((a) => a.issues.length > 0 && a.status !== "rejected").length;

  return (
    <div className="space-y-4">
      <PageHeader title={c.name} subtitle={c.brief ? `Objective: ${c.brief.objective} · ${c.brief.durationDays} days · audience: ${c.brief.audience}` : undefined}
        actions={<Badge tone={statusTone(c.status)}>{c.status}</Badge>} />

      {flawed > 0 && editable && (
        <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          {flawed} {flawed === 1 ? "piece of copy needs" : "pieces of copy need"} a quick fix before {flawed === 1 ? "it" : "they"} can be approved, usually a headline that is a few characters too long. Click Edit on the highlighted ones, or reject them.
        </p>
      )}

      {approval && approval.status === "pending" && (
        <Card>
          <p className="text-sm">
            {undecided > 0 ? `${undecided} asset(s) still need your review.` : "All assets reviewed."}{" "}
            <Link href="/approvals" className="font-medium underline">Decide in the approvals inbox</Link>. Approving does not publish anything.
          </p>
        </Card>
      )}
      {approval && approval.status !== "pending" && <p className="text-sm text-zinc-500">Approval {approval.status}{approval.decidedBy ? ` by ${approval.decidedBy}` : ""}. Assets are now locked.</p>}

      {c.plan && (
      <Card title="Plan">
        <p className="text-sm"><span className="font-medium">Positioning:</span> {c.plan.positioning}</p>
        <p className="mt-2 text-sm"><span className="font-medium">Key message:</span> {c.plan.keyMessage}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {c.plan.channels.map((ch) => (
            <div key={ch.name} className="rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <p className="font-medium">{label(ch.name)}</p>
              <p className="text-zinc-600 dark:text-zinc-400">{ch.role}</p>
              <p className="mt-1 text-xs text-zinc-500">Success metrics: {ch.successMetrics.join(", ")}</p>
            </div>
          ))}
        </div>
        {c.experiments.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="font-medium">Experiments</p>
            <ul className="list-disc pl-5">{c.experiments.map((e) => <li key={e.id}>{e.hypothesis} <span className="text-zinc-500">(variable: {e.variable})</span></li>)}</ul>
          </div>
        )}
        {c.plan.risks.length > 0 && <p className="mt-3 text-sm"><span className="font-medium">Risks:</span> {c.plan.risks.join("; ")}</p>}
      </Card>
      )}

      {[...groups].map(([channel, kinds]) => (
        <Card key={channel} title={label(channel)}>
          <div className="space-y-5">
            {[...kinds].map(([kind, assets]) => (
              <div key={kind}>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{label(kind)}</p>
                <div className="grid gap-3 md:grid-cols-2">
                  {assets.map((a) => <AssetCard key={a.id} campaignId={id} asset={a} editable={editable} />)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function AssetCard({ campaignId, asset, editable }: { campaignId: string; asset: Asset; editable: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(asset.content);
  const refresh = () => qc.invalidateQueries({ queryKey: ["campaign", campaignId] });

  const review = useMutation({
    mutationFn: (decision: "approved" | "rejected") => api(`/campaigns/${campaignId}/assets/${asset.id}/review`, { method: "POST", body: { decision } }),
    onSuccess: refresh,
  });
  const save = useMutation({
    mutationFn: () => api(`/campaigns/${campaignId}/assets/${asset.id}`, { method: "PATCH", body: { content: text } }),
    onSuccess: () => { setEditing(false); refresh(); },
  });
  const [, variant] = asset.variant.split(":");

  return (
    <div className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500">Variant {variant}</span>
        <Badge tone={statusTone(asset.status)}>{asset.status}</Badge>
      </div>
      {editing ? (
        <>
          <textarea aria-label="Edit copy" rows={5} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />
          {save.error && <div className="mt-2"><ErrorBox error={save.error.message} details={errorDetails(save.error)} /></div>}
          <div className="mt-2 flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending || !text.trim() || text === asset.content}>{save.isPending ? "Checking…" : "Save"}</Button>
            <Button variant="secondary" onClick={() => { setEditing(false); setText(asset.content); save.reset(); }}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">{asset.content}</p>
          <p className={`mt-1 text-xs ${asset.maxLength && asset.content.length > asset.maxLength ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-500"}`}>
            {asset.content.length}{asset.maxLength ? ` / ${asset.maxLength}` : ""} characters
          </p>
          {asset.issues.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {asset.issues.map((i, n) => <li key={n}>{friendlyIssue(i)}</li>)}
            </ul>
          )}
          {review.error && <div className="mt-2"><ErrorBox error={review.error.message} /></div>}
          {editable && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" disabled={review.isPending || asset.status === "approved" || asset.issues.length > 0} title={asset.issues.length ? "Fix the problem above first" : undefined} onClick={() => review.mutate("approved")}>Approve</Button>
              <Button variant="danger" disabled={review.isPending || asset.status === "rejected"} onClick={() => review.mutate("rejected")}>Reject</Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
