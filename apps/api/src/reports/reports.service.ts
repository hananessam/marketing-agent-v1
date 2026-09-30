import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnModuleInit } from "@nestjs/common";
import { CronExpressionParser } from "cron-parser";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AnalyticsService, type AnalyticsOutput } from "../analytics/analytics.service";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { NOTIFIER, type Notifier } from "./notifier";
import { JOB_QUEUE, type JobQueue, type ReportJobData } from "./queue.port";

export const ScheduleBody = z.object({
  cron: z.string().min(9).max(100),
  timezone: z.string().default("UTC"),
  days: z.number().int().min(3).max(30).default(7),
  notify: z.boolean().default(false),
});
export const EnqueueBody = z.object({
  days: z.number().int().min(3).max(30).default(7),
  endDate: z.iso.date().optional(),
  notify: z.boolean().default(false),
});

/** Every scheduled run costs an LLM call, so refuse schedules more frequent than this. */
export const MIN_INTERVAL_MS = 60 * 60 * 1000;

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export function validateCron(cron: string, timezone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new BadRequestException(`Unknown timezone "${timezone}"`); }
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try { it = CronExpressionParser.parse(cron, { tz: timezone }); } catch { throw new BadRequestException(`Invalid cron expression "${cron}"`); }
  if (cron.trim().split(/\s+/).length !== 5) throw new BadRequestException("Use a standard 5-field cron expression");
  let prev = it.next().getTime();
  for (let i = 0; i < 6; i++) {
    const next = it.next().getTime();
    if (next - prev < MIN_INTERVAL_MS) throw new BadRequestException("Schedules may run at most once per hour");
    prev = next;
  }
}

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly log = new Logger(ReportsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(JOB_QUEUE) private readonly queue: JobQueue,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    private readonly analytics: AnalyticsService,
  ) {}

  async onModuleInit() {
    if (!this.queue.enabled) return;
    this.queue.start((data) => this.process(data));
    try {
      await this.syncSchedules();
    } catch (e) {
      this.log.error(`Could not sync schedules: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Job handler. Throwing makes the queue retry with backoff. */
  async process(data: ReportJobData) {
    const res = await this.analytics.run(data.workspaceId, { endDate: data.endDate, days: data.days });
    if (res.status === "running") throw new Error("An identical analysis is still running");
    if (res.status === "failed") {
      const o = res.output as { error?: string; errors?: string[]; note?: string } | null;
      throw new Error(o?.error ?? o?.errors?.join("; ") ?? o?.note ?? "Analysis failed");
    }
    // A reused result means an earlier attempt already produced (and announced) it.
    if (data.notify && !res.reused && this.notifier.enabled) {
      try {
        await this.notifier.sendReport(data.workspaceId, res.output as AnalyticsOutput);
      } catch (e) {
        // The report is saved; a chat outage must not fail or re-run the analysis.
        this.log.warn(`Notification failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  async enqueue(workspaceId: string, body: z.infer<typeof EnqueueBody>) {
    this.requireQueue();
    const day = body.endDate ?? new Date().toISOString().slice(0, 10);
    const jobId = `report_${safe(workspaceId)}_${body.days}_${day}`;
    return this.queue.enqueue({ workspaceId, days: body.days, endDate: body.endDate, notify: body.notify }, jobId);
  }

  async job(workspaceId: string, jobId: string) {
    this.requireQueue();
    if (!jobId.startsWith(`report_${safe(workspaceId)}_`)) throw new NotFoundException("Job not found");
    const info = await this.queue.jobInfo(jobId);
    if (!info) throw new NotFoundException("Job not found");
    return { jobId, ...info };
  }

  // ---------- schedules ----------

  async createSchedule(workspaceId: string, body: z.infer<typeof ScheduleBody>) {
    this.requireQueue();
    validateCron(body.cron, body.timezone);
    const row = { id: randomUUID(), workspaceId, cron: body.cron.trim(), timezone: body.timezone, days: body.days, notify: body.notify };
    this.db.insert(schema.reportSchedules).values(row).run();
    try {
      await this.register(row);
    } catch (e) {
      this.db.delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, row.id)).run();
      throw e;
    }
    return this.db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, row.id)).get();
  }

  listSchedules(workspaceId: string) {
    return this.db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.workspaceId, workspaceId)).all();
  }

  async deleteSchedule(workspaceId: string, id: string) {
    this.requireQueue();
    const found = this.db.select().from(schema.reportSchedules)
      .where(and(eq(schema.reportSchedules.workspaceId, workspaceId), eq(schema.reportSchedules.id, id))).get();
    if (!found) throw new NotFoundException("Schedule not found");
    await this.queue.removeSchedule(id);
    this.db.delete(schema.reportSchedules).where(eq(schema.reportSchedules.id, id)).run();
    return { deleted: id };
  }

  async syncSchedules() {
    for (const s of this.db.select().from(schema.reportSchedules).all()) await this.register(s);
  }

  private register(s: { id: string; workspaceId: string; cron: string; timezone: string; days: number; notify: boolean }) {
    return this.queue.upsertSchedule(s.id, s.cron, s.timezone, { workspaceId: s.workspaceId, days: s.days, notify: s.notify, scheduleId: s.id });
  }

  private requireQueue() {
    if (!this.queue.enabled) throw new ServiceUnavailableException("Background jobs are disabled: set REDIS_URL");
  }
}
