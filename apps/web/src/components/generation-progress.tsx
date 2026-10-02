"use client";

import { useEffect, useState } from "react";
import type { ProgressEvent } from "@/lib/types";
import { Card } from "@/components/ui";

/** The workflow's steps in plain words. Tool calls are shown by their real names, as on the Tool history page. */
const STEP: Record<string, string> = {
  write_plan: "Writing the campaign plan",
  check_plan: "Checking the plan against your brand rules",
  write_content: "Writing the ad copy",
  check_content: "Checking the copy: brand rules, links and length",
  fix_lengths: "Shortening lines that are too long",
};
const TOOL_HINT: Record<string, string> = {
  get_brand_guidelines: "reads your brand voice and rules",
  get_product_information: "reads your products",
  get_audience_segments: "reads your audiences",
};

function Dot({ status }: { status: ProgressEvent["status"] }) {
  if (status === "running") return <span className="mt-1.5 inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-500" aria-label="in progress" />;
  if (status === "error") return <span className="mt-0.5 shrink-0 text-xs text-red-600 dark:text-red-400" aria-label="did not finish">✕</span>;
  return <span className="mt-0.5 shrink-0 text-xs text-emerald-600 dark:text-emerald-400" aria-label="done">✓</span>;
}

/** What the assistant is doing right now, newest at the bottom. */
export function GenerationProgress({ events }: { events: ProgressEvent[] }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Loading the company details is shown through the three lookups it makes.
  const shown = events.filter((e) => e.name !== "load_context");
  const current = shown.filter((e) => e.status === "running").at(-1);

  return (
    <Card title={`Working on it… ${elapsed}s`}>
      <ul className="space-y-1.5" aria-live="polite">
        {shown.length === 0 && <li className="text-sm text-zinc-500">Starting…</li>}
        {shown.map((e) => (
          <li key={e.id} className={`flex items-start gap-2 text-sm ${e === current ? "font-medium" : e.status === "running" ? "" : "text-zinc-600 dark:text-zinc-400"}`}>
            <Dot status={e.status} />
            {e.kind === "tool"
              ? <span><span className="font-mono">{e.name}</span> <span className="text-xs text-zinc-500">{TOOL_HINT[e.name] ?? "reads your data"}</span></span>
              : <span>{STEP[e.name] ?? e.name}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
