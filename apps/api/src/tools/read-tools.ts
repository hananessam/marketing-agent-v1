import { aggregate, calculateMetrics } from "@marketing/shared";
import { and, asc, between, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db";
import { defineTool, type ToolDefinition } from "./tool.types";

const MAX_RANGE_DAYS = 92;
const isoDate = z.iso.date();

const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

const dateRange = z
  .object({ startDate: isoDate, endDate: isoDate })
  .refine((r) => r.startDate <= r.endDate, "startDate must be on or before endDate")
  .refine((r) => daysBetween(r.startDate, r.endDate) < MAX_RANGE_DAYS, `range limited to ${MAX_RANGE_DAYS} days`);

const METRIC_KEYS = ["impressions", "clicks", "spend", "conversions", "revenue"] as const;

export const getBrandGuidelines = defineTool({
  name: "get_brand_guidelines",
  description: "Brand voice, approved claims and prohibited content for the workspace.",
  readOnly: true,
  parameters: z.object({}),
  execute: ({ db, workspaceId }) =>
    db.select({ voice: schema.brandProfiles.voice, approvedClaims: schema.brandProfiles.approvedClaims, prohibited: schema.brandProfiles.prohibited })
      .from(schema.brandProfiles).where(eq(schema.brandProfiles.workspaceId, workspaceId)).get() ?? null,
});

export const getProductInformation = defineTool({
  name: "get_product_information",
  description: "List products (name and description) for the workspace.",
  readOnly: true,
  parameters: z.object({}),
  execute: ({ db, workspaceId }) =>
    db.select({ id: schema.products.id, name: schema.products.name, description: schema.products.description })
      .from(schema.products).where(eq(schema.products.workspaceId, workspaceId)).all(),
});

export const getAudienceSegments = defineTool({
  name: "get_audience_segments",
  description: "List audience segments for the workspace.",
  readOnly: true,
  parameters: z.object({}),
  execute: ({ db, workspaceId }) =>
    db.select({ id: schema.audiences.id, name: schema.audiences.name, description: schema.audiences.description })
      .from(schema.audiences).where(eq(schema.audiences.workspaceId, workspaceId)).all(),
});

export const listCampaigns = defineTool({
  name: "list_campaigns",
  description: "List campaigns (id, name, channel, status) for the workspace.",
  readOnly: true,
  parameters: z.object({}),
  execute: ({ db, workspaceId }) =>
    db.select({ id: schema.campaigns.id, name: schema.campaigns.name, channel: schema.campaigns.channel, status: schema.campaigns.status })
      .from(schema.campaigns).where(eq(schema.campaigns.workspaceId, workspaceId)).all(),
});

export const getCampaignMetrics = defineTool({
  name: "get_campaign_metrics",
  description:
    "Normalized daily performance metrics for one campaign over a date range, with derived totals " +
    "(ctr, conversionRate, cpc, cpa, roas) and data-quality info (latest date, missing days). Never infer values not returned here.",
  readOnly: true,
  parameters: z
    .object({
      campaignId: z.string().min(1),
      metrics: z.array(z.enum(METRIC_KEYS)).min(1).default([...METRIC_KEYS]),
    })
    .and(dateRange),
  execute: ({ db, workspaceId }, { campaignId, startDate, endDate, metrics }) => {
    const rows = db.select().from(schema.campaignMetrics)
      .where(and(
        eq(schema.campaignMetrics.workspaceId, workspaceId),
        eq(schema.campaignMetrics.campaignId, campaignId),
        between(schema.campaignMetrics.date, startDate, endDate),
      ))
      .orderBy(asc(schema.campaignMetrics.date)).all();

    const have = new Set(rows.map((r) => r.date));
    const missingDates: string[] = [];
    for (let t = Date.parse(startDate); t <= Date.parse(endDate); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!have.has(d)) missingDates.push(d);
    }

    const totals = aggregate(rows);
    const pick = (o: Record<(typeof METRIC_KEYS)[number], number>) =>
      Object.fromEntries(metrics.map((m) => [m, o[m]])) as Record<(typeof metrics)[number], number>;

    return {
      campaignId,
      range: { startDate, endDate },
      daily: rows.map((r) => ({ date: r.date, channel: r.channel, ...pick(r) })),
      totals: pick(totals),
      derived: calculateMetrics(totals),
      dataQuality: { rowCount: rows.length, latestDate: rows.at(-1)?.date ?? null, missingDates },
    };
  },
});

export const readTools: ToolDefinition<any, any>[] = [
  getBrandGuidelines, getProductInformation, getAudienceSegments, listCampaigns, getCampaignMetrics,
];
