"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { ApiError, api, errorDetails } from "@/lib/api";
import type { EnqueueResult, JobInfo, Schedule } from "@/lib/types";
import { Badge, Button, Card, Empty, ErrorBox, PageHeader, inputClass, statusTone } from "@/components/ui";

const PRESETS = [
  { label: "Every Monday 08:00", cron: "0 8 * * 1" },
  { label: "Every day 08:00", cron: "0 8 * * *" },
  { label: "Weekdays 09:00", cron: "0 9 * * 1-5" },
  { label: "Custom…", cron: "" },
];

const JOB_TONE: Record<string, "good" | "bad" | "info" | "warn"> = { completed: "good", failed: "bad", active: "info", waiting: "warn", delayed: "warn" };

export default function SchedulesPage() {
  const qc = useQueryClient();
  const schedules = useQuery({ queryKey: ["schedules"], queryFn: () => api<Schedule[]>("/reports/schedules") });
  // 503 means the server has no Redis configured: say so once instead of on every panel.
  const disabled = schedules.error instanceof ApiError && schedules.error.status === 503;

  return (
    <>
      <PageHeader title="Schedules" subtitle="Run the analysis automatically in the background. Reports are saved to the Analytics page." />
      {disabled && <div className="mb-4"><ErrorBox error="Background jobs are disabled on the server. Set REDIS_URL for the API and restart it." /></div>}
      {schedules.error && !disabled && <div className="mb-4"><ErrorBox error={schedules.error.message} /></div>}
      {!disabled && (
        <div className="space-y-4">
          <RunNow />
          <Card title="Scheduled reports">
            {schedules.isLoading && <Empty>Loading…</Empty>}
            {schedules.data?.length === 0 && <Empty>No schedules yet. Add one below.</Empty>}
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {schedules.data?.map((s) => <ScheduleRow key={s.id} s={s} onChanged={() => qc.invalidateQueries({ queryKey: ["schedules"] })} />)}
            </ul>
          </Card>
          <NewSchedule onCreated={() => qc.invalidateQueries({ queryKey: ["schedules"] })} />
        </div>
      )}
    </>
  );
}

function ScheduleRow({ s, onChanged }: { s: Schedule; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const del = useMutation({ mutationFn: () => api(`/reports/schedules/${s.id}`, { method: "DELETE" }), onSuccess: onChanged });
  const preset = PRESETS.find((p) => p.cron === s.cron)?.label;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{preset ?? "Custom schedule"}</span>
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800">{s.cron}</code>
        <span className="text-xs text-zinc-500">{s.timezone}</span>
        <Badge>{s.days}-day analysis</Badge>
        {s.notify && <Badge tone="info">Slack</Badge>}
        <span className="grow" />
        {confirming ? (
          <span className="flex items-center gap-2 text-sm">
            Delete this schedule?
            <Button variant="danger" disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? "Deleting…" : "Delete"}</Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>Keep</Button>
          </span>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>Delete</Button>
        )}
      </div>
      {del.error && <div className="mt-2"><ErrorBox error={del.error.message} /></div>}
    </li>
  );
}

function NewSchedule({ onCreated }: { onCreated: () => void }) {
  const [preset, setPreset] = useState(PRESETS[0].cron);
  const [custom, setCustom] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [days, setDays] = useState(7);
  const [notify, setNotify] = useState(false);
  const isCustom = preset === "";
  const cron = isCustom ? custom.trim() : preset;

  const create = useMutation({
    mutationFn: () => api<Schedule>("/reports/schedules", { method: "POST", body: { cron, timezone: timezone.trim(), days, notify } }),
    onSuccess: () => { onCreated(); setCustom(""); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <Card title="Add a schedule">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="When">
            <select className={inputClass} value={preset} onChange={(e) => setPreset(e.target.value)}>
              {PRESETS.map((p) => <option key={p.label} value={p.cron}>{p.label}</option>)}
            </select>
          </Field>
          {isCustom ? (
            <Field label="Cron expression (5 fields, at most hourly)">
              <input required className={`${inputClass} font-mono`} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="30 7 * * 1-5" />
            </Field>
          ) : (
            <Field label="Cron expression"><input readOnly className={`${inputClass} font-mono opacity-70`} value={preset} /></Field>
          )}
          <Field label="Timezone">
            <div className="flex gap-2">
              <input required className={inputClass} value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Africa/Cairo" />
              <Button type="button" variant="secondary" className="shrink-0"
                onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use mine</Button>
            </div>
          </Field>
          <Field label="Compare the last…">
            <select className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>7 days vs the 7 before</option>
              <option value={14}>14 days vs the 14 before</option>
            </select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          <span>Post the summary to Slack<span className="block text-xs text-zinc-500">Only works if the server has SLACK_WEBHOOK_URL configured.</span></span>
        </label>
        {create.error && <ErrorBox error={create.error.message} details={errorDetails(create.error)} />}
        <Button type="submit" disabled={create.isPending || !cron || !timezone.trim()}>{create.isPending ? "Saving…" : "Add schedule"}</Button>
      </form>
    </Card>
  );
}

function RunNow() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [jobId, setJobId] = useState<string | null>(null);

  const enqueue = useMutation({
    mutationFn: () => api<EnqueueResult>("/reports/enqueue", { method: "POST", body: { days } }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const job = useQuery({
    queryKey: ["job", jobId],
    enabled: jobId !== null,
    queryFn: async () => {
      const j = await api<JobInfo>(`/reports/jobs/${jobId}`);
      if (j.state === "completed") qc.invalidateQueries({ queryKey: ["analytics-runs"] });
      return j;
    },
    // Poll until the job reaches a final state.
    refetchInterval: (q) => (q.state.data && ["completed", "failed"].includes(q.state.data.state) ? false : 3000),
  });

  const j = job.data;
  return (
    <Card title="Run now in the background">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Period length" value={days} onChange={(e) => setDays(Number(e.target.value))} className={`${inputClass} !w-auto`}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
        </select>
        <Button onClick={() => enqueue.mutate()} disabled={enqueue.isPending}>{enqueue.isPending ? "Queuing…" : "Queue report"}</Button>
        {enqueue.data?.deduped && <span className="text-sm text-zinc-500">Already queued for today, so nothing new was added.</span>}
        {j && <Badge tone={JOB_TONE[j.state] ?? statusTone(j.state)}>{j.state}</Badge>}
        {j?.state === "completed" && <Link href="/" className="text-sm underline">View the report</Link>}
      </div>
      {enqueue.error && <div className="mt-3"><ErrorBox error={enqueue.error.message} /></div>}
      {j?.state === "failed" && <div className="mt-3"><ErrorBox error={`Failed after ${j.attemptsMade} attempt(s)`} details={j.failedReason ? [j.failedReason] : []} /></div>}
      {j && j.attemptsMade > 0 && !["completed", "failed"].includes(j.state) && <p className="mt-2 text-xs text-zinc-500">Attempt {j.attemptsMade} failed; retrying with backoff.</p>}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium">{label}</span>{children}</label>;
}
