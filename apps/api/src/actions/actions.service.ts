import { decide, MAX_BUDGET_CHANGE_PERCENT } from "@marketing/shared";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { executionMode, type ExecutionMode } from "../publishing/mode";
import { PUBLISHER, type ActionRow, type Outcome, type Publisher } from "../publishing/types";
import { IS_EXTERNAL, PAYLOADS, POLICY_FOR, type ActionKind, type ProposeBody } from "./action-types";

type Preview = ActionRow["preview"];

const PLATFORM: Record<string, string> = { meta_ads: "Meta Ads", ga4: "Google Analytics", seed: "sample data", manual: "this app only" };
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * Real implementations for external actions go here, one per action type. Until one exists the action is recorded in
 * shadow mode: approved, but nothing outside this app is touched. (Needs write permission on the ad platform first.)
 */
const LIVE_EXECUTORS: Partial<Record<ActionKind, (action: ActionRow) => Promise<Outcome>>> = {};

@Injectable()
export class ActionsService {
  private readonly log = new Logger(ActionsService.name);
  constructor(@Inject(DB) private readonly db: Db, @Optional() @Inject(PUBLISHER) private readonly publisher?: Publisher) {}

  /** Demo (the ads sandbox) by default; "live" posts to the real platforms; "shadow" only records. */
  get mode(): ExecutionMode {
    return executionMode();
  }

  /** Whether publishing really goes somewhere: the sandbox in demo mode, the real platforms in live mode. */
  private get posts() {
    return this.mode !== "shadow" && Boolean(this.publisher);
  }

  // ------------------------------------------------------------------ propose

  async propose(workspaceId: string, input: ProposeBody) {
    // The HTTP layer validates this too; the service does not rely on it.
    if (!Object.hasOwn(PAYLOADS, input.type)) throw new BadRequestException(`Unknown action type "${String(input.type)}"`);
    const payloadSchema = PAYLOADS[input.type];
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) throw new BadRequestException({ message: "Invalid action details", issues: parsed.error.issues });
    const payload = parsed.data as Record<string, unknown>;

    const policy = decide(POLICY_FOR[input.type]);
    if (policy === "never") throw new ForbiddenException("This kind of action is never allowed");

