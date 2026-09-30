import { Module } from "@nestjs/common";
import { ToolsModule } from "../tools/tools.module";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { OpenAIRecommender, RECOMMENDER } from "./recommender";

@Module({
  imports: [ToolsModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, { provide: RECOMMENDER, useClass: OpenAIRecommender }],
})
export class AnalyticsModule {}
