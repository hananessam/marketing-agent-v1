import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health.controller";
import { ActionsModule } from "./actions/actions.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { CampaignsModule } from "./campaigns/campaigns.module";
import { ConnectionsModule } from "./connectors/connections.module";
import { ReportsModule } from "./reports/reports.module";
import { ToolsModule } from "./tools/tools.module";

@Module({ imports: [DatabaseModule, ActionsModule, ToolsModule, AnalyticsModule, CampaignsModule, ReportsModule, ConnectionsModule], controllers: [HealthController] })
export class AppModule {}
