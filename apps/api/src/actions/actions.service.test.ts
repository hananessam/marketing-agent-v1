import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CampaignsService } from "../campaigns/campaigns.service";
import type { Db } from "../db";
import { createTestDb, schema } from "../test/helpers";
import { ActionsService } from "./actions.service";

let db: Db;
let actions: ActionsService;
let inbox: CampaignsService;
const future = () => new Date(Date.now() + 7 * 86_400_000).toISOString();
const propose = (type: string, payload: unknown, extra: Record<string, unknown> = {}, ws = "w") =>
  actions.propose(ws, { type, payload, source: "manual", requestedBy: "tester", ...extra } as never);
const approvals = (ws = "w") => db.select().from(schema.approvals).where(eq(schema.approvals.workspaceId, ws)).all();
const campaignRow = (id: string) => db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).get()!;

beforeEach(async () => {
  delete process.env.EXECUTION_MODE;
  db = await createTestDb();
  actions = new ActionsService(db);
  inbox = new CampaignsService(db, {} as never, {} as never, {} as never, actions);
  db.insert(schema.workspaces).values([{ id: "w", name: "w" }, { id: "other", name: "o" }]).run();
  db.insert(schema.campaigns).values([
    { id: "meta", workspaceId: "w", name: "Meta Spring", channel: "meta_ads", status: "active", source: "meta_ads" },
    { id: "ga", workspaceId: "w", name: "GA Visits", channel: "google_ads", status: "active", source: "ga4" },
    { id: "ready", workspaceId: "w", name: "Launch Me", channel: "email,linkedin", status: "approved", source: "manual" },
    { id: "draft", workspaceId: "w", name: "Not Yet", channel: "email", status: "draft", source: "manual" },
    { id: "theirs", workspaceId: "other", name: "Theirs", channel: "meta_ads", status: "active", source: "meta_ads" },
  ]).run();
  const asset = (id: string, variant: string, kind: string, content: string, status = "approved") =>
    ({ id, workspaceId: "w", campaignId: "ready", kind, variant, content, status: status as "approved" });
  db.insert(schema.campaignAssets).values([
    asset("a1", "email:A", "email_subject", "Plan your week"), asset("a2", "email:B", "email_subject", "Your week, planned"),
    asset("a3", "linkedin:A", "ad_headline", "Plan faster"), asset("a4", "email:A", "email_body", "Draft body", "rejected"),
  ]).run();
});
afterEach(() => { delete process.env.EXECUTION_MODE; });

describe("tasks (internal, run immediately)", () => {
  it("creates the task straight away with no approval, and an identical proposal does not create a second one", async () => {
    const r = await propose("create_task", { title: "Fix the landing page", description: "Conversion fell 54%", campaignId: "meta" }, { source: "recommendation", sourceRef: "run1:0" });
    expect(r.action).toMatchObject({ status: "executed", type: "create_task" });
    expect(approvals()).toHaveLength(0);
    const tasks = actions.listTasks("w");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Fix the landing page", status: "open", campaignId: "meta", actionId: r.action.id });

    const again = await propose("create_task", { description: "Conversion fell 54%", title: "Fix the landing page", campaignId: "meta" }, { source: "recommendation", sourceRef: "run1:0" });
    expect(again.reused).toBe(true);
    expect(again.action.id).toBe(r.action.id);
    expect(actions.listTasks("w")).toHaveLength(1);
  });

  it("lists open tasks first, lets them be ticked off, and is workspace-scoped", async () => {
    const a = await propose("create_task", { title: "First" });
    await propose("create_task", { title: "Second" });
    const first = actions.listTasks("w").find((t) => t.title === "First")!;
    actions.setTaskStatus("w", first.id, "done");
    expect(actions.listTasks("w").map((t) => `${t.title}:${t.status}`)).toEqual(["Second:open", "First:done"]);
    expect(actions.listTasks("w", "open")).toHaveLength(1);
    expect(actions.setTaskStatus("w", first.id, "open").doneAt).toBeNull();
    expect(() => actions.setTaskStatus("other", first.id, "done")).toThrow(/not found/);
    expect(actions.listTasks("other")).toEqual([]);
    expect(a.action.status).toBe("executed");
  });

  it("rejects a task about a campaign from another workspace", async () => {
    await expect(propose("create_task", { title: "x", campaignId: "theirs" })).rejects.toThrow(/Campaign not found/);
  });
});

