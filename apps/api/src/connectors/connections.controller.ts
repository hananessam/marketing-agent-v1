import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { ConnectionsService } from "./connections.service";
import { SyncService } from "./sync.service";

const SyncBody = z.object({ days: z.number().int().min(1).max(90).default(7) });

// Credentials are never accepted over HTTP: accounts are linked through the OAuth flow in ../oauth.
@Controller("connections")
@UseGuards(WorkspaceGuard)
export class ConnectionsController {
  constructor(private readonly connections: ConnectionsService, private readonly sync: SyncService) {}

  @Get()
  list(@WorkspaceId() ws: string) {
    return this.connections.list(ws);
  }

  @Post(":id/sync")
  run(@WorkspaceId() ws: string, @Param("id") id: string, @Body(new ZodValidationPipe(SyncBody)) body: z.infer<typeof SyncBody>) {
    return this.sync.sync(ws, id, { days: body.days });
  }

  /** Removes demo-seed campaigns and their metrics (never connector or manual data). */
  @Post("demo-data/purge")
  purgeDemo(@WorkspaceId() ws: string) {
    return { removed: this.sync.purgeSeedData(ws) };
  }

  @Delete(":id")
  remove(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.connections.remove(ws, id);
  }
}
