import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsService } from "../analytics/analytics.service";
import type { Db } from "../db";
import { createTestDb, schema } from "../test/helpers";
import { createNotifier, formatReportMessage, SlackNotifier, type Notifier } from "./notifier";
import type { JobQueue, ReportJobData } from "./queue.port";
import { ReportsService } from "./reports.service";

class FakeQueue implements JobQueue {
  enabled = true;
  handler?: (d: ReportJobData) => Promise<void>;
  jobs = new Map<string, ReportJobData>();
  schedules = new Map<string, { cron: string; tz: string; data: ReportJobData }>();
  start(h: (d: ReportJobData) => Promise<void>) { this.handler = h; }
  async enqueue(data: ReportJobData, jobId: string) {
    const deduped = this.jobs.has(jobId);
    if (!deduped) this.jobs.set(jobId, data);
    return { jobId, deduped };
  }
  async upsertSchedule(id: string, cron: string, tz: string, data: ReportJobData) { this.schedules.set(id, { cron, tz, data }); }
  async removeSchedule(id: string) { this.schedules.delete(id); }
  async listScheduleIds() { return [...this.schedules.keys()]; }
  async jobInfo(id: string) { return this.jobs.has(id) ? { state: "waiting", attemptsMade: 0 } : null; }
}

const okOutput = { periods: { current: { startDate: "2026-03-08", endDate: "2026-03-14" }, previous: { startDate: "2026-03-01", endDate: "2026-03-07" } }, dataQualityIssues: [],
  report: { summary: "All good", biggestChanges: [], caveats: [], recommendations: [{ title: "Fix landing page", action: "Do X", requiresApproval: false }] } };

let db: Db;
let queue: FakeQueue;
let run: ReturnType<typeof vi.fn>;
let notifier: Notifier & { sendReport: ReturnType<typeof vi.fn> };
let svc: ReportsService;

beforeEach(async () => {
  db = await createTestDb();
  queue = new FakeQueue();
  run = vi.fn().mockResolvedValue({ runId: "r", status: "succeeded", reused: false, output: okOutput });
  notifier = { enabled: true, sendReport: vi.fn().mockResolvedValue(undefined) };
  svc = new ReportsService(db, queue, notifier, { run } as unknown as AnalyticsService);
  db.insert(schema.workspaces).values([{ id: "w", name: "w" }, { id: "x", name: "x" }]).run();
});

const body = { cron: "0 8 * * 1", timezone: "UTC", days: 7, notify: true };

describe("process (job handler)", () => {
  it("runs the analysis and notifies when asked", async () => {
    await svc.process({ workspaceId: "w", days: 7, notify: true });
    expect(run).toHaveBeenCalledWith("w", { endDate: undefined, days: 7 });
    expect(notifier.sendReport).toHaveBeenCalledTimes(1);
  });

  it("does not notify when not requested or when the result was reused (no duplicate messages on retry)", async () => {
    await svc.process({ workspaceId: "w", days: 7, notify: false });
    run.mockResolvedValue({ runId: "r", status: "succeeded", reused: true, output: okOutput });
    await svc.process({ workspaceId: "w", days: 7, notify: true });
    expect(notifier.sendReport).not.toHaveBeenCalled();
  });

  it("throws on a failed or in-progress run so the queue retries", async () => {
    run.mockResolvedValue({ runId: "r", status: "failed", reused: false, output: { error: "OpenAI down" } });
    await expect(svc.process({ workspaceId: "w", days: 7, notify: true })).rejects.toThrow("OpenAI down");
    run.mockResolvedValue({ runId: "r", status: "running", reused: true, output: null });
    await expect(svc.process({ workspaceId: "w", days: 7, notify: true })).rejects.toThrow(/still running/);
    expect(notifier.sendReport).not.toHaveBeenCalled();
  });

  it("does not fail the job when the notification fails", async () => {
    notifier.sendReport.mockRejectedValue(new Error("slack down"));
    await expect(svc.process({ workspaceId: "w", days: 7, notify: true })).resolves.toBeUndefined();
  });
});

describe("enqueue", () => {
  it("dedupes identical requests for the same day and workspace", async () => {
    const a = await svc.enqueue("w", { days: 7, notify: false });
    const b = await svc.enqueue("w", { days: 7, notify: false });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(queue.jobs.size).toBe(1);
    expect((await svc.enqueue("x", { days: 7, notify: false })).deduped).toBe(false);
  });

  it("only exposes a workspace's own jobs", async () => {
    const { jobId } = await svc.enqueue("w", { days: 7, notify: false });
    expect(await svc.job("w", jobId)).toMatchObject({ state: "waiting" });
    await expect(svc.job("x", jobId)).rejects.toThrow(/not found/);
  });

  it("returns 503 when Redis is not configured", async () => {
    queue.enabled = false;
    await expect(svc.enqueue("w", { days: 7, notify: false })).rejects.toThrow(/REDIS_URL/);
    await expect(svc.createSchedule("w", body)).rejects.toThrow(/REDIS_URL/);
    expect(() => svc.listSchedules("w")).toThrow(/REDIS_URL/);
  });
});

