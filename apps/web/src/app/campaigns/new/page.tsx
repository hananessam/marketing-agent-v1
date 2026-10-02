"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { friendlyViolation, label } from "@/lib/format";
import type { GenerateResult } from "@/lib/types";
import { Button, Card, ErrorBox, PageHeader, inputClass } from "@/components/ui";

const CHANNELS = ["email", "google_ads", "meta_ads", "linkedin", "blog"] as const;
const OBJECTIVES = ["awareness", "leads", "sales", "retention"] as const;

export default function NewCampaignPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    objective: "leads" as (typeof OBJECTIVES)[number], product: "Acme Planner", audience: "Startup founders",
    channels: ["email"] as string[], budget: "", durationDays: "14", constraints: "",
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const generate = useMutation({
    mutationFn: () => api<GenerateResult>("/campaigns/generate", {
      method: "POST",
      body: { brief: {
        objective: form.objective, product: form.product.trim(), audience: form.audience.trim(), channels: form.channels,
        durationDays: Number(form.durationDays),
        ...(form.budget ? { budget: Number(form.budget) } : {}),
        constraints: form.constraints.split("\n").map((s) => s.trim()).filter(Boolean),
      } },
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["approvals"] });
      if (res.output.campaignId) router.push(`/campaigns/${res.output.campaignId}`);
    },
  });

  const failure = generate.data && !generate.data.output.campaignId ? generate.data.output : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    generate.mutate();
  }

  return (
    <>
      <PageHeader title="New campaign" subtitle="The agent drafts a plan and content variants. Nothing is published; you review and approve everything." />
      <form onSubmit={submit} className="space-y-4">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Objective">
              <select className={inputClass} value={form.objective} onChange={(e) => set("objective", e.target.value as typeof form.objective)}>
                {OBJECTIVES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Product (must exist in your workspace)"><input required className={inputClass} value={form.product} onChange={(e) => set("product", e.target.value)} /></Field>
            <Field label="Audience"><input required className={inputClass} value={form.audience} onChange={(e) => set("audience", e.target.value)} /></Field>
            <Field label="Duration (days)"><input required type="number" min={1} className={inputClass} value={form.durationDays} onChange={(e) => set("durationDays", e.target.value)} /></Field>
            <Field label="Budget (optional)"><input type="number" min={0} className={inputClass} value={form.budget} onChange={(e) => set("budget", e.target.value)} /></Field>
          </div>
          <fieldset className="mt-4">
            <legend className="mb-1 text-sm font-medium">Channels</legend>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={form.channels.includes(c)}
                    onChange={(e) => set("channels", e.target.checked ? [...form.channels, c] : form.channels.filter((x) => x !== c))} />
                  {label(c)}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Constraints (one per line)" className="mt-4">
            <textarea rows={3} className={inputClass} value={form.constraints} onChange={(e) => set("constraints", e.target.value)} placeholder="No discounts&#10;Avoid jargon" />
          </Field>
        </Card>

        {generate.error && <ErrorBox error={generate.error.message} />}
        {failure && (
          <ErrorBox error="We couldn't produce a draft that follows your brand rules, so nothing was saved. Try again, or loosen the brief."
            details={[...(failure.planErrors ?? []), ...(failure.contentErrors ?? [])].map(friendlyViolation).concat(failure.error ? [failure.error] : [])} />
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={generate.isPending || form.channels.length === 0}>{generate.isPending ? "Drafting… (this can take a minute)" : "Generate draft"}</Button>
          {form.channels.length === 0 && <span className="text-sm text-zinc-500">Pick at least one channel.</span>}
        </div>
      </form>
    </>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`block text-sm ${className}`}><span className="mb-1 block font-medium">{label}</span>{children}</label>;
}
