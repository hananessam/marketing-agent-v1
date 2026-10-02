import { Module } from "@nestjs/common";
import { ProgressService } from "../runs/progress.service";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "./tool-runner.service";
import { ToolsController } from "./tools.controller";

@Module({
  controllers: [ToolsController],
  providers: [ToolRunnerService, RunsService, ProgressService],
  exports: [ToolRunnerService, RunsService, ProgressService],
})
export class ToolsModule {}