describe("schedules", () => {
  it("stores and registers a schedule, and re-registers all on boot without duplicating", async () => {
    const s = await svc.createSchedule("w", body);
    expect(queue.schedules.get(s!.id)).toMatchObject({ cron: "0 8 * * 1", tz: "UTC", data: { workspaceId: "w", days: 7, notify: true } });
    queue.schedules.clear();
    svc.onModuleInit(); await svc.scheduleSync;
    expect(queue.schedules.size).toBe(1);
    svc.onModuleInit(); await svc.scheduleSync;
    expect(queue.schedules.size).toBe(1);
    expect(queue.handler).toBeDefined();
  });

  it("removes orphaned schedulers on boot and skips jobs for deleted schedules", async () => {
    const kept = (await svc.createSchedule("w", body))!;
    queue.schedules.set("ghost", { cron: "0 8 * * 1", tz: "UTC", data: { workspaceId: "w", days: 7, notify: false, scheduleId: "ghost" } });
    svc.onModuleInit(); await svc.scheduleSync;
    expect([...queue.schedules.keys()]).toEqual([kept.id]);

    await svc.process({ workspaceId: "w", days: 7, notify: true, scheduleId: "ghost" });
    expect(run).not.toHaveBeenCalled();
    await svc.process({ workspaceId: "w", days: 7, notify: true, scheduleId: kept.id });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects bad cron, bad timezone and schedules more frequent than hourly", async () => {
    await expect(svc.createSchedule("w", { ...body, cron: "not a cron" })).rejects.toThrow(/Invalid cron/);
    await expect(svc.createSchedule("w", { ...body, timezone: "Mars/Base" })).rejects.toThrow(/timezone/);
    await expect(svc.createSchedule("w", { ...body, cron: "*/5 * * * *" })).rejects.toThrow(/once per hour/);
    await expect(svc.createSchedule("w", { ...body, cron: "0 8 * * * *" })).rejects.toThrow(/5-field/);
    expect(svc.listSchedules("w")).toEqual([]);
  });

  it("rolls back the row if registering fails", async () => {
    queue.upsertSchedule = async () => { throw new Error("redis down"); };
    await expect(svc.createSchedule("w", body)).rejects.toThrow("redis down");
    expect(svc.listSchedules("w")).toEqual([]);
  });

  it("isolates workspaces on list and delete", async () => {
    const s = (await svc.createSchedule("w", body))!;
    expect(svc.listSchedules("x")).toEqual([]);
    await expect(svc.deleteSchedule("x", s.id)).rejects.toThrow(/not found/);
    await svc.deleteSchedule("w", s.id);
    expect(queue.schedules.size).toBe(0);
    expect(svc.listSchedules("w")).toEqual([]);
  });
});

describe("notifier", () => {
  it("formats a readable Slack message with approval flags", () => {
    const text = formatReportMessage({ ...okOutput, report: { ...okOutput.report, recommendations: [{ title: "Pause creative", action: "Pause X", requiresApproval: true }] } } as never, "http://dash");
    expect(text).toContain("Pause creative");
    expect(text).toContain("needs approval");
    expect(text).toContain("<http://dash|Open dashboard>");
  });

  it("only accepts https hooks.slack.com webhooks", () => {
    expect(createNotifier({ SLACK_WEBHOOK_URL: "https://evil.example/hook" }).enabled).toBe(false);
    expect(createNotifier({ SLACK_WEBHOOK_URL: "http://hooks.slack.com/x" }).enabled).toBe(false);
    expect(createNotifier({}).enabled).toBe(false);
    expect(createNotifier({ SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" }).enabled).toBe(true);
  });

  it("posts JSON to the webhook and surfaces HTTP errors", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await new SlackNotifier("https://hooks.slack.com/x", "http://dash", f as never).sendReport("w", okOutput as never);
    expect(f.mock.calls[0][0]).toBe("https://hooks.slack.com/x");
    expect(JSON.parse(f.mock.calls[0][1].body).text).toContain("Marketing report");
    f.mockResolvedValue({ ok: false, status: 500 });
    await expect(new SlackNotifier("https://hooks.slack.com/x", "d", f as never).sendReport("w", okOutput as never)).rejects.toThrow("500");
  });
});
