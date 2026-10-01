import { Module } from "@nestjs/common";
import { BullMqQueue } from "./bullmq.queue";
import { JOB_QUEUE } from "./queue.port";

/** The single queue (and worker) shared by report jobs and connector-sync jobs. */
@Module({
  providers: [{ provide: JOB_QUEUE, useFactory: () => new BullMqQueue() }],
  exports: [JOB_QUEUE],
})
export class QueueModule {}
