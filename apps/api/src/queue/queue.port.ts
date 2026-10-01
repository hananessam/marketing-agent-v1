export type ReportJobData = {
  workspaceId: string;
  days: number;
  /** Omitted for scheduled jobs: the service resolves "last complete day" at run time. */
  endDate?: string;
  notify: boolean;
  scheduleId?: string;
};

/** Pulls fresh metrics for one connection. */
export type SyncJobData = { kind: "sync"; workspaceId: string; connectionId: string; days: number };
/** Report jobs predate `kind`, so a missing kind means "report". */
export type JobData = ReportJobData | SyncJobData;
export const isSyncJob = (d: JobData): d is SyncJobData => (d as SyncJobData).kind === "sync";

export type JobInfo = { state: string; attemptsMade: number; failedReason?: string };

/** Thin port over the queue backend so the logic is testable without Redis. */
export interface JobQueue {
  readonly enabled: boolean;
  start(handler: (data: JobData) => Promise<void>): void;
  /** A second enqueue with the same jobId is ignored while the first still exists. */
  enqueue(data: JobData, jobId: string): Promise<{ jobId: string; deduped: boolean }>;
  /** `schedulerId` is the caller's full id (e.g. "schedule_<id>", "sync_<id>"); upserting the same id never duplicates. */
  upsertSchedule(schedulerId: string, cron: string, timezone: string, data: JobData): Promise<void>;
  removeSchedule(schedulerId: string): Promise<void>;
  /** Every scheduler id currently registered, whoever created it. Callers only touch ids with their own prefix. */
  listScheduleIds(): Promise<string[]>;
  jobInfo(jobId: string): Promise<JobInfo | null>;
}
export const JOB_QUEUE = Symbol("JOB_QUEUE");
