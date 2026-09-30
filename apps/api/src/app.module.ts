import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health.controller";
import { AnalyticsModule } from "./analytics/analytics.module";
import { ToolsModule } from "./tools/tools.module";

@Module({ imports: [DatabaseModule, ToolsModule, AnalyticsModule], controllers: [HealthController] })
export class AppModule {}
