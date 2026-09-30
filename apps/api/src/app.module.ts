import { Module } from "@nestjs/common";
import { DatabaseModule } from "./db/database.module";
import { HealthController } from "./health.controller";
import { ToolsModule } from "./tools/tools.module";

@Module({ imports: [DatabaseModule, ToolsModule], controllers: [HealthController] })
export class AppModule {}
