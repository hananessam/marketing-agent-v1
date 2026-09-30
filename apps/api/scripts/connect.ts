/**
 * Store an encrypted connection for a workspace and run the first sync.
 * Secrets are read from environment variables (apps/api/.env.local), never from argv or HTTP, and never printed.
 *
 *   pnpm --filter api connect meta_ads --workspace ws_demo [--days 30] [--purge-seed]
 *   pnpm --filter api connect ga4      --workspace ws_demo [--days 30] [--purge-seed]
 *
 * meta_ads: META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, optional META_CONVERSION_ACTION (default "purchase")
 * ga4:      GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_FILE (path to the JSON key; add its email as a Viewer on the property)
 * both:     CONNECTOR_ENCRYPTION_KEY (openssl rand -base64 32)
 */
import "../src/env";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { db, schema } from "../src/db";
import { encryptSecret } from "../src/connectors/crypto";
import { buildConnector } from "../src/connectors/factory";
import { normalizeAdAccountId, DEFAULT_CONVERSION_ACTION } from "../src/connectors/meta";
import { SyncService } from "../src/connectors/sync.service";
import { RunsService } from "../src/runs/runs.service";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
const need = (name: string) => process.env[name] || fail(`Missing ${name} in apps/api/.env.local`);

async function main() {
  const args = process.argv.slice(2);
  const provider = args[0];
  const opt = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const workspaceId = opt("--workspace") ?? fail("Pass --workspace <id>");
  const days = Number(opt("--days") ?? 30);
  if (provider !== "meta_ads" && provider !== "ga4") fail("Provider must be meta_ads or ga4");
  if (!db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).get()) fail(`Unknown workspace ${workspaceId}`);

  let accountId: string;
  let secret: unknown;
  let config: Record<string, string> = {};
  if (provider === "meta_ads") {
    accountId = normalizeAdAccountId(need("META_AD_ACCOUNT_ID"));
    secret = { accessToken: need("META_ACCESS_TOKEN") };
    config = { conversionAction: process.env.META_CONVERSION_ACTION || DEFAULT_CONVERSION_ACTION };
  } else {
    accountId = need("GA4_PROPERTY_ID").replace(/^properties\//, "");
    const key = JSON.parse(readFileSync(need("GA4_SERVICE_ACCOUNT_FILE"), "utf8"));
    if (!key.client_email || !key.private_key) fail("Service account file must contain client_email and private_key");
    // Store only what is needed.
    secret = { serviceAccount: { client_email: key.client_email, private_key: key.private_key } };
  }

  const existing = db.select().from(schema.connections).where(and(
    eq(schema.connections.workspaceId, workspaceId), eq(schema.connections.provider, provider), eq(schema.connections.accountId, accountId))).get();
  const id = existing?.id ?? randomUUID();
  const encryptedSecret = encryptSecret(secret);
  if (existing) db.update(schema.connections).set({ encryptedSecret, config, status: "never_synced", lastError: null }).where(eq(schema.connections.id, id)).run();
  else db.insert(schema.connections).values({ id, workspaceId, provider, accountId, encryptedSecret, config }).run();

  const sync = new SyncService(db, new RunsService(db), buildConnector);
  console.log(`Connecting ${provider} (${accountId}), pulling the last ${days} days (read-only)…`);
  const res = await sync.sync(workspaceId, id, { days });

  if (res.status === "failed") {
    if (!existing) db.delete(schema.connections).where(eq(schema.connections.id, id)).run(); // don't keep credentials that don't work
    fail(`Sync failed: ${res.error}${existing ? "" : "\nNothing was saved."}`);
  }
  console.log(`OK: ${res.summary.campaigns} campaign(s), ${res.summary.rows} daily row(s) ${res.summary.range.startDate} → ${res.summary.range.endDate}`);
  if (Object.keys(res.summary.skipped).length) console.log("Skipped rows:", res.summary.skipped);
  if (args.includes("--purge-seed")) console.log(`Removed ${sync.purgeSeedData(workspaceId)} demo-seed campaign(s).`);
}

main().catch((e) => fail(`Failed: ${e instanceof Error ? e.message : "unknown error"}`));
