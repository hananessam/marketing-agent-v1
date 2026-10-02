import { Module } from "@nestjs/common";
import { PublishingController } from "./publishing.controller";
import { PublishingRouter } from "./publishing.router";
import { PublishingService } from "./publishing.service";
import { SandboxPublisher } from "./sandbox-publisher";
import { PUBLISHER } from "./types";

@Module({
  controllers: [PublishingController],
  providers: [PublishingService, SandboxPublisher, PublishingRouter, { provide: PUBLISHER, useExisting: PublishingRouter }],
  exports: [PUBLISHER, PublishingRouter, PublishingService],
})
export class PublishingModule {}
