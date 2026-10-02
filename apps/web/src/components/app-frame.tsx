"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { TopNav } from "@/components/nav";
import { Empty } from "@/components/ui";
import { api } from "@/lib/api";
import type { Company } from "@/lib/types";

/**
 * A top bar and a single narrow column. The one exception is first-time setup: until the company details are saved,
 * the home page is only the setup form, with nothing else on screen.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api<Company>("/company"), enabled: path === "/" });

  if (path === "/" && company.isLoading) return <div className="p-8"><Empty>Loading…</Empty></div>;
  if (path === "/" && company.data && !company.data.onboarded) return <main className="mx-auto max-w-2xl px-4 py-10">{children}</main>;

  return (
    <>
      <TopNav />
      <main className="mx-auto max-w-3xl px-4 py-8">{children}</main>
    </>
  );
}
