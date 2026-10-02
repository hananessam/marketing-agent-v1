"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import type { AgentAction, Company, MetaDetails, PublishInfo, PublishingStatus } from "@/lib/types";
import { Card, inputClass } from "@/components/ui";

const COUNTRIES: [string, string][] = [
  ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["NZ", "New Zealand"], ["IE", "Ireland"],
  ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["SE", "Sweden"], ["NO", "Norway"], ["DK", "Denmark"],
  ["FI", "Finland"], ["CH", "Switzerland"], ["AT", "Austria"], ["BE", "Belgium"], ["PT", "Portugal"], ["PL", "Poland"],
  ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["CL", "Chile"], ["CO", "Colombia"],
  ["IN", "India"], ["SG", "Singapore"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["EG", "Egypt"], ["ZA", "South Africa"], ["NG", "Nigeria"], ["KE", "Kenya"], ["JP", "Japan"], ["KR", "South Korea"],
];

export type MetaPayload = { dailyBudget: number; country: string; pageId: string; landingUrl: string };

/** Whether approving can post to Meta right now, and everything the form needs. */
export function usePublishing(enabled: boolean) {
  const status = useQuery({ queryKey: ["publishing-status"], queryFn: () => api<PublishingStatus>("/publishing/status"), enabled });
  const ready = Boolean(enabled && status.data && status.data.mode === "live" && status.data.meta.canPublish);
  // Pages and currency come from Meta itself, so they are only fetched when posting is actually possible.
  const details = useQuery({ queryKey: ["publishing-meta"], queryFn: () => api<MetaDetails>("/publishing/meta"), enabled: ready });
  return { status: status.data, details: details.data, detailsError: details.error, ready, loading: status.isLoading || (ready && details.isLoading) };
}

/** Why approving will not post, in plain words. Null when it will. */
export function whyNotPosting(s: PublishingStatus | undefined): string | null {
  if (!s) return null;
  if (!s.meta.connected) return "Connect your Meta Ads account in Settings to post there.";
  if (s.mode !== "live") return "Posting is switched off on the server, so approving only saves the copy.";
  if (!s.meta.canPublish) return 'Posting to Meta isn\'t allowed yet. Use "Allow posting" in Settings.';
  return null;
}

export function useMetaForm(details: MetaDetails | undefined, company: Company | undefined) {
  const d = details?.meta.defaults;
  const [budget, setBudget] = useState<string>("");
  const [country, setCountry] = useState<string>("");
  const [pageId, setPageId] = useState<string>("");
  const [url, setUrl] = useState<string>("");

  const effBudget = budget || String(d?.dailyBudget ?? 10);
  const effCountry = country || d?.country || "US";
  const effPage = pageId || (details?.pages.some((p) => p.id === d?.pageId) ? d?.pageId : details?.pages[0]?.id) || "";
  const domain = company?.allowedDomains[0];
  const effUrl = url || d?.landingUrl || (domain ? `https://${domain}` : "");

  const max = details?.maxDailyBudget ?? 50;
  const n = Number(effBudget);
  const problems: string[] = [];
  if (!(n > 0)) problems.push("Enter a daily budget above 0.");
  if (n > max) problems.push(`The daily budget is limited to ${max}.`);
  if (!effPage) problems.push("Choose a Facebook Page.");
  if (!/^https:\/\/.+/.test(effUrl)) problems.push("The landing page must start with https://");

  return {
    values: { budget: effBudget, country: effCountry, pageId: effPage, url: effUrl },
    set: { budget: setBudget, country: setCountry, pageId: setPageId, url: setUrl },
    problems, valid: problems.length === 0,
    payload: (): MetaPayload => ({ dailyBudget: n, country: effCountry, pageId: effPage, landingUrl: effUrl }),
  };
}

export function MetaSettingsFields({ form, details }: { form: ReturnType<typeof useMetaForm>; details: MetaDetails }) {
  const { values: v, set } = form;
  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div>
        <p className="text-sm font-medium">Post to Meta (Facebook &amp; Instagram)</p>
        <p className="text-xs text-zinc-500">Approving creates the ads in your account <strong>{details.meta.accountName}</strong>, <strong>paused</strong>. Nothing spends until you switch them on in Ads Manager.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm"><span className="mb-1 block font-medium">Daily budget{details.currency ? ` (${details.currency})` : ""}</span>
          <input type="number" min={1} max={details.maxDailyBudget} step="any" className={inputClass} value={v.budget} onChange={(e) => set.budget(e.target.value)} />
          <span className="mt-1 block text-xs text-zinc-500">At most {details.maxDailyBudget} a day.</span></label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Show ads in</span>
          <select className={inputClass} value={v.country} onChange={(e) => set.country(e.target.value)}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select></label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Post as this Facebook Page</span>
          <select className={inputClass} value={v.pageId} onChange={(e) => set.pageId(e.target.value)}>
            {details.pages.length === 0 && <option value="">No Pages found for this login</option>}
            {details.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <label className="block text-sm"><span className="mb-1 block font-medium">Where the ads send people</span>
          <input type="url" className={inputClass} value={v.url} onChange={(e) => set.url(e.target.value)} placeholder="https://yourcompany.com" />
          <span className="mt-1 block text-xs text-zinc-500">Must be one of your websites. Tracking tags are added automatically.</span></label>
      </div>
      {form.problems.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400">{form.problems.map((p) => <li key={p}>{p}</li>)}</ul>}
    </div>
  );
}

/** Creates the publish request and approves it in one go: the person already confirmed by pressing the button. */
export async function postToMeta(campaignId: string, meta: MetaPayload) {
  const proposed = await api<{ action: AgentAction; reused: boolean }>("/actions", {
    method: "POST", body: { type: "publish_campaign", source: "campaign", sourceRef: campaignId, requestedBy: "dashboard", payload: { campaignId, meta } },
  });
  if (proposed.action.status === "awaiting_approval" && proposed.action.approvalId) {
    await api(`/approvals/${proposed.action.approvalId}/decision`, { method: "POST", body: { decision: "approved", decidedBy: "You" } });
  }
}

type Created = { outcome: string; campaignId: string; adIds: string[]; adsManagerUrl: string; dailyBudgetMinor: number; currency: string };

/** What happened the last time this campaign was posted. */
export function PostingResult({ publish }: { publish: PublishInfo | null }) {
  if (!publish) return null;
  const platforms = ((publish.result?.platforms ?? {}) as Record<string, Record<string, unknown>>);
  const meta = platforms.meta_ads as unknown as Created | undefined;
  const error = typeof publish.result?.error === "string" ? publish.result.error : null;

  if (publish.status === "failed") {
    return <Card title="Posting to Meta failed"><p className="text-sm text-red-600 dark:text-red-400">{error ?? "Something went wrong."}</p><p className="mt-2 text-xs text-zinc-500">Nothing was left running. Fix the problem and try again.</p></Card>;
  }
  if (publish.status === "shadowed" && !meta) {
    return <Card title="Not posted"><p className="text-sm text-zinc-500">This campaign was approved but nothing was posted: posting is switched off, or there was nothing to post to a connected platform.</p></Card>;
  }
  if (meta?.outcome === "created_paused") {
    return (
      <Card title="Created on Meta, paused">
        <p className="text-sm">{meta.adIds.length} {meta.adIds.length === 1 ? "ad is" : "ads are"} ready in your account. <strong>Nothing is spending yet.</strong> Review them and switch them on in Ads Manager when you&apos;re ready.</p>
        <div className="mt-3"><a href={meta.adsManagerUrl} target="_blank" rel="noreferrer" className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Open in Ads Manager</a></div>
        {platforms.google_ads && <p className="mt-3 text-xs text-zinc-500">Google Ads isn&apos;t connected yet, so that copy wasn&apos;t posted. It is below, ready to copy.</p>}
      </Card>
    );
  }
  return null;
}

export function PostingNote({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return <p className="text-xs text-zinc-500">{reason} <Link href="/settings" className="underline">Open Settings</Link></p>;
}
