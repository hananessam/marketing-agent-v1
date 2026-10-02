import { ConflictException, Inject, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import type { ActionRow, MetaSettings, Outcome, Publisher } from "./types";

const SANDBOX = { accountName: "Demo ad account (sandbox)", currency: "USD", minDailyBudget: 1, maxDailyBudget: 50, pages: [{ id: "1000000000001", name: "Demo Page" }, { id: "1000000000002", name: "Demo Brand Page" }] };
const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
const hostAllowed = (host: string, allowed: string[]) => allowed.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));

type Ad = { id: string; name: string; headline: string };

/**
 * A pretend ad platform for demos: it accepts what a real one would (same budget and landing page rules, ads created
 * PAUSED) but makes no network calls and needs no login. Nothing here can spend money or touch a real account.
 */
@Injectable()
export class SandboxPublisher implements Publisher {
  constructor(@Inject(DB) private readonly db: Db) {}

  readonly limits = SANDBOX;

  status() {
    return {
      mode: "demo" as const, maxDailyBudget: SANDBOX.maxDailyBudget, minDailyBudget: SANDBOX.minDailyBudget, currency: SANDBOX.currency,
      meta: { connected: true, connectionId: null, accountName: SANDBOX.accountName, canPublish: true, missing: [] as string[], defaults: null },
      google: { available: true, reason: "Demo mode: Google Ads copy is posted to the sandbox too." },
    };
  }

  details() {
    return { ...this.status(), accountActive: true, pages: SANDBOX.pages };
  }

  preflight(workspaceId: string, campaignId: string, meta?: MetaSettings): void {
    const hasMetaCopy = this.assets(workspaceId, campaignId).some((a) => a.variant.startsWith("meta_ads:"));
    if (hasMetaCopy && !meta) throw new UnprocessableEntityException("To post to Meta, enter a daily budget, a country, a Facebook Page and a landing page.");
    if (!meta) return;
    if (!(meta.dailyBudget >= SANDBOX.minDailyBudget)) throw new UnprocessableEntityException(`The daily budget must be at least ${SANDBOX.minDailyBudget} ${SANDBOX.currency}.`);
    if (meta.dailyBudget > SANDBOX.maxDailyBudget) throw new UnprocessableEntityException(`The daily budget is limited to ${SANDBOX.maxDailyBudget} ${SANDBOX.currency} per campaign (you entered ${meta.dailyBudget}).`);
    if (!SANDBOX.pages.some((p) => p.id === meta.pageId)) throw new UnprocessableEntityException("Choose one of the demo Pages.");
    let host: string;
    try {
      const u = new URL(meta.landingUrl);
      if (u.protocol !== "https:") throw new Error("not https");
      host = u.hostname.toLowerCase();
    } catch {
      throw new UnprocessableEntityException("The landing page must be a full https:// address.");
    }
    const brand = this.db.select({ d: schema.brandProfiles.allowedDomains }).from(schema.brandProfiles).where(eq(schema.brandProfiles.workspaceId, workspaceId)).get();
    if (!hostAllowed(host, brand?.d ?? [])) throw new UnprocessableEntityException("The landing page must be on one of your own websites. Add it under Your company in Settings.");
  }

  async publish(action: ActionRow): Promise<Outcome> {
    const { campaignId, meta } = action.payload as { campaignId: string; meta?: MetaSettings };
    const ws = action.workspaceId;
    const campaign = this.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ws), eq(schema.campaigns.id, campaignId))).get();
    if (!campaign) throw new ConflictException("Campaign not found");
    const assets = this.assets(ws, campaignId);
    this.preflight(ws, campaignId, meta);

    const platforms: Record<string, unknown> = {};
    const meta_ads = this.ads(campaign.name, assets, "meta_ads");
    if (meta_ads.length && meta) {
      platforms.meta_ads = {
        outcome: "created_paused", sandbox: true, campaignId: id("sbx_cmp"), adSetId: id("sbx_set"), adIds: meta_ads.map((a) => a.id), ads: meta_ads,
        adsManagerUrl: null, dailyBudgetMinor: Math.round(meta.dailyBudget * 100), currency: SANDBOX.currency, country: meta.country,
      };
    }
    const google = this.ads(campaign.name, assets, "google_ads");
    if (google.length) platforms.google_ads = { outcome: "created_paused", sandbox: true, campaignId: id("sbx_cmp"), adIds: google.map((a) => a.id), ads: google };

    const posted = Object.keys(platforms).length > 0;
    return { status: posted ? "executed" : "shadowed", result: { mode: "demo", platforms } };
  }

  /** One ad per variant letter of the channel, named after its headline. */
  private ads(campaignName: string, assets: { kind: string; variant: string; content: string }[], channel: string): Ad[] {
    const headlines = new Map<string, string>();
    for (const a of assets) {
      const [ch, label] = a.variant.split(":");
      if (ch === channel && a.kind === "ad_headline") headlines.set(label, a.content);
    }
    return [...headlines].sort(([a], [b]) => a.localeCompare(b)).map(([label, headline]) => ({ id: id("sbx_ad"), name: `${campaignName} · Ad ${label}`, headline }));
  }

  private assets(workspaceId: string, campaignId: string) {
    return this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId), eq(schema.campaignAssets.status, "approved"))).all();
  }
}
