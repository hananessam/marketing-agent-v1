import { Module } from "@nestjs/common";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "./tool-runner.service";
import { ToolsController } from "./tools.controller";

@Module({
  controllers: [ToolsController],
  providers: [ToolRunnerService, RunsService],
  exports: [ToolRunnerService, RunsService],
})
export class ToolsModule {}
