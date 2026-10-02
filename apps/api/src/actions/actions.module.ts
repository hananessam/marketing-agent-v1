import { Module } from "@nestjs/common";
import { PublishingModule } from "../publishing/publishing.module";
import { ActionsController } from "./actions.controller";
import { ActionsService } from "./actions.service";

@Module({ imports: [PublishingModule], controllers: [ActionsController], providers: [ActionsService], exports: [ActionsService] })
export class ActionsModule {}
