"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Company } from "@/lib/types";
import { CompanyForm } from "@/components/company-form";
import { ConnectionsPanel } from "@/components/connections-panel";
import { Empty, ErrorBox, PageHeader } from "@/components/ui";

/** Everything you set up once, on one page: who you are, and which accounts to read. */
export default function SettingsPage() {
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  return (
    <>
      <PageHeader title="Settings" />
      <section aria-labelledby="accounts" className="mb-10">
        <h2 id="accounts" className="mb-1 text-lg font-semibold">Your accounts</h2>
        <ConnectionsPanel />
      </section>
      <section aria-labelledby="company">
        <h2 id="company" className="mb-1 text-lg font-semibold">Your company</h2>
        <p className="mb-4 text-sm text-zinc-500">What the assistant knows about your business. Changes apply to new drafts straight away.</p>
        {company.isLoading && <Empty>Loading…</Empty>}
        {company.error && <ErrorBox error={company.error.message} />}
        {company.data && <CompanyForm initial={company.data} mode="settings" />}
      </section>
    </>
  );
}
