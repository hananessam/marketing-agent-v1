export type ReportJobData = {
  workspaceId: string;
  days: number;
  /** Omitted for scheduled jobs: the service resolves "last complete day" at run time. */
  endDate?: string;
  notify: boolean;
  scheduleId?: string;
};

export type JobInfo = { state: string; attemptsMade: number; failedReason?: string };

/** Thin port over the queue backend so the logic is testable without Redis. */
export interface JobQueue {
  readonly enabled: boolean;
  start(handler: (data: ReportJobData) => Promise<void>): void;
  /** A second enqueue with the same jobId is ignored while the first still exists. */
  enqueue(data: ReportJobData, jobId: string): Promise<{ jobId: string; deduped: boolean }>;
  upsertSchedule(scheduleId: string, cron: string, timezone: string, data: ReportJobData): Promise<void>;
  removeSchedule(scheduleId: string): Promise<void>;
  /** Ids (as passed to upsertSchedule) of every schedule currently registered in the backend. */
  listScheduleIds(): Promise<string[]>;
  jobInfo(jobId: string): Promise<JobInfo | null>;
}
export const JOB_QUEUE = Symbol("JOB_QUEUE");
