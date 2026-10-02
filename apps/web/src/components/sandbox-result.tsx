"use client";

import { useState } from "react";
import { countryName } from "@/lib/countries";
import { timeAgo } from "@/lib/format";
import { Badge, Card } from "@/components/ui";

type Ad = { id: string; name: string; headline: string; description?: string; primaryText?: string; cta?: string; link?: string };
type Platform = {
  outcome: string; campaignId: string; adIds: string[]; ads?: Ad[];
  campaign?: { id: string; name: string; objective?: string; type?: string; status: string };
  adSet?: { id: string; name: string; dailyBudgetMinor: number; currency: string; country: string; optimizedFor: string; status: string };
  page?: { id: string; name: string };
  landingUrl?: string;
};

const host = (url?: string) => { try { return url ? new URL(url).host : null; } catch { return null; } };
const money = (minor: number, currency: string) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100); } catch { return `${minor / 100} ${currency}`; } };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-x-3 py-1.5 text-sm">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function MetaAdPreview({ ad, page, domain }: { ad: Ad; page?: string; domain: string | null }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className="text-xs text-zinc-500">{page ?? "Your Page"} · Sponsored</p>
      {ad.primaryText && <p className="mt-1 whitespace-pre-wrap">{ad.primaryText}</p>}
      <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-zinc-100 p-3 dark:bg-zinc-950">
        <div className="min-w-0">
          {domain && <p className="truncate text-[11px] uppercase tracking-wide text-zinc-500">{domain}</p>}
          <p className="font-semibold">{ad.headline}</p>
          {ad.description && <p className="text-xs text-zinc-500">{ad.description}</p>}
        </div>
        {ad.cta && <span className="shrink-0 rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700">{ad.cta}</span>}
      </div>
    </div>
  );
}

function GoogleAdPreview({ ad }: { ad: Ad }) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className="text-xs"><span className="font-semibold">Ad</span> <span className="text-zinc-500">· Sponsored</span></p>
      <p className="mt-1 text-base text-sky-700 dark:text-sky-400">{ad.headline}</p>
      {ad.description && <p className="mt-0.5 text-zinc-600 dark:text-zinc-400">{ad.description}</p>}
      {ad.cta && <span className="mt-2 inline-block rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700">{ad.cta}</span>}
    </div>
  );
}

function PlatformSection({ kind, p }: { kind: "meta" | "google"; p: Platform }) {
  const ads = p.ads ?? [];
  const domain = host(p.landingUrl);
  return (
    <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <h3 className="text-sm font-semibold">{kind === "meta" ? "Meta · Facebook & Instagram" : "Google Ads · Search"}</h3>

      {(p.campaign || p.adSet) && (
        <dl className="mt-2 divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {p.campaign && (
            <Row label="Campaign">
              <p className="break-words font-medium">{p.campaign.name}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-zinc-500">
                {p.campaign.objective ? `${p.campaign.objective} objective` : p.campaign.type ? `${p.campaign.type} campaign` : null}
                <Badge tone="warn">Paused</Badge>
              </p>
            </Row>
          )}
          {p.adSet && (
            <Row label="Ad set">
              <span className="font-medium">{money(p.adSet.dailyBudgetMinor, p.adSet.currency)} a day</span>{" "}
              <span className="text-zinc-500">· {countryName(p.adSet.country)} · {p.adSet.optimizedFor.toLowerCase()}</span>{" "}
              <Badge tone="warn">Paused</Badge>
            </Row>
          )}
          {p.page && <Row label="Posting as">{p.page.name}</Row>}
          {domain && <Row label="Sends people to"><span className="break-all">{domain}</span> <span className="text-xs text-zinc-500">with tracking tags</span></Row>}
        </dl>
      )}

      <p className="mb-2 mt-4 text-xs font-medium text-zinc-500">{ads.length === 1 ? "The ad" : `${ads.length} ads`} <Badge tone="warn">Paused</Badge></p>
      <div className="space-y-3">
        {ads.map((a) => (kind === "meta" ? <MetaAdPreview key={a.id} ad={a} page={p.page?.name} domain={domain} /> : <GoogleAdPreview key={a.id} ad={a} />))}
      </div>

      <details className="mt-3 text-xs text-zinc-500">
        <summary className="cursor-pointer select-none">Technical details</summary>
        <ul className="mt-2 space-y-1 font-mono">
          <li>campaign {p.campaignId}</li>
          {p.adSet && <li>ad set {p.adSet.id}</li>}
          {ads.map((a) => <li key={a.id}>ad {a.id}{a.link ? <> · <span className="break-all">{a.link}</span></> : null}</li>)}
        </ul>
      </details>
    </section>
  );
}

/** What approving created in the demo ad platform: the same campaign > ad set > ads shape a real account has, with each ad previewed. */
export function SandboxResult({ platforms, createdAt }: { platforms: { meta_ads?: Platform; google_ads?: Platform }; createdAt: string }) {
  const [now] = useState(() => Date.now()); // fixed at mount so rendering stays pure
  const meta = platforms.meta_ads?.outcome === "created_paused" ? platforms.meta_ads : undefined;
  const google = platforms.google_ads?.outcome === "created_paused" ? platforms.google_ads : undefined;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">Created in the demo ad platform</h2>
        <Badge tone="info">Sandbox</Badge>
        <span className="ml-auto text-xs text-zinc-500">{timeAgo(createdAt, now)}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        <strong>Nothing real was posted and nothing can spend.</strong> This is what approving would create in a real ad account; everything starts paused.
      </p>
      <div className="mt-4 space-y-4">
        {meta && <PlatformSection kind="meta" p={meta} />}
        {google && <PlatformSection kind="google" p={google} />}
      </div>
    </Card>
  );
}
