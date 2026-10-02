import { db, schema } from "../src/db";

const WS = "ws_demo";
const today = new Date();
const day = (offset: number) => {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

// deterministic pseudo-random
let s = 42;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const jitter = (base: number, pct = 0.1) => Math.round(base * (1 + (rnd() - 0.5) * 2 * pct));

const campaigns = [
  { id: "c_google_brand", name: "Google Brand Search", channel: "google_ads", imp: 12000, ctr: 0.04, cr: 0.05, cpc: 1.2, aov: 90 },
  { id: "c_meta_lookalike", name: "Meta Lookalike", channel: "meta_ads", imp: 30000, ctr: 0.012, cr: 0.02, cpc: 0.8, aov: 70 },
] as const;

// Everything is cleared, children first (foreign keys), including connected accounts and anything made in the app.
for (const t of [
  schema.toolCalls, schema.approvals, schema.actions, schema.tasks, schema.agentRuns, schema.experiments, schema.campaignAssets,
  schema.campaignMetrics, schema.reportSchedules, schema.oauthStates, schema.connections,
]) db.delete(t).run();
db.delete(schema.campaigns).run();
db.delete(schema.brandProfiles).run();
db.delete(schema.products).run();
db.delete(schema.audiences).run();

// The workspace row is reset rather than deleted: other tables (such as sign-in accounts) may point at it.
db.insert(schema.workspaces).values({ id: WS, name: "Demo Workspace" })
  .onConflictDoUpdate({ target: schema.workspaces.id, set: { name: "Demo Workspace", onboardedAt: null } }).run();
db.insert(schema.brandProfiles).values({
  id: "bp_1", workspaceId: WS,
  voice: "Friendly, concise, practical. No hype.",
  approvedClaims: ["Free 30-day trial", "Set up in under 10 minutes"],
  prohibited: ["guaranteed results", "#1 in the world", "fake urgency", "testimonial"],
  allowedDomains: ["acme-planner.example"],
}).run();
db.insert(schema.products).values({ id: "p_1", workspaceId: WS, name: "Acme Planner", description: "Project planning SaaS for small teams." }).run();
db.insert(schema.audiences).values([
  { id: "a_1", workspaceId: WS, name: "Startup founders", description: "Teams of 2-10 shipping a first product." },
  { id: "a_2", workspaceId: WS, name: "Agency PMs", description: "Project managers juggling many clients." },
]).run();

const rows: (typeof schema.campaignMetrics.$inferInsert)[] = [];
for (const c of campaigns) {
  db.insert(schema.campaigns).values({ id: c.id, workspaceId: WS, name: c.name, channel: c.channel, status: "active", source: "seed" }).run();
  // 14 days: days 13..7 = previous period, 6..0 = current period. Yesterday (1) is most recent complete day.
  for (let off = 14; off >= 1; off--) {
    const impressions = jitter(c.imp);
    let ctr = c.ctr;
    let cr = c.cr;
    // Planted anomaly: Meta conversion rate collapses in the current period (likely landing page / tracking issue).
    if (c.id === "c_meta_lookalike" && off <= 5) cr = c.cr * 0.3;
    // Planted anomaly: Google CTR up but flat conversions.
    if (c.id === "c_google_brand" && off <= 4) ctr = c.ctr * 1.5;
    const clicks = Math.round(impressions * ctr);
    const conversions = Math.round(clicks * cr);
    rows.push({
      workspaceId: WS, campaignId: c.id, channel: c.channel, date: day(off),
      impressions, clicks, spend: +(clicks * c.cpc).toFixed(2), conversions,
      revenue: +(conversions * c.aov).toFixed(2),
      ingestedAt: new Date().toISOString(),
    });
  }
}
const filtered = rows;
db.insert(schema.campaignMetrics).values(filtered).run();
console.log(`Seeded ${filtered.length} metric rows for ${campaigns.length} campaigns.`);
