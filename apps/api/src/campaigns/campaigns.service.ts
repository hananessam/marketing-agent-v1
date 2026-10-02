import { aggregate, calculateMetrics, CampaignBrief, type CampaignPlan } from "@marketing/shared";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, max, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { schema, type Db } from "../db";
import { ActionsService } from "../actions/actions.service";
import { DB } from "../db/database.module";
import { RunsService } from "../runs/runs.service";
import { ToolRunnerService } from "../tools/tool-runner.service";
import { checkAsset, formatViolations, isSoftViolation, maxLength, type BrandRules } from "./content-policy";
import type { ContentAsset } from "./content.schema";
import { brandRules, buildCampaignGraph } from "./graph";
import { CAMPAIGN_WRITER, type BrandContext, type CampaignWriter } from "./writer";

export const GenerateBody = z.object({ brief: CampaignBrief });
export const EditAssetBody = z.object({ content: z.string().min(1) });
export const RegenerateBody = z.object({ guidance: z.string().trim().max(300).optional() });
export const ReviewBody = z.object({ decision: z.enum(["approved", "rejected"]) });
export const DecisionBody = z.object({ decision: z.enum(["approved", "rejected"]), decidedBy: z.string().min(1), note: z.string().trim().max(500).optional() });

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
    private readonly actions: ActionsService,
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

      // Only fit problems (such as a headline a few characters too long) are left: keep the draft and let a person fix them.
      const onlyFitProblems = s.contentViolations.every(isSoftViolation);
      if (s.plan && s.content && !s.planErrors.length && onlyFitProblems) {
        const saved = this.save(workspaceId, runId, brief, s.plan, s.content.assets);
        const output = { campaignId: saved.campaignId, approvalId: saved.approvalId, ...(s.contentViolations.length ? { needsFixes: s.contentErrors } : {}), ...(s.shortened.length ? { shortened: s.shortened } : {}) };
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

  /** Copy being rewritten right now, so a double click cannot start two rewrites of one campaign. */
  private readonly rewriting = new Set<string>();

  /**
   * Rewrites all the copy of a draft with the AI, keeping the plan. It goes through the same brand checks and length
   * repair as the first draft, and the current copy is only replaced when the new copy passes them.
   */
  async regenerateContent(workspaceId: string, campaignId: string, guidance?: string) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    const brief = campaign.brief as CampaignBrief | null;
    const plan = campaign.plan as CampaignPlan | null;
    if (!brief || !plan) throw new UnprocessableEntityException("Only campaigns created here can have their copy rewritten.");
    if (campaign.status !== "draft") throw new ConflictException("Only a draft can be rewritten. Approved copy stays as it is.");
    if (this.rewriting.has(campaignId)) throw new ConflictException("The copy of this campaign is already being rewritten.");
    const product = this.db.select().from(schema.products).where(eq(schema.products.workspaceId, workspaceId)).all()
      .find((p) => norm(p.name) === norm(brief.product) || p.id === brief.product);
    if (!product) throw new UnprocessableEntityException(`The product "${brief.product}" no longer exists, so the copy cannot be rewritten.`);

    this.rewriting.add(campaignId);
    const runId = this.runs.start(workspaceId, "campaign_rewrite", { campaignId, guidance: guidance ?? null }, `rewrite:${campaignId}:${randomUUID()}`);
    try {
      const previous = this.db.select({ c: schema.campaignAssets.content }).from(schema.campaignAssets)
        .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId))).all().map((a) => a.c);
      const graph = buildCampaignGraph({
        brief, writer: this.writer, plan, guidance: guidance || undefined, previous,
        loadContext: () => this.loadContext(workspaceId, runId, product.id),
      });
      const s = await graph.invoke({});
      if (!s.content || !s.contentViolations.every(isSoftViolation)) {
        const errors = s.contentErrors.length ? s.contentErrors : ["no copy was produced"];
        this.runs.finish(workspaceId, runId, "failed", { contentErrors: errors, contentAttempts: s.contentAttempts });
        throw new UnprocessableEntityException({ message: "The AI could not write copy that follows your brand rules, so your current copy was kept. Try again, or change the request.", violations: errors });
      }
      const assets = s.content.assets;
      this.db.transaction((tx) => {
        tx.delete(schema.campaignAssets).where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId))).run();
        if (assets.length)
          tx.insert(schema.campaignAssets).values(assets.map((a) => ({
            id: randomUUID(), workspaceId, campaignId, kind: a.kind, variant: `${a.channel}:${a.variant}`, content: a.content, status: "draft" as const,
          }))).run();
        // The waiting approval request quotes how many pieces there are.
        const open = this.approvalsFor(workspaceId, campaignId).find((a) => a.status === "pending");
        if (open) tx.update(schema.approvals).set({ summary: `Approve campaign "${campaign.name}" (${assets.length} draft assets). Approval does not publish anything.` }).where(eq(schema.approvals.id, open.id)).run();
      });
      this.runs.finish(workspaceId, runId, "succeeded", { assets: assets.length, ...(s.shortened.length ? { shortened: s.shortened } : {}) });
      return this.get(workspaceId, campaignId);
    } catch (e) {
      if (!(e instanceof UnprocessableEntityException)) this.runs.finish(workspaceId, runId, "failed", { error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      this.rewriting.delete(campaignId);
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
    return this.db.select({ id: schema.campaigns.id, name: schema.campaigns.name, channel: schema.campaigns.channel, status: schema.campaigns.status, source: schema.campaigns.source, createdAt: schema.campaigns.createdAt })
      .from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId)).orderBy(desc(schema.campaigns.createdAt)).all();
  }

  get(workspaceId: string, campaignId: string) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    const assets = this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId))).all();
    const experiments = this.db.select().from(schema.experiments)
      .where(and(eq(schema.experiments.workspaceId, workspaceId), eq(schema.experiments.campaignId, campaignId))).all();
    // Problems are recomputed on every read, so they always reflect the current copy and brand rules.
    const brand = this.loadBrand(workspaceId);
    const withIssues = assets.map((a) => {
      const ca = this.toContentAsset(a, a.content);
      return { ...a, maxLength: maxLength(ca.channel, ca.kind) ?? null, issues: checkAsset(ca, brand).map((v) => `${v.rule}: ${v.detail}`) };
    });
    const latest = this.approvalsFor(workspaceId, campaignId)[0];
    const approval = latest ? { id: latest.id, status: latest.status, decidedBy: latest.decidedBy, decidedAt: latest.decidedAt, note: (latest.payload as { note?: string }).note ?? null, createdAt: latest.createdAt } : null;
    return { ...campaign, assets: withIssues, experiments, approval, publish: this.actions.latestPublish(workspaceId, campaignId) };
  }

  /**
   * Daily numbers for one campaign: the last `days` days that have data, and the same number of days before
   * them for comparison. Anchored on the latest day we actually hold, so a stale feed still shows something.
   */
  performance(workspaceId: string, campaignId: string, days = 14) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    const m = schema.campaignMetrics;
    const where = (from?: string, to?: string) => and(
      eq(m.workspaceId, workspaceId), eq(m.campaignId, campaignId), ...(from ? [gte(m.date, from)] : []), ...(to ? [lte(m.date, to)] : []));

    const latest = this.db.select({ d: max(m.date) }).from(m).where(where()).get()?.d ?? null;
    const empty = { campaign: { id: campaign.id, name: campaign.name, channel: campaign.channel, status: campaign.status, source: campaign.source }, days, latestDate: latest, range: null, previousRange: null, daily: [], totals: null, previousTotals: null };
    if (!latest) return empty;

    const shift = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
    const range = { startDate: shift(latest, -(days - 1)), endDate: latest };
    const previousRange = { startDate: shift(latest, -(2 * days - 1)), endDate: shift(latest, -days) };
    const pick = (r: { startDate: string; endDate: string }) =>
      this.db.select().from(m).where(where(r.startDate, r.endDate)).orderBy(asc(m.date)).all();
    const current = pick(range);
    const previous = pick(previousRange);
    const summarize = (rows: typeof current) => { const t = aggregate(rows); return { ...t, ...calculateMetrics(t), daysWithData: rows.length }; };

    return {
      ...empty, range, previousRange,
      daily: current.map((r) => ({ date: r.date, impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions, revenue: r.revenue })),
      totals: summarize(current),
      previousTotals: previous.length ? summarize(previous) : null,
    };
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
    if (decision === "approved") {
      const violations = checkAsset(this.toContentAsset(asset, asset.content), this.loadBrand(workspaceId));
      if (violations.length) throw new UnprocessableEntityException({ message: "This copy needs a fix before it can be approved", violations });
    }
    this.db.update(schema.campaignAssets).set({ status: decision }).where(eq(schema.campaignAssets.id, assetId)).run();
    return { ...asset, status: decision };
  }

  // ---------- approval inbox ----------

  listApprovals(workspaceId: string, status?: "pending" | "approved" | "rejected") {
    return this.db.select().from(schema.approvals)
      .where(status ? and(eq(schema.approvals.workspaceId, workspaceId), eq(schema.approvals.status, status)) : eq(schema.approvals.workspaceId, workspaceId))
      .orderBy(desc(schema.approvals.createdAt), desc(sql`rowid`)).all();
  }

  decide(workspaceId: string, approvalId: string, decision: "approved" | "rejected", decidedBy: string, note?: string) {
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
      // The reason lives in the existing JSON payload, so no schema change is needed.
      tx.update(schema.approvals).set({ status: decision, decidedBy, decidedAt: new Date().toISOString(), payload: { ...(approval.payload as object), ...(note ? { note } : {}) } })
        .where(eq(schema.approvals.id, approvalId)).run();
      if (decision === "approved") tx.update(schema.campaigns).set({ status: "approved" }).where(eq(schema.campaigns.id, campaignId)).run();
      if (approval.runId) tx.update(schema.agentRuns).set({ status: "succeeded" }).where(eq(schema.agentRuns.id, approval.runId)).run();
    });
    return { approvalId, campaignId, status: decision, decidedBy };
  }

  /**
   * The approvals inbox holds two kinds of request: campaign sign-offs and agent actions (pause, budget, publish...).
   * Actions are decided and executed by the actions service; campaigns by `decide` above.
   */
  async decideApproval(workspaceId: string, approvalId: string, decision: "approved" | "rejected", decidedBy: string, note?: string) {
    const approval = this.db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.workspaceId, workspaceId), eq(schema.approvals.id, approvalId))).get();
    if (!approval) throw new NotFoundException("Approval not found");
    if ((approval.payload as { actionId?: string } | null)?.actionId) return this.actions.decideForApproval(workspaceId, approval, decision, decidedBy, note);
    return this.decide(workspaceId, approvalId, decision, decidedBy, note);
  }

  /**
   * After a rejection (or any time no request is open) ask again. The campaign stays editable while it is a draft, so the
   * usual loop is: rejected -> edit the copy -> request approval again.
   */
  requestApproval(workspaceId: string, campaignId: string) {
    const campaign = this.campaignOrThrow(workspaceId, campaignId);
    if (campaign.status !== "draft") throw new ConflictException("Only drafts can be sent for approval");
    const history = this.approvalsFor(workspaceId, campaignId);
    if (history.some((a) => a.status === "pending")) throw new ConflictException("An approval request is already waiting");
    const assets = this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId))).all();
    if (!assets.length) throw new ConflictException("There is no copy to approve");

    const id = randomUUID();
    this.db.insert(schema.approvals).values({
      id, workspaceId, runId: history[0]?.runId ?? null, action: "publish", status: "pending",
      summary: `Approve campaign "${campaign.name}" (${assets.length} assets, sent again). Approval does not publish anything.`,
      payload: { campaignId, resubmittedFrom: history[0]?.id ?? null },
    }).run();
    return { approvalId: id, campaignId };
  }

  /** Newest first. Timestamps only have millisecond precision, so rowid (insertion order) breaks ties deterministically. */
  private approvalsFor(workspaceId: string, campaignId: string) {
    return this.db.select().from(schema.approvals).where(eq(schema.approvals.workspaceId, workspaceId)).orderBy(desc(schema.approvals.createdAt), desc(sql`rowid`)).all()
      .filter((a) => (a.payload as { campaignId?: string } | null)?.campaignId === campaignId);
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
