import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ProposeBody } from "./action-types";
import { ActionsService } from "./actions.service";

const TaskBody = z.object({ status: z.enum(["open", "done"]) });

@Controller()
@UseGuards(WorkspaceGuard)
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  /** Propose an action. Internal ones (tasks) run at once; the rest wait in the approvals inbox. */
  @Post("actions")
  propose(@WorkspaceId() ws: string, @Body(new ZodValidationPipe(ProposeBody)) body: ProposeBody) {
    return this.actions.propose(ws, body);
  }

  @Get("actions/mode")
  mode() {
    return { mode: this.actions.mode };
  }

  @Get("actions")
  list(@WorkspaceId() ws: string, @Query("status") status?: string, @Query("limit") limit?: string) {
    return this.actions.list(ws, status, Number(limit) || 100);
  }

  @Get("actions/:id")
  get(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.actions.get(ws, id);
  }

  @Get("tasks")
  tasks(@WorkspaceId() ws: string, @Query("status") status?: string) {
    return this.actions.listTasks(ws, status === "open" || status === "done" ? status : undefined);
  }

  @Patch("tasks/:id")
  setTask(@WorkspaceId() ws: string, @Param("id") id: string, @Body(new ZodValidationPipe(TaskBody)) body: z.infer<typeof TaskBody>) {
    return this.actions.setTaskStatus(ws, id, body.status);
  }
}
