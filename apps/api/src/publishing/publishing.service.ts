import { ConflictException, Inject, Injectable, Optional, UnprocessableEntityException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { decryptSecret } from "../connectors/crypto";
import { ConnectorAuthError, ConnectorError } from "../connectors/http";
import { schema, type Db } from "../db";
import { DB } from "../db/database.module";
import { MetaPublisher, type MetaAdInput } from "./meta-publisher";
import type { ActionRow, MetaSettings, Outcome, Publisher } from "./types";

export const META_PUBLISHER_FACTORY = Symbol("META_PUBLISHER_FACTORY");
export type MetaPublisherFactory = (accessToken: string, adAccountId: string) => MetaPublisher;

/** What a Meta login must be allowed to do before this app will create ads with it. */
export const REQUIRED_PERMISSIONS = ["ads_management", "pages_show_list", "pages_read_engagement"] as const;
const DEFAULT_MAX_DAILY_BUDGET = 50;

const hostAllowed = (host: string, allowed: string[]) => allowed.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));

@Injectable()
export class PublishingService implements Publisher {
  constructor(@Inject(DB) private readonly db: Db, @Optional() @Inject(META_PUBLISHER_FACTORY) private readonly factory?: MetaPublisherFactory) {}

  get mode(): "shadow" | "live" {
    return process.env.EXECUTION_MODE === "live" ? "live" : "shadow";
  }

  /** A hard ceiling on the daily budget this app will ever set, whatever is typed into a form. */
  get maxDailyBudget(): number {
    const n = Number(process.env.MAX_DAILY_BUDGET);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DAILY_BUDGET;
  }

