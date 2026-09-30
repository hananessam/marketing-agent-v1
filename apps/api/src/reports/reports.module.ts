import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module";
import { BullMqQueue } from "./bullmq.queue";
import { createNotifier, NOTIFIER } from "./notifier";
import { JOB_QUEUE } from "./queue.port";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [AnalyticsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    { provide: JOB_QUEUE, useFactory: () => new BullMqQueue() },
    { provide: NOTIFIER, useFactory: () => createNotifier() },
  ],
})
export class ReportsModule {}
