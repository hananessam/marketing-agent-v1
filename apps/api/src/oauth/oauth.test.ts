import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "../connectors/crypto";
import { ConnectorAuthError } from "../connectors/http";
import type { Db } from "../db";
import { createTestDb, schema } from "../test/helpers";
import { OAuthService } from "./oauth.service";
import { GoogleOAuth, MetaOAuth, type Grant, type OAuthProvider } from "./providers";

beforeAll(() => { process.env.CONNECTOR_ENCRYPTION_KEY = randomBytes(32).toString("base64"); });

const noSleep = async () => {};
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response;
const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

describe("GoogleOAuth", () => {
  const cfg = { clientId: "cid", clientSecret: "csecret", apiPublicUrl: "http://localhost:4000/" };

  it("builds a consent URL with offline access, forced consent, PKCE and the exact redirect URI", () => {
    const u = new URL(new GoogleOAuth(cfg).authUrl({ state: "S", codeChallenge: "CH" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "http://localhost:4000/connections/oauth/google/callback", response_type: "code", scope: GA_SCOPE,
      access_type: "offline", prompt: "consent", state: "S", code_challenge: "CH", code_challenge_method: "S256",
    });
    expect(u.search).not.toContain("csecret");
  });

  it("exchanges the code (with the PKCE verifier) for a refresh token", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { access_token: "AT", refresh_token: "RT", scope: `openid ${GA_SCOPE}` }));
    const g = await new GoogleOAuth(cfg, { fetchFn: f as never, sleep: noSleep }).exchangeCode({ code: "CODE", codeVerifier: "VER" });
    expect(g.secret).toEqual({ refreshToken: "RT" });
    const form = Object.fromEntries(new URLSearchParams((f.mock.calls[0][1] as RequestInit).body as URLSearchParams));
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "CODE", code_verifier: "VER", client_secret: "csecret" });
  });

  it("refuses grants without the analytics scope or without a refresh token, and surfaces rejections", async () => {
    const mk = (body: unknown, status = 200) => new GoogleOAuth(cfg, { fetchFn: vi.fn().mockResolvedValue(res(status, body)) as never, sleep: noSleep });
    await expect(mk({ refresh_token: "RT", scope: "openid" }).exchangeCode({ code: "c" })).rejects.toThrow(/not granted/);
    await expect(mk({ access_token: "AT", scope: GA_SCOPE }).exchangeCode({ code: "c" })).rejects.toThrow(/refresh token/);
    await expect(mk({ error: "invalid_grant" }, 400).exchangeCode({ code: "c" })).rejects.toThrow(/rejected/);
  });

  it("lists GA4 properties across accounts and pages", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: "AT" }))
      .mockResolvedValueOnce(res(200, { accountSummaries: [{ displayName: "Acme", propertySummaries: [{ property: "properties/111", displayName: "Web" }, { property: "properties/bad", displayName: "x" }] }], nextPageToken: "P2" }))
      .mockResolvedValueOnce(res(200, { accountSummaries: [{ displayName: "Other", propertySummaries: [{ property: "properties/222", displayName: "App" }] }] }));
    const out = await new GoogleOAuth(cfg, { fetchFn: f as never, sleep: noSleep }).listAccounts({ refreshToken: "RT" });
    expect(out).toEqual([{ id: "111", name: "Web (Acme)" }, { id: "222", name: "App (Other)" }]);
    expect(f.mock.calls[2][0]).toContain("pageToken=P2");
  });

  it("asks the user to reconnect when the refresh token is dead", async () => {
    const f = vi.fn().mockResolvedValue(res(400, { error: "invalid_grant" }));
    await expect(new GoogleOAuth(cfg, { fetchFn: f as never, sleep: noSleep }).listAccounts({ refreshToken: "RT" })).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

describe("MetaOAuth", () => {
  const cfg = { appId: "123", appSecret: "msecret", apiPublicUrl: "http://localhost:4000" };

  it("builds a dialog URL that asks only for ads_read", () => {
    const u = new URL(new MetaOAuth(cfg).authUrl({ state: "S" }));
    expect(u.hostname).toBe("www.facebook.com");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: "123", scope: "ads_read", state: "S", redirect_uri: "http://localhost:4000/connections/oauth/meta/callback" });
    expect(u.search).not.toContain("msecret");
  });

  it("swaps the code for a short-lived token, then for a long-lived one, recording its expiry", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: "SHORT", expires_in: 3600 }))
      .mockResolvedValueOnce(res(200, { access_token: "LONG", expires_in: 5_184_000 }));
    const g = await new MetaOAuth(cfg, { fetchFn: f as never, sleep: noSleep }).exchangeCode({ code: "CODE" });
    expect(g.secret).toEqual({ accessToken: "LONG" });
    expect(Date.parse(g.config.expiresAt)).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    expect(f.mock.calls[0][0]).toContain("code=CODE");
    expect(f.mock.calls[1][0]).toContain("grant_type=fb_exchange_token");
    expect(f.mock.calls[1][0]).toContain("fb_exchange_token=SHORT");
  });

  it("lists ad accounts by cursor and drops malformed ids", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { data: [{ id: "act_1", name: "Main" }, { id: "evil/../x", name: "bad" }], paging: { cursors: { after: "C1" }, next: "https://graph.facebook.com/leak?access_token=X" } }))
      .mockResolvedValueOnce(res(200, { data: [{ id: "act_2", name: "Second" }] }));
    const out = await new MetaOAuth(cfg, { fetchFn: f as never, sleep: noSleep }).listAccounts({ accessToken: "T" });
    expect(out).toEqual([{ id: "act_1", name: "Main" }, { id: "act_2", name: "Second" }]);
    expect(f.mock.calls[1][0]).toContain("after=C1");
    expect(f.mock.calls[1][0]).not.toContain("leak");
    const dead = vi.fn().mockResolvedValue(res(400, { error: { code: 190, message: "expired" } }));
    await expect(new MetaOAuth(cfg, { fetchFn: dead as never, sleep: noSleep }).listAccounts({ accessToken: "T" })).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