    const preview = this.buildPreview(workspaceId, input.type, payload);
    // Publishing has one real-world effect however it was asked for, so who asked (or from where) must not make a "new" request.
    const origin = input.type === "publish_campaign" ? { source: "any", sourceRef: null } : { source: input.source, sourceRef: input.sourceRef ?? null };
    const key = createHash("sha256").update(canonical({ type: input.type, payload, ...origin })).digest("hex");
    const existing = this.db.select().from(schema.actions).where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.idempotencyKey, key))).get();
    if (existing) return { action: existing, reused: true };

    const id = randomUUID();
    const base = { id, workspaceId, type: input.type, payload, preview, source: input.source, sourceRef: input.sourceRef ?? null, requestedBy: input.requestedBy, idempotencyKey: key };
    try {
      if (policy === "auto") {
        this.db.insert(schema.actions).values({ ...base, status: "executing" }).run();
      } else {
        const approvalId = randomUUID();
        this.db.transaction((tx) => {
          tx.insert(schema.actions).values({ ...base, status: "awaiting_approval", approvalId }).run();
          tx.insert(schema.approvals).values({
            id: approvalId, workspaceId, runId: null, action: POLICY_FOR[input.type], status: "pending",
            summary: `${preview.summary}${IS_EXTERNAL[input.type] ? this.shadowNote() : ""}`, payload: { actionId: id },
          }).run();
        });
      }
    } catch (e) {
      // Lost a race with an identical proposal.
      const raced = this.db.select().from(schema.actions).where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.idempotencyKey, key))).get();
      if (raced) return { action: raced, reused: true };
      throw e;
    }
    if (policy === "auto") await this.run(workspaceId, id);
    return { action: this.getOrThrow(workspaceId, id), reused: false };
  }

  private shadowNote() {
    if (this.mode === "demo") return " (demo mode: nothing real will change)";
    return this.mode === "shadow" ? " (shadow mode: nothing outside this app will change)" : "";
  }

  // ------------------------------------------------------------------ approval hook

  /** Called by the approvals inbox for approvals that belong to an action. */
  async decideForApproval(workspaceId: string, approval: typeof schema.approvals.$inferSelect, decision: "approved" | "rejected", decidedBy: string, note?: string) {
    const action = this.db.select().from(schema.actions).where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.approvalId, approval.id))).get();
    if (!action || action.status !== "awaiting_approval") throw new ConflictException("This action is no longer waiting for approval");

    this.db.transaction((tx) => {
      tx.update(schema.approvals).set({
        status: decision, decidedBy, decidedAt: new Date().toISOString(),
        payload: { ...(approval.payload as object), ...(note ? { note } : {}) },
      }).where(eq(schema.approvals.id, approval.id)).run();
      // Rejected proposals release their key so the same idea can be proposed again later.
      if (decision === "rejected") tx.update(schema.actions).set({ status: "rejected", idempotencyKey: null }).where(eq(schema.actions.id, action.id)).run();
    });
    if (decision === "approved") await this.run(workspaceId, action.id, "awaiting_approval");
    return { approvalId: approval.id, actionId: action.id, status: decision, decidedBy, action: this.getOrThrow(workspaceId, action.id) };
  }

  // ------------------------------------------------------------------ execution

  /** Claims the action (so it can never run twice), re-checks it against current data, then performs or records it. */
  private async run(workspaceId: string, actionId: string, from: "executing" | "awaiting_approval" = "executing") {
    if (from === "awaiting_approval") {
      const claimed = this.db.update(schema.actions).set({ status: "executing" })
        .where(and(eq(schema.actions.id, actionId), eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.status, "awaiting_approval"))).run();
      if (claimed.changes !== 1) throw new ConflictException("This action was already handled");
    }
    const action = this.getOrThrow(workspaceId, actionId);
    try {
      // Never trust the proposal-time checks: the campaign may have changed or disappeared since.
      this.buildPreview(workspaceId, action.type, action.payload);
      const out = await this.execute(action);
      this.db.update(schema.actions).set({ status: out.status, result: out.result, executedAt: new Date().toISOString() }).where(eq(schema.actions.id, actionId)).run();
    } catch (e) {
      const error = e instanceof Error ? e.message : "Unexpected error";
      this.log.warn(`action ${actionId} failed: ${error}`);
      this.db.update(schema.actions).set({ status: "failed", result: { error }, idempotencyKey: null, executedAt: new Date().toISOString() }).where(eq(schema.actions.id, actionId)).run();
    }
  }

  private async execute(action: ActionRow): Promise<Outcome> {
    if (action.type === "create_task") {
      const p = PAYLOADS.create_task.parse(action.payload);
      const taskId = randomUUID();
      this.db.insert(schema.tasks).values({ id: taskId, workspaceId: action.workspaceId, title: p.title, description: p.description, campaignId: p.campaignId ?? null, actionId: action.id }).run();
      return { status: "executed", result: { taskId } };
    }
    // Publishing a campaign really posts (paused ads on Meta) only when live mode is on and a publisher is wired in.
    if (action.type === "publish_campaign" && this.posts) return this.publisher!.publish(action);
    const live = LIVE_EXECUTORS[action.type];
    if (this.mode === "live" && live) return live(action);
    return {
      status: "shadowed",
      result: {
        mode: "shadow", wouldDo: action.preview.summary,
        why: this.mode === "live" ? "No live connection exists for this kind of action yet." : this.mode === "demo" ? "Demo mode is on." : "Shadow mode is on.",
        note: "Nothing outside this app was changed.",
      },
    };
  }

  // ------------------------------------------------------------------ previews and validation

  private campaign(workspaceId: string, id: string) {
    const c = this.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, workspaceId), eq(schema.campaigns.id, id))).get();
    if (!c) throw new NotFoundException("Campaign not found");
    return c;
  }

  private approvedAssets(workspaceId: string, campaignId: string) {
    return this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId), eq(schema.campaignAssets.status, "approved"))).all();
  }

  /** What would happen, plus the checks that make the action allowed at all. Throws if it is not. */
  buildPreview(workspaceId: string, type: ActionKind, payload: Record<string, unknown>): Preview {
    switch (type) {
      case "create_task": {
        const p = PAYLOADS.create_task.parse(payload);
        const c = p.campaignId ? this.campaign(workspaceId, p.campaignId) : null;
        return { summary: `Add task: ${p.title}`, details: { description: p.description, campaign: c?.name ?? null } };
      }
      case "pause_campaign": {
        const p = PAYLOADS.pause_campaign.parse(payload);
        const c = this.campaign(workspaceId, p.campaignId);
        if (c.source === "ga4") throw new UnprocessableEntityException("Google Analytics campaigns only report website visits, so there is nothing to pause.");
        if (c.status === "paused") throw new ConflictException("This campaign is already paused");
        return { summary: `Pause "${c.name}" (${PLATFORM[c.source]})`, details: { campaign: c.name, channel: c.channel, currentStatus: c.status, platform: PLATFORM[c.source], reason: p.reason } };
      }
      case "change_budget": {
        const p = PAYLOADS.change_budget.parse(payload);
        const c = this.campaign(workspaceId, p.campaignId);
        if (p.percent > MAX_BUDGET_CHANGE_PERCENT) throw new UnprocessableEntityException(`Budget changes are limited to ${MAX_BUDGET_CHANGE_PERCENT}% at a time (you asked for ${p.percent}%).`);
        if (c.source === "ga4") throw new UnprocessableEntityException("Google Analytics campaigns have no budget to change.");
        return {
          summary: `${p.direction === "increase" ? "Increase" : "Decrease"} the budget of "${c.name}" by ${p.percent}% (${PLATFORM[c.source]})`,
          details: { campaign: c.name, platform: PLATFORM[c.source], direction: p.direction, percent: p.percent, reason: p.reason, note: "The current budget is not stored here, so the change is a percentage." },
        };
      }
      case "publish_campaign": {
        const p = PAYLOADS.publish_campaign.parse(payload);
        const c = this.campaign(workspaceId, p.campaignId);
        if (c.status !== "approved") throw new ConflictException("Only approved campaigns can be published");
        const assets = this.approvedAssets(workspaceId, c.id);
        if (!assets.length) throw new UnprocessableEntityException("This campaign has no approved copy");
        const byChannel = new Map<string, { kind: string; variant: string; content: string }[]>();
        for (const a of assets) {
          const [channel, variant] = a.variant.split(":");
          byChannel.set(channel, [...(byChannel.get(channel) ?? []), { kind: a.kind, variant, content: a.content }]);
        }
        // Budget cap, landing page and permission checks live with the publisher (and run again when the action executes).
        this.publisher?.preflight(workspaceId, c.id, p.meta);
        // A campaign already created on Meta is not created again: a second post would duplicate the ads (and the spend once switched on).
        if (this.posts && p.meta && this.postedToMeta(workspaceId, c.id)) {
          throw new ConflictException("This campaign has already been posted to Meta (paused). Manage it in Ads Manager.");
        }
        const posting = p.meta && byChannel.has("meta_ads") && this.posts
          ? ` · Meta: ${p.meta.dailyBudget} per day in ${p.meta.country}, created PAUSED${this.mode === "demo" ? " (demo sandbox)" : ""}` : "";
        return {
          summary: `Publish "${c.name}": ${assets.length} pieces of approved copy on ${[...byChannel.keys()].join(", ")}${posting}`,
          details: { campaign: c.name, channels: [...byChannel].map(([channel, items]) => ({ channel, items })), ...(p.meta ? { meta: p.meta } : {}) },
        };
      }
    }
  }

  // ------------------------------------------------------------------ reading

  private postedToMeta(workspaceId: string, campaignId: string): boolean {
    return this.db.select().from(schema.actions)
      .where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.type, "publish_campaign"), eq(schema.actions.status, "executed"))).all()
      .some((a) => (a.payload as { campaignId?: string }).campaignId === campaignId
        && (a.result as { platforms?: { meta_ads?: { outcome?: string } } } | null)?.platforms?.meta_ads?.outcome === "created_paused");
  }

  /** The newest publish request for a campaign, for the campaign page. */
  latestPublish(workspaceId: string, campaignId: string) {
    const a = this.db.select().from(schema.actions)
      .where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.type, "publish_campaign"))).orderBy(desc(schema.actions.createdAt), desc(sql`rowid`)).all()
      .find((x) => (x.payload as { campaignId?: string }).campaignId === campaignId);
    return a ? { id: a.id, status: a.status, result: a.result, createdAt: a.createdAt, executedAt: a.executedAt } : null;
  }

  list(workspaceId: string, status?: string, limit = 100) {
    const where = status && (["awaiting_approval", "executing", "executed", "shadowed", "rejected", "failed"] as string[]).includes(status)
      ? and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.status, status as ActionRow["status"]))
      : eq(schema.actions.workspaceId, workspaceId);
    return this.db.select().from(schema.actions).where(where).orderBy(desc(schema.actions.createdAt), desc(sql`rowid`)).limit(Math.min(limit, 200)).all();
  }

  get(workspaceId: string, id: string) {
    return this.getOrThrow(workspaceId, id);
  }

  private getOrThrow(workspaceId: string, id: string) {
    const a = this.db.select().from(schema.actions).where(and(eq(schema.actions.workspaceId, workspaceId), eq(schema.actions.id, id))).get();
    if (!a) throw new NotFoundException("Action not found");
    return a;
  }

  // ------------------------------------------------------------------ tasks

  listTasks(workspaceId: string, status?: "open" | "done") {
    const where = status ? and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.status, status)) : eq(schema.tasks.workspaceId, workspaceId);
    return this.db.select().from(schema.tasks).where(where).orderBy(desc(schema.tasks.createdAt), desc(sql`rowid`)).limit(200).all()
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done")); // open first, newest first within each
  }

  setTaskStatus(workspaceId: string, id: string, status: "open" | "done") {
    const r = this.db.update(schema.tasks).set({ status, doneAt: status === "done" ? new Date().toISOString() : null })
      .where(and(eq(schema.tasks.workspaceId, workspaceId), eq(schema.tasks.id, id))).run();
    if (r.changes !== 1) throw new NotFoundException("Task not found");
    return this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
  }
}
