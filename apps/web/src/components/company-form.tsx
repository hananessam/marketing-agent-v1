"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, errorDetails } from "@/lib/api";
import type { Company, CompanyItem } from "@/lib/types";
import { Button, Card, ErrorBox, inputClass } from "@/components/ui";

const toLines = (t: string) => t.split("\n").map((s) => s.trim()).filter(Boolean);

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {hint && <span className="mb-1.5 block text-xs text-zinc-500">{hint}</span>}
      {children}
    </label>
  );
}

function ItemList({ title, hint, noun, items, onChange, namePlaceholder, descPlaceholder }: {
  title: string; hint: string; noun: string; items: CompanyItem[]; onChange: (v: CompanyItem[]) => void; namePlaceholder: string; descPlaceholder: string;
}) {
  const set = (i: number, patch: Partial<CompanyItem>) => onChange(items.map((it, n) => (n === i ? { ...it, ...patch } : it)));
  return (
    <Card title={title}>
      <p className="mb-4 text-sm text-zinc-500">{hint}</p>
      <ul className="space-y-4">
        {items.map((it, i) => (
          <li key={i} className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <Field label="Name"><input required maxLength={100} className={inputClass} value={it.name} placeholder={namePlaceholder} onChange={(e) => set(i, { name: e.target.value })} /></Field>
              <Field label="In a sentence or two"><input required maxLength={500} className={inputClass} value={it.description} placeholder={descPlaceholder} onChange={(e) => set(i, { description: e.target.value })} /></Field>
            </div>
            {items.length > 1 && <button type="button" onClick={() => onChange(items.filter((_, n) => n !== i))} className="mt-2 text-xs text-red-600 underline dark:text-red-400">Remove this {noun}</button>}
          </li>
        ))}
      </ul>
      <Button type="button" variant="secondary" className="mt-3" onClick={() => onChange([...items, { name: "", description: "" }])}>+ Add another {noun}</Button>
    </Card>
  );
}

/** Company details the assistant writes from and checks against. Used for first-time setup and for later edits. */
export function CompanyForm({ initial, mode }: { initial: Company; mode: "onboarding" | "settings" }) {
  const qc = useQueryClient();
  const [name, setName] = useState(initial.sample && !initial.onboarded ? "" : initial.name);
  const [voice, setVoice] = useState(initial.voice);
  const [products, setProducts] = useState<CompanyItem[]>(initial.products.length ? initial.products : [{ name: "", description: "" }]);
  const [audiences, setAudiences] = useState<CompanyItem[]>(initial.audiences.length ? initial.audiences : [{ name: "", description: "" }]);
  const [claims, setClaims] = useState(initial.approvedClaims.join("\n"));
  const [avoid, setAvoid] = useState(initial.prohibited.join("\n"));
  const [domains, setDomains] = useState(initial.allowedDomains.join("\n"));

  const save = useMutation({
    mutationFn: () => api<Company>("/company", {
      method: "PUT",
      body: { name, voice, products, audiences, approvedClaims: toLines(claims), prohibited: toLines(avoid), allowedDomains: toLines(domains) },
    }),
    onSuccess: (saved) => {
      qc.setQueryData(["company"], saved); // on first setup this switches the home page over to the Overview
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); save.mutate(); };

  return (
    <form onSubmit={submit} className="space-y-5">
      {initial.sample && (
        <p role="note" className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950/40">
          Sample details are filled in so you can see how this works. Replace them with your own before you save.
        </p>
      )}

      <Card title="Your company">
        <Field label="Company name"><input required maxLength={100} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Inc" autoComplete="organization" /></Field>
      </Card>

      <ItemList title="What you sell" noun="product" items={products} onChange={setProducts}
        hint="List your products or services. When you create a campaign you pick one of these."
        namePlaceholder="e.g. Acme Planner" descPlaceholder="e.g. Project planning software for small teams" />

      <ItemList title="Who you sell to" noun="audience" items={audiences} onChange={setAudiences}
        hint="The kinds of customers you want to reach."
        namePlaceholder="e.g. Startup founders" descPlaceholder="e.g. Teams of 2 to 10 shipping their first product" />

      <Card title="How your brand sounds">
        <Field label="Describe your tone of voice" hint="The assistant writes in this voice.">
          <textarea required rows={3} maxLength={1000} className={inputClass} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="e.g. Friendly, clear and practical. No hype, no jargon." />
        </Field>
      </Card>

      <Card title="Claims you are allowed to make">
        <Field label="One per line" hint="The assistant may only state facts and offers from this list. Anything else it is tempted to promise, such as a discount, a guarantee or a statistic, is blocked.">
          <textarea rows={4} className={inputClass} value={claims} onChange={(e) => setClaims(e.target.value)} placeholder={"Free 30-day trial\nSet up in under 10 minutes"} />
        </Field>
      </Card>

      <Card title="Words and phrases to avoid">
        <Field label="One per line" hint="Copy that contains any of these is rejected.">
          <textarea rows={3} className={inputClass} value={avoid} onChange={(e) => setAvoid(e.target.value)} placeholder={"guaranteed results\n#1 in the world"} />
        </Field>
      </Card>

      <Card title="Your website">
        <Field label="One address per line" hint="Links in drafts may only point to these sites, and must carry tracking parameters. Just the domain is fine; subdomains are included.">
          <textarea rows={2} className={inputClass} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={"acme.com"} />
        </Field>
      </Card>

      {save.error && <ErrorBox error={save.error.message} details={errorDetails(save.error)} />}
      {mode === "settings" && save.isSuccess && <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">Saved. New drafts will use these details.</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : mode === "onboarding" ? "Save and continue" : "Save changes"}</Button>
        {mode === "onboarding" && <span className="text-sm text-zinc-500">You can change all of this later under “Company”.</span>}
      </div>
    </form>
  );
}