// ------------------------------------------------------------------ service

class FakeProvider implements OAuthProvider {
  readonly slug: "google" | "meta";
  readonly provider: "ga4" | "meta_ads";
  readonly usesPkce: boolean;
  configuredFlag = true;
  lastExchange?: { code: string; codeVerifier?: string };
  grant: Grant = { secret: { refreshToken: "RT-secret" }, config: {} };
  failExchange = false;
  accountsList = [{ id: "111", name: "Web" }, { id: "222", name: "App" }];
  constructor(slug: "google" | "meta" = "google") { this.slug = slug; this.provider = slug === "google" ? "ga4" : "meta_ads"; this.usesPkce = slug === "google"; }
  configured() { return this.configuredFlag; }
  authUrl(p: { state: string; codeChallenge?: string }) { return `https://consent.test/?state=${p.state}&cc=${p.codeChallenge ?? ""}`; }
  async exchangeCode(p: { code: string; codeVerifier?: string }) { this.lastExchange = p; if (this.failExchange) throw new Error("provider said no: SECRET-DETAIL"); return this.grant; }
  async listAccounts() { return this.accountsList; }
}

describe("OAuthService", () => {
  let db: Db;
  let google: FakeProvider;
  let svc: OAuthService;
  const stateFrom = (url: string) => new URL(url).searchParams.get("state")!;

  beforeEach(async () => {
    db = await createTestDb();
    google = new FakeProvider("google");
    svc = new OAuthService(db, [google, new FakeProvider("meta")]);
    db.insert(schema.workspaces).values([{ id: "w", name: "w" }, { id: "x", name: "x" }]).run();
  });
  const connections = (ws = "w") => db.select().from(schema.connections).where(eq(schema.connections.workspaceId, ws)).all();

  it("start issues a random single-use state with a PKCE challenge derived from the stored verifier", () => {
    const { authUrl } = svc.start("w", "google");
    const state = stateFrom(authUrl);
    expect(state.length).toBeGreaterThanOrEqual(40);
    const row = db.select().from(schema.oauthStates).where(eq(schema.oauthStates.state, state)).get()!;
    expect(row).toMatchObject({ workspaceId: "w", provider: "ga4" });
    const challenge = createHash("sha256").update(row.codeVerifier!).digest("base64url");
    expect(authUrl).toContain(`cc=${challenge}`);
    expect(stateFrom(svc.start("w", "google").authUrl)).not.toBe(state);
  });

  it("callback stores the tokens encrypted, as a pending connection in the workspace that started the flow", async () => {
    const state = stateFrom(svc.start("w", "google").authUrl);
    const r = await svc.callback("google", { code: "CODE", state });
    expect(r).toMatchObject({ ok: true, pending: true, provider: "ga4" });
    const [c] = connections();
    expect(c).toMatchObject({ status: "pending_account", provider: "ga4" });
    expect(c.encryptedSecret).not.toContain("RT-secret");
    expect(decryptSecret(c.encryptedSecret)).toEqual({ refreshToken: "RT-secret" });
    expect(google.lastExchange?.codeVerifier).toBeTruthy();
    expect(connections("x")).toEqual([]);
  });

  it("rejects replayed, unknown, expired, cross-provider and missing states without exchanging a code", async () => {
    const state = stateFrom(svc.start("w", "google").authUrl);
    expect((await svc.callback("google", { code: "c", state })).ok).toBe(true);
    google.lastExchange = undefined;
    expect(await svc.callback("google", { code: "c", state })).toEqual({ ok: false, code: "invalid_state" }); // replay
    expect(await svc.callback("google", { code: "c", state: "forged" })).toEqual({ ok: false, code: "invalid_state" });
    expect(await svc.callback("google", { code: "c" })).toEqual({ ok: false, code: "invalid_state" });

    const s2 = stateFrom(svc.start("w", "google").authUrl);
    expect(await svc.callback("meta", { code: "c", state: s2 })).toEqual({ ok: false, code: "invalid_state" }); // state issued for another provider
    db.update(schema.oauthStates).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.oauthStates.state, stateFrom(svc.start("w", "google").authUrl))).run();
    const s3 = db.select().from(schema.oauthStates).all().find((r) => Date.parse(r.expiresAt) < Date.now())!;
    expect(await svc.callback("google", { code: "c", state: s3.state })).toEqual({ ok: false, code: "invalid_state" });
    expect(google.lastExchange).toBeUndefined();
    expect(connections()).toHaveLength(1);
  });

  it("reports denial and exchange failures with fixed codes (no provider text leaks) and saves nothing", async () => {
    expect(await svc.callback("google", { error: "access_denied", state: stateFrom(svc.start("w", "google").authUrl) })).toEqual({ ok: false, code: "denied" });
    google.failExchange = true;
    const r = await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google").authUrl) });
    expect(r).toEqual({ ok: false, code: "exchange_failed" });
    expect(JSON.stringify(r)).not.toContain("SECRET-DETAIL");
    expect(connections()).toEqual([]);
  });

  it("refuses to start when the provider is not configured", () => {
    google.configuredFlag = false;
    expect(() => svc.start("w", "google")).toThrow(/not configured/);
    expect(svc.status()).toMatchObject({ google: { configured: false }, meta: { configured: true } });
    expect(() => svc.start("w", "nope")).toThrow(/Unknown provider/);
  });

  it("selecting an account validates it against what the login can see, then activates the connection", async () => {
    await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google").authUrl) });
    const { id } = connections()[0];
    await expect(svc.selectAccount("w", id, "999")).rejects.toThrow(/not available/);
    await expect(svc.selectAccount("x", id, "111")).rejects.toThrow(/not found/);
    expect(await svc.accounts("w", id)).toHaveLength(2);

    await svc.selectAccount("w", id, "111");
    expect(connections()[0]).toMatchObject({ accountId: "111", status: "never_synced", config: { accountName: "Web" } });
  });

  it("reconnecting replaces the tokens on the existing connection; other workspaces cannot reconnect it", async () => {
    await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google").authUrl) });
    const { id } = connections()[0];
    await svc.selectAccount("w", id, "111");
    db.update(schema.connections).set({ status: "needs_reauth", lastError: "revoked" }).where(eq(schema.connections.id, id)).run();

    expect(() => svc.start("x", "google", id)).toThrow(/not found/);
    google.grant = { secret: { refreshToken: "RT-NEW" }, config: {} };
    const r = await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google", id).authUrl) });
    expect(r).toMatchObject({ ok: true, pending: false, connectionId: id });
    const c = connections()[0];
    expect(connections()).toHaveLength(1);
    expect(c).toMatchObject({ accountId: "111", status: "never_synced", lastError: null });
    expect(decryptSecret(c.encryptedSecret)).toEqual({ refreshToken: "RT-NEW" });
  });

  it("folds a new login for an already-connected account into the existing connection", async () => {
    await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google").authUrl) });
    await svc.selectAccount("w", connections()[0].id, "111");
    google.grant = { secret: { refreshToken: "RT-2" }, config: {} };
    await svc.callback("google", { code: "c", state: stateFrom(svc.start("w", "google").authUrl) });
    expect(connections()).toHaveLength(2);
    const pending = connections().find((c) => c.status === "pending_account")!;
    const out = await svc.selectAccount("w", pending.id, "111");
    expect(connections()).toHaveLength(1);
    expect(out.connectionId).not.toBe(pending.id);
    expect(decryptSecret(connections()[0].encryptedSecret)).toEqual({ refreshToken: "RT-2" });
  });

  it("stores Meta's conversion action choice and defaults to purchase", async () => {
    const meta = new FakeProvider("meta");
    meta.grant = { secret: { accessToken: "LONG" }, config: { expiresAt: "2026-12-01T00:00:00.000Z" } };
    meta.accountsList = [{ id: "act_9", name: "Shop" }];
    const s = new OAuthService(db, [meta]);
    await s.callback("meta", { code: "c", state: stateFrom(s.start("w", "meta").authUrl) });
    const { id } = connections()[0];
    await s.selectAccount("w", id, "act_9", "lead");
    expect(connections()[0].config).toMatchObject({ conversionAction: "lead", accountName: "Shop", expiresAt: "2026-12-01T00:00:00.000Z" });
  });
});
