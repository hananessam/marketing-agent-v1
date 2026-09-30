import { Logger, type OnModuleDestroy } from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import type { JobInfo, JobQueue, ReportJobData } from "./queue.port";

const QUEUE_NAME = "analytics-reports";
const JOB_NAME = "analytics-report";

export class BullMqQueue implements JobQueue, OnModuleDestroy {
  private readonly log = new Logger("BullMqQueue");
  private readonly connection?: IORedis;
  private readonly queue?: Queue<ReportJobData>;
  private worker?: Worker<ReportJobData>;
  readonly enabled: boolean;

  constructor(redisUrl = process.env.REDIS_URL) {
    this.enabled = Boolean(redisUrl);
    if (!redisUrl) {
      this.log.warn("REDIS_URL is not set: background jobs and schedules are disabled");
      return;
    }
    // BullMQ requires maxRetriesPerRequest: null for blocking worker connections.
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", (e) => this.log.error(`Redis: ${e.message}`));
    this.queue = new Queue<ReportJobData>(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { age: 7 * 86_400, count: 1000 },
        removeOnFail: { age: 30 * 86_400 },
      },
    });
  }

  start(handler: (data: ReportJobData) => Promise<void>) {
    if (!this.connection || this.worker) return;
    // Low concurrency: each job makes an LLM call and we want to respect rate limits.
    this.worker = new Worker<ReportJobData>(QUEUE_NAME, (job) => handler(job.data), { connection: this.connection, concurrency: 2 });
    this.worker.on("failed", (job, err) => this.log.warn(`job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
    this.worker.on("error", (err) => this.log.error(err.message));
  }

  async enqueue(data: ReportJobData, jobId: string) {
    const q = this.requireQueue();
    const existing = await q.getJob(jobId);
    if (existing) return { jobId, deduped: true };
    await q.add(JOB_NAME, data, { jobId });
    return { jobId, deduped: false };
  }

  async upsertSchedule(scheduleId: string, cron: string, timezone: string, data: ReportJobData) {
    // Deterministic scheduler id: re-registering on every boot never duplicates the schedule.
    await this.requireQueue().upsertJobScheduler(`schedule_${scheduleId}`, { pattern: cron, tz: timezone }, { name: JOB_NAME, data });
  }

  async removeSchedule(scheduleId: string) {
    await this.requireQueue().removeJobScheduler(`schedule_${scheduleId}`);
  }

  async jobInfo(jobId: string): Promise<JobInfo | null> {
    const job = await this.requireQueue().getJob(jobId);
    if (!job) return null;
    return { state: await job.getState(), attemptsMade: job.attemptsMade, failedReason: job.failedReason || undefined };
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }

  private requireQueue() {
    if (!this.queue) throw new Error("Queue is disabled");
    return this.queue;
  }
}
