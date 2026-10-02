import { Body, Controller, Get, Headers, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CampaignsService, DecisionBody, EditAssetBody, GenerateBody, RegenerateBody, ReviewBody } from "./campaigns.service";

@Controller()
@UseGuards(WorkspaceGuard)
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Post("campaigns/generate")
  generate(@WorkspaceId() ws: string, @Headers("idempotency-key") key: string | undefined, @Body(new ZodValidationPipe(GenerateBody)) body: z.infer<typeof GenerateBody>) {
    return this.campaigns.generate(ws, body.brief, key);
  }

  @Get("campaigns")
  list(@WorkspaceId() ws: string) {
    return this.campaigns.list(ws);
  }

  @Get("campaigns/:id")
  get(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.campaigns.get(ws, id);
  }

  /** Rewrite all the copy of a draft with the AI (optionally with a note on what to change). Slow: waits for the model. */
  @Post("campaigns/:id/regenerate-content")
  regenerate(@WorkspaceId() ws: string, @Param("id") id: string, @Body(new ZodValidationPipe(RegenerateBody)) body: z.infer<typeof RegenerateBody>) {
    return this.campaigns.regenerateContent(ws, id, body.guidance);
  }

  @Get("campaigns/:id/performance")
  performance(@WorkspaceId() ws: string, @Param("id") id: string, @Query("days") days?: string) {
    const n = Math.min(Math.max(Number(days) || 14, 3), 90);
    return this.campaigns.performance(ws, id, n);
  }

  @Patch("campaigns/:id/assets/:assetId")
  edit(@WorkspaceId() ws: string, @Param("id") id: string, @Param("assetId") assetId: string, @Body(new ZodValidationPipe(EditAssetBody)) body: z.infer<typeof EditAssetBody>) {
    return this.campaigns.editAsset(ws, id, assetId, body.content);
  }

  @Post("campaigns/:id/assets/:assetId/review")
  review(@WorkspaceId() ws: string, @Param("id") id: string, @Param("assetId") assetId: string, @Body(new ZodValidationPipe(ReviewBody)) body: z.infer<typeof ReviewBody>) {
    return this.campaigns.reviewAsset(ws, id, assetId, body.decision);
  }

  /** After a rejection: ask again once the copy has been edited. */
  @Post("campaigns/:id/request-approval")
  requestApproval(@WorkspaceId() ws: string, @Param("id") id: string) {
    return this.campaigns.requestApproval(ws, id);
  }

  @Get("approvals")
  approvals(@WorkspaceId() ws: string, @Query("status") status?: "pending" | "approved" | "rejected") {
    return this.campaigns.listApprovals(ws, status);
  }

  @Post("approvals/:id/decision")
  decide(@WorkspaceId() ws: string, @Param("id") id: string, @Body(new ZodValidationPipe(DecisionBody)) body: z.infer<typeof DecisionBody>) {
    return this.campaigns.decideApproval(ws, id, body.decision, body.decidedBy, body.note);
  }
}
