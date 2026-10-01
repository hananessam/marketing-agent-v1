import { Module } from "@nestjs/common";
import { AnalyticsModule } from "../analytics/analytics.module";
import { ConnectionsModule } from "../connectors/connections.module";
import { QueueModule } from "../queue/queue.module";
import { createNotifier, NOTIFIER } from "./notifier";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [AnalyticsModule, QueueModule, ConnectionsModule],
  controllers: [ReportsController],
  providers: [ReportsService, { provide: NOTIFIER, useFactory: () => createNotifier() }],
})
export class ReportsModule {}
