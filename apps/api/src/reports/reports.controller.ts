import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { EnqueueBody, ReportsService, ScheduleBody } from "./reports.service";

@Controller("reports")
@UseGuards(WorkspaceGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post("enqueue")
  @HttpCode(202)
  enqueue(@WorkspaceId() ws: string, @Body(new ZodValidationPipe(EnqueueBody)) body: z.infer<typeof EnqueueBody>) {
    return this.reports.enqueue(ws, body);
  }

  @Get("jobs/:id")
  job(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.reports.job(ws, id);
  }

  @Get("schedules")
  list(@WorkspaceId() ws: string) {
    return this.reports.listSchedules(ws);
  }

  @Post("schedules")
  create(@WorkspaceId() ws: string, @Body(new ZodValidationPipe(ScheduleBody)) body: z.infer<typeof ScheduleBody>) {
    return this.reports.createSchedule(ws, body);
  }

  @Delete("schedules/:id")
  remove(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.reports.deleteSchedule(ws, id);
  }
}
