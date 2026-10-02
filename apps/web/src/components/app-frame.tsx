"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Nav } from "@/components/nav";
import { Empty } from "@/components/ui";
import { api } from "@/lib/api";
import type { Company } from "@/lib/types";

/**
 * Normal pages get the sidebar. The one exception is first-time setup: until the company details are saved, the home
 * page is only the setup form, with nothing else on screen.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company"), enabled: path === "/" });

  if (path === "/" && company.isLoading) return <div className="p-8"><Empty>Loading…</Empty></div>;
  if (path === "/" && company.data && !company.data.onboarded) return <main className="mx-auto max-w-2xl px-4 py-10">{children}</main>;

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 md:flex-row">
      <aside className="md:w-48 md:shrink-0">
        <p className="mb-4 px-3 text-sm font-semibold tracking-tight">Marketing Agent</p>
        <Nav />
        <p className="mt-6 hidden px-3 text-xs text-zinc-500 md:block">Drafts only. Nothing is published or sent without approval.</p>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
