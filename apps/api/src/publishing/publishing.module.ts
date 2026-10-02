import { Module } from "@nestjs/common";
import { PublishingController } from "./publishing.controller";
import { PublishingService } from "./publishing.service";
import { PUBLISHER } from "./types";

@Module({
  controllers: [PublishingController],
  providers: [PublishingService, { provide: PUBLISHER, useExisting: PublishingService }],
  exports: [PUBLISHER, PublishingService],
})
export class PublishingModule {}