describe("external actions wait for approval and run in shadow mode", () => {
  it("pause: proposed -> pending approval, nothing changes until decided, then recorded as shadowed (campaign untouched)", async () => {
    const r = await propose("pause_campaign", { campaignId: "meta", reason: "Conversion collapsed" });
    expect(r.action.status).toBe("awaiting_approval");
    expect(r.action.preview.summary).toBe('Pause "Meta Spring" (Meta Ads)');
    const [ap] = approvals();
    expect(ap).toMatchObject({ status: "pending", action: "pause", payload: { actionId: r.action.id } });
    expect(ap.summary).toContain("shadow mode");
    expect(campaignRow("meta").status).toBe("active");

    const out = await inbox.decideApproval("w", ap.id, "approved", "hanan");
    expect(out).toMatchObject({ status: "approved", actionId: r.action.id });
    const done = actions.get("w", r.action.id);
    expect(done.status).toBe("shadowed");
    expect(done.result).toMatchObject({ mode: "shadow", wouldDo: 'Pause "Meta Spring" (Meta Ads)', note: "Nothing outside this app was changed." });
    expect(done.executedAt).toBeTruthy();
    expect(campaignRow("meta").status).toBe("active"); // still not paused: shadow mode
    expect(approvals()[0]).toMatchObject({ status: "approved", decidedBy: "hanan" });
  });

  it("can only be decided once: a second approval of the same action is refused and nothing runs twice", async () => {
    const r = await propose("pause_campaign", { campaignId: "meta" });
    const [ap] = approvals();
    await inbox.decideApproval("w", ap.id, "approved", "a");
    await expect(inbox.decideApproval("w", ap.id, "approved", "b")).rejects.toThrow(/Already approved|no longer waiting/);
    expect(actions.get("w", r.action.id).status).toBe("shadowed");
  });

  it("rejecting records it, leaves everything untouched, and lets the same idea be proposed again", async () => {
    const r = await propose("pause_campaign", { campaignId: "meta", reason: "x" });
    await inbox.decideApproval("w", approvals()[0].id, "rejected", "hanan", "Not now");
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "rejected", result: null });
    expect(approvals()[0]).toMatchObject({ status: "rejected", payload: { note: "Not now" } });
    const again = await propose("pause_campaign", { campaignId: "meta", reason: "x" });
    expect(again.reused).toBe(false);
    expect(again.action.id).not.toBe(r.action.id);
    expect(approvals().filter((a) => a.status === "pending")).toHaveLength(1);
  });

  it("the same pending proposal is not duplicated", async () => {
    const a = await propose("pause_campaign", { campaignId: "meta" });
    const b = await propose("pause_campaign", { campaignId: "meta" });
    expect(b.reused).toBe(true);
    expect(b.action.id).toBe(a.action.id);
    expect(approvals()).toHaveLength(1);
  });

  it("re-checks at execution time: if the campaign changed after proposal, the approved action fails instead of running", async () => {
    const r = await propose("pause_campaign", { campaignId: "meta" });
    db.update(schema.campaigns).set({ status: "paused" }).where(eq(schema.campaigns.id, "meta")).run(); // someone paused it meanwhile
    await inbox.decideApproval("w", approvals()[0].id, "approved", "hanan");
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "failed", result: { error: "This campaign is already paused" } });
    // a failed action frees its key so it can be proposed again later
    db.update(schema.campaigns).set({ status: "active" }).where(eq(schema.campaigns.id, "meta")).run();
    expect((await propose("pause_campaign", { campaignId: "meta" })).reused).toBe(false);
  });

  it("EXECUTION_MODE=live changes nothing yet: with no live executor the action is still only recorded, with the reason", async () => {
    process.env.EXECUTION_MODE = "live";
    expect(actions.mode).toBe("live");
    const r = await propose("change_budget", { campaignId: "meta", direction: "decrease", percent: 5 });
    await inbox.decideApproval("w", approvals()[0].id, "approved", "h");
    expect(actions.get("w", r.action.id)).toMatchObject({ status: "shadowed", result: { why: "No live connection exists for this kind of action yet." } });
    expect(approvals()[0].summary).not.toContain("shadow mode"); // the inbox note only appears while shadow mode is on
  });
});

