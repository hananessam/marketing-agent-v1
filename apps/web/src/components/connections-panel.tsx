"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import type { Account, Connection, OAuthStatus, Provider, PublishingStatus, SyncOutcome } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorBox, inputClass, statusTone, type Tone } from "@/components/ui";

const PROVIDERS: { provider: Provider; slug: "google" | "meta"; title: string; blurb: string; env: string }[] = [
  { provider: "ga4", slug: "google", title: "Google Analytics 4", blurb: "Sessions, key events and revenue per campaign. Read-only.", env: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" },
  { provider: "meta_ads", slug: "meta", title: "Meta Ads", blurb: "Impressions, clicks, spend and conversions per campaign. Read-only.", env: "META_APP_ID and META_APP_SECRET" },
];

const OAUTH_ERRORS: Record<string, string> = {
  denied: "Access was declined, so nothing was connected.",
  invalid_state: "That sign-in link expired or was already used. Please try connecting again.",
  exchange_failed: "The provider rejected the sign-in. Please try again; if it keeps failing, check the server's client id and secret.",
  not_configured: "This provider is not configured on the server.",
};

const STATUS_TONE: Record<Connection["status"], Tone> = { ok: "good", needs_reauth: "bad", error: "bad", never_synced: "warn", pending_account: "warn" };
const STATUS_LABEL: Record<Connection["status"], string> = { ok: "connected", needs_reauth: "needs reconnect", error: "sync error", never_synced: "not synced yet", pending_account: "choose account" };

export function ConnectionsPanel() {
  return (
    <Suspense fallback={<Empty>Loading…</Empty>}>
      <Connections />
    </Suspense>
  );
}

function Connections() {
  const params = useSearchParams();
  const conns = useQuery({ queryKey: ["connections"], queryFn: () => api<Connection[]>("/connections") });
  const oauth = useQuery({ queryKey: ["oauth-status"], queryFn: () => api<OAuthStatus>("/connections/oauth/status") });
  const oauthError = params.get("oauth_error");

  return (
    <>
      <p className="mb-4 text-sm text-zinc-500">Sign in to your accounts so the assistant can read your numbers. It only asks for read access: it can never change anything in them.</p>
      {oauthError && <div className="mb-4"><ErrorBox error={OAUTH_ERRORS[oauthError] ?? "The connection could not be completed."} /></div>}
      {params.get("connected") && !params.get("pending") && <p className="mb-4 text-sm text-emerald-600 dark:text-emerald-400">Signed in again. Run “Sync now” to pull fresh data.</p>}
      {conns.error && <div className="mb-4"><ErrorBox error={conns.error.message} /></div>}
      {conns.isLoading && <Empty>Loading…</Empty>}
      <div className="space-y-4">
        {PROVIDERS.map((p) => (
          <ProviderCard key={p.provider} p={p} configured={oauth.data?.[p.slug].configured} connections={(conns.data ?? []).filter((c) => c.provider === p.provider)} />
        ))}
        <DemoData />
      </div>
    </>
  );
}

function ProviderCard({ p, configured, connections }: { p: (typeof PROVIDERS)[number]; configured: boolean | undefined; connections: Connection[] }) {
  const start = useMutation({
    mutationFn: (connectionId?: string) => api<{ authUrl: string }>(`/connections/oauth/${p.slug}/start`, { method: "POST", body: { connectionId } }),
    onSuccess: (r) => window.location.assign(r.authUrl),
  });
  return (
    <Card title={p.title} actions={
      <Button disabled={configured === false || start.isPending} onClick={() => start.mutate(undefined)}>
        {start.isPending ? "Redirecting…" : connections.length ? "Connect another" : "Connect"}
      </Button>
    }>
      <p className="text-sm text-zinc-500">{p.blurb}</p>
      {configured === false && <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">Not configured on the server. Set {p.env} in the API&apos;s .env.local and restart it.</p>}
      {start.error && <div className="mt-3"><ErrorBox error={start.error.message} /></div>}
      {connections.length > 0 && (
        <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
          {connections.map((c) => <li key={c.id} className="py-3"><ConnectionRow c={c} slug={p.slug} /></li>)}
        </ul>
      )}
      {p.provider === "meta_ads" && connections.some((c) => c.status === "ok" || c.status === "never_synced") && <PostingPanel connection={connections[0]} />}
    </Card>
  );
}

/** Reading numbers needs little; creating ads needs more. This is the separate, explicit step to allow it. */
function PostingPanel({ connection }: { connection: Connection }) {
  const status = useQuery({ queryKey: ["publishing-status"], queryFn: () => api<PublishingStatus>("/publishing/status") });
  const start = useMutation({
    mutationFn: () => api<{ authUrl: string }>("/connections/oauth/meta/start", { method: "POST", body: { connectionId: connection.id, posting: true } }),
    onSuccess: (r) => window.location.assign(r.authUrl),
  });
  const s = status.data;
  if (!s) return null;
  return (
    <div className="mt-4 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <p className="font-medium">Posting ads</p>
      {s.meta.canPublish ? (
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">Allowed. When you approve a campaign it can create the ads in this account, <strong>always paused</strong>, with a daily budget of at most {s.maxDailyBudget}.</p>
      ) : (
        <>
          <p className="mt-1 text-zinc-600 dark:text-zinc-400">Right now the assistant can only read this account. To create ads from approved campaigns, Meta needs your permission to manage ads and see your Pages. Ads are created paused, so nothing spends until you switch them on.</p>
          <div className="mt-3"><Button variant="secondary" onClick={() => start.mutate()} disabled={start.isPending}>{start.isPending ? "Redirecting…" : "Allow posting"}</Button></div>
          {start.error && <div className="mt-2"><ErrorBox error={start.error.message} /></div>}
        </>
      )}
      {s.mode !== "live" && (
        <p className="mt-3 rounded bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Posting is switched off on the server, so approving only saves the copy. To switch it on, set <code>EXECUTION_MODE=live</code> in <code>apps/api/.env.local</code> and restart the API.
        </p>
      )}
      <p className="mt-3 text-xs text-zinc-500">{s.google.reason}</p>
    </div>
  );
}

function ConnectionRow({ c, slug }: { c: Connection; slug: "google" | "meta" }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ["connections"] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); };

  const sync = useMutation({ mutationFn: () => api<SyncOutcome>(`/connections/${c.id}/sync`, { method: "POST", body: { days: 7 } }), onSettled: refresh });
  const reconnect = useMutation({
    mutationFn: () => api<{ authUrl: string }>(`/connections/oauth/${slug}/start`, { method: "POST", body: { connectionId: c.id } }),
    onSuccess: (r) => window.location.assign(r.authUrl),
  });
  const remove = useMutation({ mutationFn: () => api(`/connections/${c.id}`, { method: "DELETE" }), onSuccess: refresh });

  const [now] = useState(() => Date.now()); // fixed at mount: render stays pure
  const daysLeft = c.tokenExpiresAt ? Math.ceil((Date.parse(c.tokenExpiresAt) - now) / 86_400_000) : null;
  const expiring = daysLeft !== null && daysLeft <= 10;
  const s = c.lastSummary;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.accountName ?? (c.status === "pending_account" ? "New connection" : c.accountId)}</span>
        <Badge tone={STATUS_TONE[c.status] ?? statusTone(c.status)}>{STATUS_LABEL[c.status]}</Badge>
        {expiring && <Badge tone={daysLeft! <= 0 ? "bad" : "warn"}>{daysLeft! <= 0 ? "token expired" : `token expires in ${daysLeft} day(s)`}</Badge>}
        <span className="grow" />
        {c.status !== "pending_account" && <Button variant="secondary" disabled={sync.isPending || c.status === "needs_reauth"} onClick={() => sync.mutate()}>{sync.isPending ? "Syncing…" : "Sync now"}</Button>}
        {(c.status === "needs_reauth" || expiring) && <Button disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>Reconnect</Button>}
        {confirming ? (
          <span className="flex items-center gap-2 text-sm">
            Disconnect? Synced data is kept.
            <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Disconnect</Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Keep</Button>
          </span>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>Disconnect</Button>
        )}
      </div>

      {c.status === "pending_account" && <AccountPicker c={c} onDone={refresh} />}

      {c.lastError && c.status !== "ok" && <div className="mt-2"><ErrorBox error={c.lastError} /></div>}
      {sync.data?.status === "failed" && <div className="mt-2"><ErrorBox error={sync.data.error} /></div>}
      {sync.error && <div className="mt-2"><ErrorBox error={sync.error.message} /></div>}
      {remove.error && <div className="mt-2"><ErrorBox error={remove.error.message} /></div>}
      {c.status === "ok" && c.lastSyncAt && (
        <p className="mt-1 text-xs text-zinc-500">
          Updated {new Date(c.lastSyncAt).toLocaleString()}{s && s.rows === 0 ? ". No data found yet in this account." : ""}
        </p>
      )}
    </div>
  );
}

