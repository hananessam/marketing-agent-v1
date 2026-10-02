"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ApiError, api, errorDetails } from "@/lib/api";
import { friendlyIssue, label } from "@/lib/format";
import type { Asset, CampaignDetail, Company } from "@/lib/types";
import { RegenerateCopy } from "@/components/regenerate-copy";
import { CampaignPerformanceView } from "@/components/campaign-performance";
import { MetaSettingsFields, PostingNote, PostingResult, postToMeta, useMetaForm, usePublishing, whyNotPosting } from "@/components/meta-posting";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, inputClass } from "@/components/ui";

const KIND: Record<string, string> = { ad_headline: "Headline", ad_description: "Description", social_post: "Post", cta: "Button" };
const CHANNEL: Record<string, string> = { google_ads: "Google Ads", meta_ads: "Facebook & Instagram" };

function group(assets: Asset[]) {
  const out = new Map<string, Asset[]>();
  for (const a of assets) out.set(a.variant.split(":")[0], [...(out.get(a.variant.split(":")[0]) ?? []), a]);
  return out;
}

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({ queryKey: ["campaign", id], queryFn: () => api<CampaignDetail>(`/campaigns/${id}`) });
  const [postError, setPostError] = useState<string | null>(null);

  if (q.isLoading) return <Empty>Loading…</Empty>;
  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <Card title="This campaign doesn't exist">
        <p className="text-sm text-zinc-500">The link may be old, or the campaign was removed.</p>
        <div className="mt-4"><Link href="/campaigns" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">See all campaigns</Link></div>
      </Card>
    );
  }
  if (q.error) return <ErrorBox error={q.error.message} />;
  const c = q.data!;
  // Sample data and campaigns synced from Meta or Google have no drafted copy: show how they are doing instead.
  if (!c.brief && !c.plan && c.assets.length === 0) return <CampaignPerformanceView id={id} />;
  return c.status === "approved" ? <Approved c={c} id={id} postError={postError} setPostError={setPostError} /> : <Draft c={c} id={id} setPostError={setPostError} />;
}

// ------------------------------------------------------------------ reviewing a draft

