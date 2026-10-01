"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Approval } from "@/lib/types";

const LINKS = [
  { href: "/", label: "Analytics" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/approvals", label: "Approvals" },
  { href: "/connections", label: "Connections" },
  { href: "/schedules", label: "Schedules" },
  { href: "/audit", label: "Audit log" },
];

export function Nav() {
  const path = usePathname();
  const pending = useQuery({ queryKey: ["approvals", "pending"], queryFn: () => api<Approval[]>("/approvals?status=pending") });
  const count = pending.data?.length ?? 0;
  return (
    <nav className="flex gap-1 md:flex-col">
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href}
            className={`flex items-center justify-between rounded-md px-3 py-2 text-sm ${active ? "bg-zinc-200 font-medium dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"}`}>
            {l.label}
            {l.href === "/approvals" && count > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-xs font-semibold text-white">{count}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
