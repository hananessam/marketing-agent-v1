import { Body, Controller, Get, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { AnalyticsService, RunAnalyticsBody } from "./analytics.service";

@Controller("analytics")
@UseGuards(WorkspaceGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Post("run")
  run(@WorkspaceId() ws: string, @Body(new ZodValidationPipe(RunAnalyticsBody)) body: RunAnalyticsBody) {
    return this.analytics.run(ws, body);
  }

  @Get("runs")
  list(@WorkspaceId() ws: string) {
    return this.analytics.list(ws);
  }

  @Get("runs/:id")
  get(@WorkspaceId() ws: string, @Param("id") id: string) {
    const run = this.analytics.get(ws, id);
    if (!run) throw new NotFoundException();
    return run;
  }
}