function Draft({ c, id, setPostError }: { c: CampaignDetail; id: string; setPostError: (m: string | null) => void }) {
  const qc = useQueryClient();
  const live = c.assets.filter((a) => a.status !== "rejected"); // removed copy is simply hidden
  const flawed = live.filter((a) => a.issues.length > 0).length;

  // Approving also creates the ads on Meta (paused), when that is switched on and the campaign has Meta copy.
  const hasMeta = live.some((a) => a.variant.startsWith("meta_ads:"));
  const hasGoogle = live.some((a) => a.variant.startsWith("google_ads:"));
  const pub = usePublishing(hasMeta || hasGoogle, hasMeta);
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  const form = useMetaForm(pub.details, company.data);
  // Live mode only posts Meta copy; the demo sandbox takes Google copy too.
  const posting = pub.canPost && (hasMeta || pub.demo);

  const approve = useMutation({
    mutationFn: async () => {
      for (const a of live.filter((x) => x.status === "draft")) await api(`/campaigns/${id}/assets/${a.id}/review`, { method: "POST", body: { decision: "approved" } });
      // After an earlier rejection there is no open request: open a fresh one, then approve it.
      const approvalId = c.approval?.status === "pending" ? c.approval.id : (await api<{ approvalId: string }>(`/campaigns/${id}/request-approval`, { method: "POST" })).approvalId;
      await api(`/approvals/${approvalId}/decision`, { method: "POST", body: { decision: "approved", decidedBy: "You" } });
      // The campaign is approved from here on. If posting fails, say so clearly instead of undoing the approval.
      setPostError(null);
      if (posting) {
        try { await postToMeta(id, hasMeta ? form.payload() : undefined); } catch (e) { setPostError(e instanceof Error ? e.message : "Posting to Meta failed."); }
      }
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["campaign", id] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });

  return (
    <div className="space-y-5">
      <Link href="/campaigns" className="text-sm text-zinc-500 underline">← All campaigns</Link>
      <PageHeader title={c.name} actions={<Badge tone="warn">Draft</Badge>} />
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Read the copy below. Edit anything you don&apos;t like and remove what you don&apos;t want, then approve it.
        {c.plan && <> The idea behind it: <span className="italic">{c.plan.keyMessage}</span></>}
      </p>

      <RegenerateCopy campaignId={id} />

      {[...group(live)].map(([channel, assets]) => (
        <Card key={channel} title={CHANNEL[channel] ?? label(channel)}>
          <ul className="space-y-4">
            {assets.map((a) => <AssetRow key={a.id} campaignId={id} asset={a} />)}
          </ul>
        </Card>
      ))}
      {live.length === 0 && <Card><Empty>You removed all the copy. Go back and create a new campaign.</Empty></Card>}

      {posting && hasMeta && pub.details && <MetaSettingsFields form={form} details={pub.details} />}
      {hasMeta && !posting && !pub.loading && <PostingNote reason={whyNotPosting(pub.status)} />}
      {pub.detailsError && <ErrorBox error={pub.detailsError.message} />}

      <div className="sticky bottom-0 -mx-4 border-t border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        {flawed > 0 && <p className="mb-2 text-sm text-amber-700 dark:text-amber-400">{flawed === 1 ? "One piece of copy needs" : `${flawed} pieces of copy need`} a quick fix before you can approve. They are highlighted above.</p>}
        {approve.error && <div className="mb-2"><ErrorBox error={approve.error.message} details={errorDetails(approve.error)} /></div>}
        <Button onClick={() => approve.mutate()} disabled={approve.isPending || flawed > 0 || live.length === 0 || (posting && hasMeta && !form.valid)}>
          {approve.isPending ? (posting ? "Approving and creating ads…" : "Approving…") : posting ? (pub.demo ? "Approve and create paused demo ads" : "Approve and create paused ads on Meta") : "Approve campaign"}
        </Button>
        <span className="ml-3 text-xs text-zinc-500">{posting ? (pub.demo ? "Demo mode: ads go to a built-in sandbox. Nothing real is posted." : "The ads are created paused: nothing spends until you switch them on.") : "Nothing is published or sent."}</span>
      </div>
    </div>
  );
}

function AssetRow({ campaignId, asset }: { campaignId: string; asset: Asset }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(asset.content);
  const refresh = () => qc.invalidateQueries({ queryKey: ["campaign", campaignId] });

  const remove = useMutation({ mutationFn: () => api(`/campaigns/${campaignId}/assets/${asset.id}/review`, { method: "POST", body: { decision: "rejected" } }), onSuccess: refresh });
  const save = useMutation({
    mutationFn: () => api(`/campaigns/${campaignId}/assets/${asset.id}`, { method: "PATCH", body: { content: text } }),
    onSuccess: () => { setEditing(false); refresh(); },
  });
  const over = asset.maxLength !== null && asset.content.length > asset.maxLength;

  return (
    <li>
      <p className="mb-1 text-xs font-medium text-zinc-500">{KIND[asset.kind] ?? label(asset.kind)} · version {asset.variant.split(":")[1]}</p>
      {editing ? (
        <>
          <textarea aria-label="Edit copy" rows={4} className={inputClass} value={text} onChange={(e) => setText(e.target.value)} />
          {save.error && <div className="mt-2"><ErrorBox error={save.error.message} details={errorDetails(save.error)} /></div>}
          <div className="mt-2 flex gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending || !text.trim() || text === asset.content}>{save.isPending ? "Checking…" : "Save"}</Button>
            <Button variant="secondary" onClick={() => { setEditing(false); setText(asset.content); save.reset(); }}>Cancel</Button>
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">{asset.content}</p>
          {asset.maxLength !== null && <p className={`mt-1 text-xs ${over ? "font-medium text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{asset.content.length} / {asset.maxLength} characters</p>}
          {asset.issues.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {asset.issues.map((i, n) => <li key={n}>{friendlyIssue(i)}</li>)}
            </ul>
          )}
          {remove.error && <div className="mt-2"><ErrorBox error={remove.error.message} /></div>}
          <div className="mt-2 flex gap-3 text-sm">
            <button onClick={() => setEditing(true)} className="underline">Edit</button>
            <button onClick={() => remove.mutate()} disabled={remove.isPending} className="text-zinc-500 underline">Remove</button>
          </div>
        </>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ approved: the finished copy

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="text-xs underline" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* clipboard blocked: the text is selectable */ } }}>
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

function Approved({ c, id, postError, setPostError }: { c: CampaignDetail; id: string; postError: string | null; setPostError: (m: string | null) => void }) {
  const qc = useQueryClient();
  const items = c.assets.filter((a) => a.status === "approved");
  const hasMeta = items.some((a) => a.variant.startsWith("meta_ads:"));
  const hasGoogle = items.some((a) => a.variant.startsWith("google_ads:"));
  const posted = c.publish?.status === "executed";

  // Offer (another) try when Meta copy has not been posted yet and posting is possible.
  const pub = usePublishing((hasMeta || hasGoogle) && !posted, hasMeta);
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  const form = useMetaForm(pub.details, company.data);
  const canRetry = !posted && pub.canPost && (hasMeta || pub.demo);
  const retry = useMutation({
    mutationFn: async () => { setPostError(null); await postToMeta(id, hasMeta ? form.payload() : undefined); },
    onError: (e) => setPostError(e instanceof Error ? e.message : "Posting to Meta failed."),
    onSettled: () => qc.invalidateQueries({ queryKey: ["campaign", id] }),
  });

  return (
    <div className="space-y-5">
      <Link href="/campaigns" className="text-sm text-zinc-500 underline">← All campaigns</Link>
      <PageHeader title={c.name} actions={<Badge tone="good">Approved</Badge>} />

      <PostingResult publish={c.publish} />
      {postError && !c.publish?.result?.error && <ErrorBox error="Your campaign is approved, but it could not be posted to Meta." details={[postError]} />}
      {canRetry && (hasMeta ? pub.details : true) && (
        <div className="space-y-3">
          {hasMeta && pub.details && <MetaSettingsFields form={form} details={pub.details} />}
          <Button onClick={() => retry.mutate()} disabled={retry.isPending || (hasMeta && !form.valid)}>{retry.isPending ? "Creating ads…" : pub.demo ? "Create paused demo ads" : "Create paused ads on Meta"}</Button>
        </div>
      )}
      {hasMeta && !posted && !canRetry && !pub.loading && <PostingNote reason={whyNotPosting(pub.status)} />}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">Your approved copy{posted ? "" : ". The app hasn't posted it, so copy it into each tool"}:</p>
      {[...group(items)].map(([channel, assets]) => (
        <Card key={channel} title={CHANNEL[channel] ?? label(channel)}>
          <ul className="space-y-4">
            {assets.map((a) => (
              <li key={a.id}>
                <div className="flex items-center justify-between"><p className="text-xs font-medium text-zinc-500">{KIND[a.kind] ?? label(a.kind)} · version {a.variant.split(":")[1]}</p><CopyButton text={a.content} /></div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{a.content}</p>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
