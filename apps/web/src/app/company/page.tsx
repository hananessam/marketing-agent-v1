"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Company } from "@/lib/types";
import { CompanyForm } from "@/components/company-form";
import { Empty, ErrorBox, PageHeader } from "@/components/ui";

export default function CompanyPage() {
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company") });
  return (
    <>
      <PageHeader title="Company" subtitle="What the assistant knows about your business. Changes apply to new drafts straight away." />
      {company.isLoading && <Empty>Loading…</Empty>}
      {company.error && <ErrorBox error={company.error.message} />}
      {/* keyed on the saved name so the form resets cleanly if the data is refetched elsewhere */}
      {company.data && <CompanyForm initial={company.data} mode="settings" />}
    </>
  );
}
