import { label } from "@/lib/format";
import type { AgentAction } from "@/lib/types";

const str = (v: unknown) => (v === null || v === undefined || v === "" ? "" : String(v));

/** The "what exactly would happen" part of an action, in plain terms. */
export function ActionDetails({ action }: { action: AgentAction }) {
  const d = action.preview.details as Record<string, unknown>;

  if (action.type === "publish_campaign") {
    const channels = (d.channels as { channel: string; items: { kind: string; variant: string; content: string }[] }[]) ?? [];
    return (
      <div className="space-y-3 text-sm">
        <p className="text-xs text-zinc-500">The approved copy, ready to copy into each channel:</p>
        {channels.map((c) => (
          <div key={c.channel}>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label(c.channel)}</p>
            <ul className="mt-1 space-y-1.5">
              {c.items.map((it, i) => (
                <li key={i} className="rounded border border-zinc-200 p-2 dark:border-zinc-800">
                  <span className="text-xs text-zinc-500">{label(it.kind)} · version {it.variant}</span>
                  <p className="whitespace-pre-wrap">{it.content}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  if (action.type === "schedule_email") {
    const subjects = (d.subjectLines as string[]) ?? [];
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">Campaign</dt><dd>{str(d.campaign)}</dd>
        <dt className="text-zinc-500">Send at</dt><dd>{new Date(str(d.sendAt)).toLocaleString()}</dd>
        <dt className="text-zinc-500">Subject lines</dt><dd>{subjects.length ? subjects.map((s, i) => <span key={i} className="block">{s}</span>) : "n/a"}</dd>
      </dl>
    );
  }

  const rows: [string, string][] = action.type === "create_task"
    ? [["Task", action.preview.summary.replace(/^Add task: /, "")], ["Details", str(d.description)], ["Campaign", str(d.campaign)]]
    : [["Campaign", str(d.campaign)], ["Where", str(d.platform)], ["Currently", str(d.currentStatus)],
       ["Change", d.direction ? `${str(d.direction)} by ${str(d.percent)}%` : ""], ["Why", str(d.reason)]];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {rows.filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="whitespace-pre-wrap">{v}</dd></div>)}
    </dl>
  );
}
