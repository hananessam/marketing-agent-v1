import { METRIC_LABEL, formatChange, formatMetric } from "@/lib/format";
import type { Metric } from "@/lib/types";

/** One headline number with how it moved compared with the previous period. */
export function Tile({ metric, value, delta, goodWhen }: { metric: Metric; value: number | null; delta: number | null; goodWhen: "up" | "down" | "neutral" }) {
  const meta = METRIC_LABEL[metric];
  const flat = delta === null || Math.abs(delta) < 0.02;
  const good = !flat && goodWhen !== "neutral" && (delta! > 0) === (goodWhen === "up");
  const tone = flat || goodWhen === "neutral" ? "text-zinc-500" : good ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900" title={meta.hint}>
      <p className="text-xs font-medium text-zinc-500">{meta.name}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{formatMetric(metric, value)}</p>
      <p className={`mt-1 text-xs ${tone}`}>
        {delta === null ? "" : flat ? "About the same" : <><span aria-hidden>{delta > 0 ? "▲" : "▼"}</span> {formatChange(delta)}<span className="sr-only">{goodWhen !== "neutral" ? (good ? " (better)" : " (worse)") : ""}</span></>}
      </p>
    </div>
  );
}
