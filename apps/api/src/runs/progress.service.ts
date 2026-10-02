import { Injectable } from "@nestjs/common";

export type ProgressEvent = {
  id: number;
  /** A tool call (get_brand_guidelines, ...) or a step of the workflow (write_plan, ...). */
  kind: "tool" | "step";
  name: string;
  status: "running" | "done" | "error";
  startedAt: string;
  endedAt: string | null;
};

const MAX_EVENTS = 100;
/** Progress only matters while someone is watching; it is dropped soon after the run ends. */
const KEEP_AFTER_FINISH_MS = 10 * 60_000;

/**
 * What a run is doing right now, kept in memory (it is live information, not history: the history is the audit log).
 * Everything is keyed by run id, which the caller already has to be allowed to know.
 */
@Injectable()
export class ProgressService {
  private readonly runs = new Map<string, { events: ProgressEvent[]; next: number }>();
  /** The page picks a key before it asks for the work, so it can watch the work it just started. */
  private readonly keys = new Map<string, string>();

  start(runId: string, watchKey?: { workspaceId: string; key: string }) {
    this.runs.set(runId, { events: [], next: 1 });
    if (watchKey) this.keys.set(`${watchKey.workspaceId}:${watchKey.key}`, runId);
  }

  /** Which run a page's key stands for, within one workspace. */
  runFor(workspaceId: string, key: string): string | undefined {
    return this.keys.get(`${workspaceId}:${key}`);
  }

  /** Marks something as started. Call the returned function when it ends; it is safe to call without a `start`. */
  begin(runId: string, kind: ProgressEvent["kind"], name: string): (ok: boolean) => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    const event: ProgressEvent = { id: run.next++, kind, name, status: "running", startedAt: new Date().toISOString(), endedAt: null };
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.shift();
    return (ok) => { event.status = ok ? "done" : "error"; event.endedAt = new Date().toISOString(); };
  }

  finish(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return;
    // Anything still marked running when the run ends was cut short.
    for (const e of run.events) if (e.status === "running") { e.status = "error"; e.endedAt = new Date().toISOString(); }
    setTimeout(() => {
      this.runs.delete(runId);
      for (const [k, id] of this.keys) if (id === runId) this.keys.delete(k);
    }, KEEP_AFTER_FINISH_MS).unref();
  }

  events(runId: string): ProgressEvent[] {
    return this.runs.get(runId)?.events.map((e) => ({ ...e })) ?? [];
  }
}