function AccountPicker({ c, onDone }: { c: Connection; onDone: () => void }) {
  const accounts = useQuery({ queryKey: ["accounts", c.id], queryFn: () => api<Account[]>(`/connections/oauth/connections/${c.id}/accounts`) });
  const [choice, setChoice] = useState("");
  const [conversion, setConversion] = useState<"purchase" | "lead">("purchase");
  const picked = choice || accounts.data?.[0]?.id || "";

  const save = useMutation({
    mutationFn: () => api<{ sync: SyncOutcome }>(`/connections/oauth/connections/${c.id}/account`, {
      method: "POST", body: { accountId: picked, ...(c.provider === "meta_ads" ? { conversionAction: conversion } : {}) },
    }),
    onSettled: onDone,
  });

  return (
    <div className="mt-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="mb-2 text-sm font-medium">Which {c.provider === "ga4" ? "GA4 property" : "ad account"} should we read?</p>
      {accounts.isLoading && <Empty>Loading your accounts…</Empty>}
      {accounts.error && <ErrorBox error={accounts.error.message} />}
      {accounts.data?.length === 0 && <Empty>This login has no accessible accounts.</Empty>}
      {accounts.data && accounts.data.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Account" className={`${inputClass} !w-auto min-w-64`} value={picked} onChange={(e) => setChoice(e.target.value)}>
            {accounts.data.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          {c.provider === "meta_ads" && (
            <select aria-label="Count as conversion" className={`${inputClass} !w-auto`} value={conversion} onChange={(e) => setConversion(e.target.value as "purchase" | "lead")}>
              <option value="purchase">Count purchases</option>
              <option value="lead">Count leads</option>
            </select>
          )}
          <Button disabled={!picked || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Connecting and pulling 30 days…" : "Connect and sync"}</Button>
        </div>
      )}
      {save.error && <div className="mt-2"><ErrorBox error={save.error.message} /></div>}
      {save.data?.sync.status === "failed" && <div className="mt-2"><ErrorBox error={save.data.sync.error} /></div>}
    </div>
  );
}

function DemoData() {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const purge = useMutation({
    mutationFn: () => api<{ removed: number }>("/connections/demo-data/purge", { method: "POST" }),
    onSuccess: () => { setConfirming(false); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });
  return (
    <Card title="Demo data">
      <p className="text-sm text-zinc-500">The seeded sample campaigns are mixed into analysis. Remove them once real data is connected. Real and drafted campaigns are never touched.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <span className="text-sm">Remove all demo campaigns and their metrics?</span>
            <Button variant="danger" disabled={purge.isPending} onClick={() => purge.mutate()}>{purge.isPending ? "Removing…" : "Remove demo data"}</Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => { purge.reset(); setConfirming(true); }}>Remove demo data…</Button>
        )}
        {purge.data && <span className="text-sm text-zinc-500">{purge.data.removed === 0 ? "No demo data found." : `Removed ${purge.data.removed} demo campaign(s).`}</span>}
      </div>
      {purge.error && <div className="mt-2"><ErrorBox error={purge.error.message} /></div>}
    </Card>
  );
}
