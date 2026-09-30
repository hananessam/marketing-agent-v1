import { CampaignBrief, type CampaignPlan } from "@marketing/shared";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { checkAsset, formatViolations, type BrandRules } from "./content-policy";
import type { ContentAsset } from "./content.schema";
import { brandRules, buildCampaignGraph } from "./graph";
import { CAMPAIGN_WRITER, type BrandContext, type CampaignWriter } from "./writer";

export const GenerateBody = z.object({ brief: CampaignBrief });
export const EditAssetBody = z.object({ content: z.string().min(1) });
export const ReviewBody = z.object({ decision: z.enum(["approved", "rejected"]) });
export const DecisionBody = z.object({ decision: z.enum(["approved", "rejected"]), decidedBy: z.string().min(1) });

const norm = (s: string) => s.trim().toLowerCase();
const briefHash = (b: CampaignBrief) =>
  createHash("sha256").update(JSON.stringify({ ...b, channels: [...b.channels].sort(), constraints: [...b.constraints].sort() })).digest("hex").slice(0, 32);

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tools: ToolRunnerService,
    private readonly runs: RunsService,
    @Inject(CAMPAIGN_WRITER) private readonly writer: CampaignWriter,
  ) {}

  // ---------- generation ----------

  async generate(workspaceId: string, brief: CampaignBrief, idempotencyKey?: string) {
    const product = this.db.select().from(schema.products).where(eq(schema.products.workspaceId, workspaceId)).all()
      .find((p) => norm(p.name) === norm(brief.product) || p.id === brief.product);
    if (!product) throw new UnprocessableEntityException(`Unknown product "${brief.product}"; create it before planning a campaign`);

    const key = `campaign:${idempotencyKey ?? briefHash(brief)}`;
    const existing = this.runs.findByKey(workspaceId, key);
    if (existing) return { runId: existing.id, status: existing.status, reused: true, output: existing.output };

    let runId: string;
    try {
      runId = this.runs.start(workspaceId, "campaign_draft", { brief }, key);
    } catch {
      const raced = this.runs.findByKey(workspaceId, key)!;
      return { runId: raced.id, status: raced.status, reused: true, output: raced.output };
    }

    try {
      const graph = buildCampaignGraph({
        brief, writer: this.writer,
        loadContext: () => this.loadContext(workspaceId, runId, product.id),
      });
      const s = await graph.invoke({});

      if (s.plan && s.content && !s.planErrors.length && !s.contentErrors.length) {
        const saved = this.save(workspaceId, runId, brief, s.plan, s.content.assets);
        const output = { campaignId: saved.campaignId, approvalId: saved.approvalId };
        this.runs.finish(workspaceId, runId, "awaiting_approval", output);
        return { runId, status: "awaiting_approval" as const, reused: false, output };
      }
      const output = {
        planErrors: s.planErrors, contentErrors: s.contentErrors,
        planAttempts: s.planAttempts, contentAttempts: s.contentAttempts,
      };
      this.runs.finish(workspaceId, runId, "failed", output);
      return { runId, status: "failed" as const, reused: false, output };
    } catch (e) {
      const output = { error: e instanceof Error ? e.message : String(e) };
      this.runs.finish(workspaceId, runId, "failed", output);
      return { runId, status: "failed" as const, reused: false, output };
    }
  }

  private async loadContext(workspaceId: string, runId: string, productId: string): Promise<BrandContext> {
    const call = async <T>(name: string): Promise<T> => {
      const r = await this.tools.run(workspaceId, runId, name, {});
      if (r.status !== "ok") throw new Error(`${name} failed: ${r.error}`);
      return r.result as T;
    };
    const brand = await call<BrandContext["brand"]>("get_brand_guidelines");
    const products = await call<{ id: string; name: string; description: string }[]>("get_product_information");
    const audiences = await call<BrandContext["audiences"]>("get_audience_segments");
    return { brand, product: products.find((p) => p.id === productId)!, audiences };
  }

  private save(workspaceId: string, runId: string, brief: CampaignBrief, plan: CampaignPlan, assets: ContentAsset[]) {
    const campaignId = `c_${randomUUID().slice(0, 8)}`;
    const approvalId = randomUUID();
    const name = `${brief.product}: ${brief.objective} (${brief.channels.join(", ")})`;
    this.db.transaction((tx) => {
      tx.insert(schema.campaigns).values({ id: campaignId, workspaceId, name, channel: brief.channels.join(","), status: "draft", brief, plan }).run();
      if (assets.length)
        tx.insert(schema.campaignAssets).values(assets.map((a) => ({
          id: randomUUID(), workspaceId, campaignId, kind: a.kind, variant: `${a.channel}:${a.variant}`, content: a.content, status: "draft" as const,
        }))).run();
      if (plan.experiments.length)
        tx.insert(schema.experiments).values(plan.experiments.map((e) => ({ id: randomUUID(), workspaceId, campaignId, hypothesis: e.hypothesis, variable: e.variable }))).run();
      tx.insert(schema.approvals).values({
        id: approvalId, workspaceId, runId, action: "publish", status: "pending",
        summary: `Approve campaign "${name}" (${assets.length} draft assets). Approval does not publish anything.`,
        payload: { campaignId },
      }).run();
    });
    return { campaignId, approvalId };
  }

  // ---------- reading ----------

  list(workspaceId: string) {
    return this.db.select({ id: schema.campaigns.id, name: schema.campaigns.name, channel: schema.campaigns.channel, status: schema.campaigns.status, createdAt: schema.campaigns.createdAt })
      .from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId)).orderBy(desc(schema.campaigns.createdAt)).all();
  }

  get(workspaceId: string, campaignId: string) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    const assets = this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId))).all();
    const experiments = this.db.select().from(schema.experiments)
      .where(and(eq(schema.experiments.workspaceId, workspaceId), eq(schema.experiments.campaignId, campaignId))).all();
    return { ...campaign, assets, experiments };
  }

  // ---------- human review ----------

  editAsset(workspaceId: string, campaignId: string, assetId: string, content: string) {
    const { asset, campaign } = this.assetOrThrow(workspaceId, campaignId, assetId);
    if (campaign.status !== "draft") throw new ConflictException("Campaign is no longer a draft");
    const violations = checkAsset(this.toContentAsset(asset, content), this.loadBrand(workspaceId));
    if (violations.length) throw new UnprocessableEntityException({ message: "Edit violates brand policy", violations });
    // Any edit invalidates a previous review.
    this.db.update(schema.campaignAssets).set({ content, status: "draft" }).where(eq(schema.campaignAssets.id, assetId)).run();
    return { ...asset, content, status: "draft" as const };
  }

  reviewAsset(workspaceId: string, campaignId: string, assetId: string, decision: "approved" | "rejected") {
    const { asset, campaign } = this.assetOrThrow(workspaceId, campaignId, assetId);
    if (campaign.status !== "draft") throw new ConflictException("Campaign is no longer a draft");
    this.db.update(schema.campaignAssets).set({ status: decision }).where(eq(schema.campaignAssets.id, assetId)).run();
    return { ...asset, status: decision };
  }

  // ---------- approval inbox ----------

  listApprovals(workspaceId: string, status?: "pending" | "approved" | "rejected") {
    return this.db.select().from(schema.approvals)
      .where(status ? and(eq(schema.approvals.workspaceId, workspaceId), eq(schema.approvals.status, status)) : eq(schema.approvals.workspaceId, workspaceId))
      .orderBy(desc(schema.approvals.createdAt)).all();
  }

  decide(workspaceId: string, approvalId: string, decision: "approved" | "rejected", decidedBy: string) {
    const approval = this.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.workspaceId, workspaceId), eq(schema.approvals.id, approvalId))).get();
    if (!approval) throw new NotFoundException("Approval not found");
    if (approval.status !== "pending") throw new ConflictException(`Already ${approval.status}`);
    const campaignId = (approval.payload as { campaignId: string }).campaignId;

    if (decision === "approved") {
      const { assets } = this.get(workspaceId, campaignId);
      const pending = assets.filter((a) => a.status === "draft");
      if (pending.length) throw new ConflictException(`${pending.length} asset(s) still need review`);
      const approved = assets.filter((a) => a.status === "approved");
      if (!approved.length) throw new ConflictException("Approve at least one asset first");
      // Re-validate at the moment of approval, never trust earlier checks.
      const brand = this.loadBrand(workspaceId);
      const violations = approved.flatMap((a) => checkAsset(this.toContentAsset(a, a.content), brand));
      if (violations.length) throw new UnprocessableEntityException({ message: "Approved assets violate brand policy", violations: formatViolations(violations) });
    }

    this.db.transaction((tx) => {
      tx.update(schema.approvals).set({ status: decision, decidedBy, decidedAt: new Date().toISOString() }).where(eq(schema.approvals.id, approvalId)).run();
      if (decision === "approved") tx.update(schema.campaigns).set({ status: "approved" }).where(eq(schema.campaigns.id, campaignId)).run();
      if (approval.runId) tx.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, approval.runId)).run();
    });
    return { approvalId, campaignId, status: decision, decidedBy };
  }

  // ---------- helpers ----------

  private campaignOrThrow(workspaceId: string, campaignId: string) {
    const c = this.db.select().from(schema.campaigns)
      .where(and(eq(schema.campaigns.workspaceId, workspaceId), eq(schema.campaigns.id, campaignId))).get();
    if (!c) throw new NotFoundException("Campaign not found");
    return c;
  }

  private assetOrThrow(workspaceId: string, campaignId: string, assetId: string) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    const asset = this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId), eq(schema.campaignAssets.id, assetId))).get();
    if (!asset) throw new NotFoundException("Asset not found");
    return { campaign, asset };
  }

  private loadBrand(workspaceId: string): BrandRules {
    const b = this.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.workspaceId, workspaceId)).get();
    return brandRules(b ?? null);
  }

  /** Stored variant is "channel:label"; approved-claims citations aren't persisted, so edits are checked on text rules only. */
  private toContentAsset(a: { kind: string; variant: string }, content: string): ContentAsset {
    const [channel, variant] = a.variant.split(":");
    return { channel: channel as ContentAsset["channel"], kind: a.kind as ContentAsset["kind"], variant, content, claimsUsed: [] };
  }
}
