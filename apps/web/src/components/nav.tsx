"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { PublishingStatus } from "@/lib/types";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/history", label: "Tool history" },
  { href: "/settings", label: "Settings" },
];

export function TopNav() {
  const path = usePathname();
  const mode = useQuery({ queryKey: ["publishing-status"], queryFn: () => api<PublishingStatus>("/publishing/status"), staleTime: 60_000 }).data?.mode;
  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      <div className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
        <Link href="/" className="text-sm font-semibold tracking-tight">Marketing Agent</Link>
        <nav className="flex gap-1" aria-label="Main">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${active ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"}`}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        {mode === "demo" && <span className="ml-auto rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-900 dark:bg-sky-950 dark:text-sky-200" title="Ads are posted to a built-in sandbox. Nothing real is posted.">Demo mode</span>}
      </div>
    </header>
  );
}
