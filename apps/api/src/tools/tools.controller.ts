import { Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "./tool-runner.service";

const CallBody = z.object({ args: z.unknown().optional() });

@Controller("tools")
@UseGuards(WorkspaceGuard)
export class ToolsController {
  constructor(private readonly tools: ToolRunnerService, private readonly runs: RunsService) {}

  @Get()
  list() {
    return this.tools.describe();
  }

  @Get("audit/calls")
  audit(@WorkspaceId() ws: string, @Query("limit") limit?: string) {
    return this.tools.recentCalls(ws, Number(limit) || 50);
  }

  @Post(":name/call")
  async call(@WorkspaceId() ws: string, @Param("name") name: string, @Body(new ZodValidationPipe(CallBody)) body: z.infer<typeof CallBody>) {
    if (!this.tools.has(name)) throw new NotFoundException(`Unknown tool: ${name}`);
    const runId = this.runs.start(ws, "manual_tool_call", { name, args: body.args });
    const res = await this.tools.run(ws, runId, name, body.args);
    this.runs.finish(ws, runId, res.status === "ok" ? "succeeded" : "failed", res);
    return { runId, ...res };
  }
}
