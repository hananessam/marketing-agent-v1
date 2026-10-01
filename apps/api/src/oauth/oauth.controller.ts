import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { SyncService } from "../connectors/sync.service";
import { OAuthService } from "./oauth.service";

const StartBody = z.object({ connectionId: z.string().optional() });
const SelectBody = z.object({ accountId: z.string().min(1), conversionAction: z.enum(["purchase", "lead"]).optional() });

@Controller("connections/oauth")
export class OAuthController {
  constructor(private readonly oauth: OAuthService, private readonly sync: SyncService) {}

  @Get("status")
  @UseGuards(WorkspaceGuard)
  status() {
    return this.oauth.status();
  }

  /** POST (not GET): it creates server-side state and needs the workspace header. The browser then navigates to authUrl. */
  @Post(":provider/start")
  @UseGuards(WorkspaceGuard)
  start(@WorkspaceId() ws: string, @Param("provider") provider: string, @Body(new ZodValidationPipe(StartBody)) body: z.infer<typeof StartBody>) {
    return this.oauth.start(ws, provider, body.connectionId);
  }

  /** The provider redirects the user's browser here, so there is no workspace header: the signed-in workspace is recovered from the single-use state. */
  @Get(":provider/callback")
  async callback(@Param("provider") provider: string, @Query() q: { code?: string; state?: string; error?: string }, @Res() res: Response) {
    const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    const r = await this.oauth.callback(provider, q);
    const params = new URLSearchParams(r.ok ? { connected: provider, connection: r.connectionId, ...(r.pending ? { pending: "1" } : {}) } : { oauth_error: r.code });
    res.redirect(`${web}/connections?${params}`);
  }

  @Get("connections/:id/accounts")
  @UseGuards(WorkspaceGuard)
  accounts(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.oauth.accounts(ws, id);
  }

  /** Pick the account, then pull the first 30 days. */
  @Post("connections/:id/account")
  @UseGuards(WorkspaceGuard)
  async select(@WorkspaceId() ws: string, @Param("id") id: string, @Body(new ZodValidationPipe(SelectBody)) body: z.infer<typeof SelectBody>) {
    const { connectionId } = await this.oauth.selectAccount(ws, id, body.accountId, body.conversionAction);
    return { connectionId, sync: await this.sync.sync(ws, connectionId, { days: 30 }) };
  }
}