  private metaConnection(workspaceId: string) {
    return this.db.select().from(schema.connections)
      .where(and(eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.provider, "meta_ads"), inArray(schema.connections.status, ["ok", "never_synced"]))).all()
      .find((c) => c.accountId.startsWith("act_"));
  }

  private permissions(conn?: { config: Record<string, string> }) {
    return (conn?.config.permissions ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  }

  private missing(conn?: { config: Record<string, string> }) {
    const have = this.permissions(conn);
    return REQUIRED_PERMISSIONS.filter((p) => !have.includes(p));
  }

  status(workspaceId: string) {
    const conn = this.metaConnection(workspaceId);
    let defaults: MetaSettings | null = null;
    try { defaults = conn?.config.publishDefaults ? (JSON.parse(conn.config.publishDefaults) as MetaSettings) : null; } catch { /* ignore a corrupt value */ }
    const missing = conn ? this.missing(conn) : [...REQUIRED_PERMISSIONS];
    return {
      mode: this.mode,
      maxDailyBudget: this.maxDailyBudget,
      meta: { connected: Boolean(conn), connectionId: conn?.id ?? null, accountName: conn?.config.accountName ?? null, canPublish: Boolean(conn) && missing.length === 0, missing, defaults },
      google: { available: false, reason: "Google Ads is not connected yet. Its copy stays on the campaign page, ready to copy." },
    };
  }

  /** Status plus what only Meta knows: the ad account's currency and the Pages this login can post as. */
  async metaDetails(workspaceId: string) {
    const base = this.status(workspaceId);
    const conn = this.metaConnection(workspaceId);
    if (!conn || !base.meta.canPublish) return { ...base, currency: null, accountActive: null, pages: [] as { id: string; name: string }[] };
    const pub = this.publisherFor(conn);
    try {
      const [account, pages] = await Promise.all([pub.account(), pub.pages()]);
      return { ...base, currency: account.currency, accountActive: account.active, pages };
    } catch (e) {
      throw this.readable(e);
    }
  }

  // ------------------------------------------------------------------ checks

  preflight(workspaceId: string, campaignId: string, meta?: MetaSettings): void {
    const hasMetaCopy = this.approvedAssets(workspaceId, campaignId).some((a) => a.variant.startsWith("meta_ads:"));

    if (meta) {
      if (meta.dailyBudget > this.maxDailyBudget) throw new UnprocessableEntityException(`The daily budget is limited to ${this.maxDailyBudget} per campaign (you entered ${meta.dailyBudget}). The limit can be raised with MAX_DAILY_BUDGET on the server.`);
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

    if (this.mode === "live" && hasMetaCopy) {
      if (!meta) throw new UnprocessableEntityException("To post to Meta, enter a daily budget, a country, a Facebook Page and a landing page.");
      const conn = this.metaConnection(workspaceId);
      if (!conn) throw new UnprocessableEntityException("Connect your Meta Ads account in Settings first.");
      if (this.missing(conn).length) throw new UnprocessableEntityException(`Meta posting is not allowed yet. Use "Allow posting" in Settings (missing: ${this.missing(conn).join(", ")}).`);
    }
  }

  // ------------------------------------------------------------------ posting

  async publish(action: ActionRow): Promise<Outcome> {
    const { campaignId, meta } = action.payload as { campaignId: string; meta?: MetaSettings };
    const ws = action.workspaceId;
    const campaign = this.db.select().from(schema.campaigns).where(and(eq(schema.campaigns.workspaceId, ws), eq(schema.campaigns.id, campaignId))).get();
    if (!campaign) throw new ConflictException("Campaign not found");
    const assets = this.approvedAssets(ws, campaignId);
    const channels = new Set(assets.map((a) => a.variant.split(":")[0]));

    const platforms: Record<string, unknown> = {};
    let posted = false;

    if (channels.has("google_ads")) {
      platforms.google_ads = { outcome: "not_posted", note: "Google Ads is not connected yet, so this copy was not posted. It is ready to copy from the campaign page." };
    }

    if (channels.has("meta_ads")) {
      if (!meta) throw new ConflictException("Ad settings are missing, so nothing was posted to Meta.");
      const conn = this.metaConnection(ws);
      if (!conn || this.missing(conn).length) throw new ConflictException('Meta posting is not allowed for this login. Use "Allow posting" in Settings.');
      const pub = this.publisherFor(conn);
      try {
        const account = await pub.account();
        if (!account.active) throw new ConflictException("This Meta ad account is not active. Check billing and status in Ads Manager.");
        const pages = await pub.pages();
        // The Page id came from a form: only accept one this login really manages.
        if (!pages.some((p) => p.id === meta.pageId)) throw new ConflictException("That Facebook Page is not one this login can post as.");
        const ads = this.metaAds(campaign.name, assets.filter((a) => a.variant.startsWith("meta_ads:")));
        const res = await pub.publish({ campaignName: campaign.name, ads, settings: meta, currency: account.currency, utmCampaign: campaign.name });
        platforms.meta_ads = { outcome: "created_paused", ...res };
        posted = true;
        // Remember the answers for next time.
        this.db.update(schema.connections).set({ config: { ...conn.config, publishDefaults: JSON.stringify(meta) } }).where(eq(schema.connections.id, conn.id)).run();
      } catch (e) {
        throw this.readable(e);
      }
    }

    return { status: posted ? "executed" : "shadowed", result: { mode: "live", platforms } };
  }

  /** One ad per variant letter (A, B, ...), each built from that variant's own headline, description, post and button. */
  private metaAds(campaignName: string, assets: { kind: string; variant: string; content: string }[]): MetaAdInput[] {
    const byLabel = new Map<string, Record<string, string>>();
    for (const a of assets) {
      const label = a.variant.split(":")[1];
      byLabel.set(label, { ...(byLabel.get(label) ?? {}), [a.kind]: a.content });
    }
    const ads = [...byLabel].sort(([a], [b]) => a.localeCompare(b)).flatMap(([label, p]) => {
      if (!p.ad_headline) return [];
      return [{
        name: `${campaignName} · Ad ${label}`, headline: p.ad_headline, description: p.ad_description ?? "",
        primaryText: p.social_post ?? p.ad_description ?? p.ad_headline, cta: p.cta ?? "Learn more", contentLabel: label,
      }];
    });
    if (!ads.length) throw new UnprocessableEntityException("There is no approved Meta headline to post.");
    return ads;
  }

  private approvedAssets(workspaceId: string, campaignId: string) {
    return this.db.select().from(schema.campaignAssets)
      .where(and(eq(schema.campaignAssets.workspaceId, workspaceId), eq(schema.campaignAssets.campaignId, campaignId), eq(schema.campaignAssets.status, "approved"))).all();
  }

  private publisherFor(conn: { encryptedSecret: string; accountId: string }): MetaPublisher {
    const { accessToken } = decryptSecret<{ accessToken?: string }>(conn.encryptedSecret);
    if (!accessToken) throw new ConflictException("The stored Meta login has no access token. Reconnect Meta in Settings.");
    return (this.factory ?? ((t, a) => new MetaPublisher(t, a)))(accessToken, conn.accountId);
  }

  /** Errors that are already written for people pass through; the rest become a plain conflict. */
  private readable(e: unknown): Error {
    if (e instanceof ConnectorAuthError || e instanceof ConnectorError || e instanceof ConflictException || e instanceof UnprocessableEntityException) return e;
    return new ConflictException(e instanceof Error ? e.message : "Posting failed");
  }
}