describe("validation", () => {
  it("rejects malformed details, unknown campaigns and other workspaces' campaigns", async () => {
    await expect(propose("pause_campaign", {})).rejects.toMatchObject({ status: 400 });
    await expect(propose("change_budget", { campaignId: "meta", direction: "sideways", percent: 5 })).rejects.toMatchObject({ status: 400 });
    await expect(propose("pause_campaign", { campaignId: "nope" })).rejects.toThrow(/not found/);
    await expect(propose("pause_campaign", { campaignId: "theirs" })).rejects.toThrow(/not found/);
    expect(approvals()).toHaveLength(0);
  });

  it("caps budget changes at 10% and refuses nonsense amounts", async () => {
    await expect(propose("change_budget", { campaignId: "meta", direction: "increase", percent: 25 })).rejects.toThrow(/limited to 10%/);
    await expect(propose("change_budget", { campaignId: "meta", direction: "increase", percent: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(propose("change_budget", { campaignId: "meta", direction: "increase", percent: -5 })).rejects.toMatchObject({ status: 400 });
    const ok = await propose("change_budget", { campaignId: "meta", direction: "increase", percent: 10 });
    expect(ok.action.preview.summary).toBe('Increase the budget of "Meta Spring" by 10% (Meta Ads)');
  });

  it("will not pause or re-budget Google Analytics reports, which have nothing to control", async () => {
    await expect(propose("pause_campaign", { campaignId: "ga" })).rejects.toThrow(/nothing to pause/);
    await expect(propose("change_budget", { campaignId: "ga", direction: "decrease", percent: 5 })).rejects.toThrow(/no budget/);
  });

  it("only publishes or schedules approved campaigns that have approved copy", async () => {
    await expect(propose("publish_campaign", { campaignId: "draft" })).rejects.toThrow(/Only approved campaigns/);
    await expect(propose("schedule_email", { campaignId: "draft", sendAt: future() })).rejects.toThrow(/Only approved campaigns/);
    db.insert(schema.campaigns).values({ id: "empty", workspaceId: "w", name: "Empty", channel: "email", status: "approved", source: "manual" }).run();
    await expect(propose("publish_campaign", { campaignId: "empty" })).rejects.toThrow(/no approved copy/);
    await expect(propose("schedule_email", { campaignId: "empty", sendAt: future() })).rejects.toThrow(/no approved email copy/);
  });

  it("the launch package lists only approved copy, grouped by channel; scheduling needs a future time", async () => {
    const r = await propose("publish_campaign", { campaignId: "ready" });
    expect(r.action.preview.summary).toBe('Publish "Launch Me": 3 pieces of approved copy on email, linkedin');
    const details = r.action.preview.details as { channels: { channel: string; items: { content: string }[] }[] };
    expect(details.channels.map((c) => c.channel)).toEqual(["email", "linkedin"]);
    expect(JSON.stringify(details)).not.toContain("Draft body"); // the rejected piece is excluded

    await expect(propose("schedule_email", { campaignId: "ready", sendAt: "2020-01-01T09:00:00.000Z" })).rejects.toThrow(/future/);
    await expect(propose("schedule_email", { campaignId: "ready", sendAt: "tomorrow" })).rejects.toMatchObject({ status: 400 });
    const s = await propose("schedule_email", { campaignId: "ready", sendAt: future() });
    expect(s.action.preview.details).toMatchObject({ subjectLines: ["Plan your week", "Your week, planned"], pieces: 2 });
  });
});

describe("isolation and history", () => {
  it("keeps actions, approvals and the inbox separate per workspace", async () => {
    const r = await propose("pause_campaign", { campaignId: "meta" });
    expect(actions.list("other")).toEqual([]);
    expect(() => actions.get("other", r.action.id)).toThrow(/not found/);
    await expect(inbox.decideApproval("other", approvals()[0].id, "approved", "x")).rejects.toThrow(/not found/);
    expect(actions.get("w", r.action.id).status).toBe("awaiting_approval");
  });

  it("lists newest first and can filter by status", async () => {
    await propose("create_task", { title: "t1" });
    await propose("pause_campaign", { campaignId: "meta" });
    expect(actions.list("w").map((a) => a.type)).toEqual(["pause_campaign", "create_task"]);
    expect(actions.list("w", "awaiting_approval")).toHaveLength(1);
    expect(actions.list("w", "executed")).toHaveLength(1);
    expect(actions.list("w", "bogus")).toHaveLength(2); // an unknown filter is ignored, not an error
  });
});
