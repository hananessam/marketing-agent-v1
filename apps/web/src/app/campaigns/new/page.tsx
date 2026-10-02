"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { GenerationProgress } from "@/components/generation-progress";
import { api } from "@/lib/api";
import { friendlyViolation } from "@/lib/format";
import type { Company, GenerateResult, GenerationProgress as Progress } from "@/lib/types";
import { Button, Card, Empty, ErrorBox, PageHeader, inputClass } from "@/components/ui";

const GOALS = [
  { value: "leads", label: "Get sign-ups or leads" },
  { value: "sales", label: "Get sales" },
  { value: "awareness", label: "Get known" },
  { value: "retention", label: "Keep existing customers" },
] as const;
const CHANNELS = [
  { value: "google_ads", label: "Google Ads" }, { value: "meta_ads", label: "Facebook & Instagram ads" },
] as const;

export default function NewCampaignPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  const [goal, setGoal] = useState<(typeof GOALS)[number]["value"]>("leads");
  const [product, setProduct] = useState("");
  const [audience, setAudience] = useState("");
  const [channels, setChannels] = useState<string[]>(["google_ads"]);

  const products = company.data?.products ?? [];
  const audiences = company.data?.audiences ?? [];
  const chosenProduct = product || products[0]?.name || "";
  const chosenAudience = audience || audiences[0]?.name || "";

  // The page names its own request so it can watch it while it runs.
  const [progressKey, setProgressKey] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (key: string) => api<GenerateResult>("/campaigns/generate", {
      method: "POST",
      headers: { "x-progress-key": key },
      // Everything else the assistant needs comes from your company details; the rest uses sensible defaults.
      body: { brief: { objective: goal, product: chosenProduct, audience: chosenAudience, channels, durationDays: 14, constraints: [] } },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      if (res.output.campaignId) router.push(`/campaigns/${res.output.campaignId}`);
    },
  });
  const progress = useQuery({
    queryKey: ["campaign-progress", progressKey],
    queryFn: () => api<Progress>(`/campaigns/progress/${progressKey}`),
    enabled: create.isPending && progressKey !== null,
    refetchInterval: 700,
    refetchIntervalInBackground: true, // keep going even if the tab is not in front: the work was just started from here
  });
  const failure = create.data && !create.data.output.campaignId ? create.data.output : null;
  const submit = (e: FormEvent) => { e.preventDefault(); const key = crypto.randomUUID(); setProgressKey(key); create.mutate(key); };

  return (
    <>
      <PageHeader title="New campaign" subtitle="Answer three questions and the assistant writes a first draft. You review it before anything is approved." />
      {company.isLoading && <Empty>Loading…</Empty>}
      {company.data && (
        <form onSubmit={submit} className="space-y-4">
          <Card>
            <div className="space-y-5">
              <label className="block text-sm"><span className="mb-1 block font-medium">What do you want?</span>
                <select className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value as typeof goal)}>{GOALS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select>
              </label>
              <div className="grid gap-5 sm:grid-cols-2">
                <label className="block text-sm"><span className="mb-1 block font-medium">For which product?</span>
                  <select className={inputClass} value={chosenProduct} onChange={(e) => setProduct(e.target.value)}>{products.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}</select>
                </label>
                <label className="block text-sm"><span className="mb-1 block font-medium">For whom?</span>
                  <select className={inputClass} value={chosenAudience} onChange={(e) => setAudience(e.target.value)}>{audiences.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}</select>
                </label>
              </div>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">Where?</legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {CHANNELS.map((c) => (
                    <label key={c.value} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={channels.includes(c.value)} onChange={(e) => setChannels(e.target.checked ? [...channels, c.value] : channels.filter((x) => x !== c.value))} />
                      {c.label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </Card>

          {create.isPending && <GenerationProgress events={progress.data?.events ?? []} />}
          {create.error && <ErrorBox error={create.error.message} />}
          {failure && (
            <ErrorBox error="We couldn't write a draft that follows your brand rules, so nothing was saved. Please try again."
              details={[...(failure.planErrors ?? []), ...(failure.contentErrors ?? [])].map(friendlyViolation).concat(failure.error ? [failure.error] : [])} />
          )}
          <Button type="submit" disabled={create.isPending || channels.length === 0 || !chosenProduct || !chosenAudience}>
            {create.isPending ? "Writing your draft…" : "Create draft"}
          </Button>
          {channels.length === 0 && <span className="ml-3 text-sm text-zinc-500">Pick at least one place.</span>}
        </form>
      )}
    </>
  );
}
