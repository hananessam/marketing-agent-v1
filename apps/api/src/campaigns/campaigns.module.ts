import { Module } from "@nestjs/common";
import { ActionsModule } from "../actions/actions.module";
import { ToolsModule } from "../tools/tools.module";
import { CampaignsController } from "./campaigns.controller";
import { CampaignsService } from "./campaigns.service";
import { CAMPAIGN_WRITER, OpenAIWriter } from "./writer";

@Module({
  imports: [ToolsModule, ActionsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, { provide: CAMPAIGN_WRITER, useClass: OpenAIWriter }],
})
export class CampaignsModule {}
