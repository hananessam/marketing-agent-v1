import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto";
import { channelFor, Ga4Connector, normalizeGa4 } from "./ga4";
import { ConnectorAuthError, ConnectorError, requestJson } from "./http";
import { MetaConnector, normalizeAdAccountId, normalizeMeta } from "./meta";

const KEY = randomBytes(32).toString("base64");
const noSleep = async () => {};
const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: new Headers(headers) }) as unknown as Response;

describe("crypto", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const secret = { accessToken: "tok_123" };
    const a = encryptSecret(secret, KEY);
    expect(a).not.toContain("tok_123");
    expect(decryptSecret(a, KEY)).toEqual(secret);
    expect(encryptSecret(secret, KEY)).not.toBe(a);
  });
  it("rejects a wrong key, tampering and bad key sizes", () => {
    const blob = encryptSecret({ a: 1 }, KEY);
    expect(() => decryptSecret(blob, randomBytes(32).toString("base64"))).toThrow();
    const buf = Buffer.from(blob, "base64");
    buf[buf.length - 1] ^= 1;
    expect(() => decryptSecret(buf.toString("base64"), KEY)).toThrow();
    expect(() => encryptSecret({}, "c2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("requestJson", () => {
  it("retries 429/5xx with backoff then succeeds, honouring Retry-After", async () => {
    const sleep = vi.fn(noSleep);
    const f = vi.fn().mockResolvedValueOnce(res(429, {}, { "retry-after": "2" })).mockResolvedValueOnce(res(503, {})).mockResolvedValueOnce(res(200, { ok: 1 }));
    const r = await requestJson("https://x.test", {}, { fetchFn: f as never, sleep });
    expect(r.json).toEqual({ ok: 1 });
    expect(f).toHaveBeenCalledTimes(3);
    expect((sleep.mock.calls as number[][])[0][0]).toBe(2000);
  });
  it("gives up after the retry budget and returns the last response", async () => {
    const f = vi.fn().mockResolvedValue(res(500, { e: 1 }));
    const r = await requestJson("https://x.test", {}, { fetchFn: f as never, sleep: noSleep, retries: 2 });
    expect(r.status).toBe(500);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("does not retry ordinary client errors, and network errors never leak the URL", async () => {
    const f = vi.fn().mockResolvedValue(res(400, {}));
    await requestJson("https://x.test", {}, { fetchFn: f as never, sleep: noSleep });
    expect(f).toHaveBeenCalledTimes(1);
    const boom = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED https://x.test/?access_token=SECRET"));
    await expect(requestJson("https://x.test/?access_token=SECRET", {}, { fetchFn: boom as never, sleep: noSleep, retries: 1 })).rejects.toThrow(/^Network error/);
    await requestJson("https://x.test/?access_token=SECRET", {}, { fetchFn: boom as never, sleep: noSleep, retries: 0 }).catch((e) => expect(String(e.message)).not.toContain("SECRET"));
  });
});

describe("Meta", () => {
  const row = (over = {}) => ({
    campaign_id: "123", campaign_name: "Spring", date_start: "2026-03-10", impressions: "1000", clicks: "50", spend: "25.50",
    actions: [{ action_type: "purchase", value: "3" }, { action_type: "omni_purchase", value: "3" }, { action_type: "link_click", value: "40" }],
    action_values: [{ action_type: "purchase", value: "150.00" }, { action_type: "omni_purchase", value: "150.00" }], ...over,
  });

  it("normalizes string metrics and counts exactly one conversion action type (no double counting)", () => {
    const n = normalizeMeta([row()]);
    expect(n.rows[0]).toEqual({ campaignId: "meta_123", date: "2026-03-10", impressions: 1000, clicks: 50, spend: 25.5, conversions: 3, revenue: 150 });
    expect(n.campaigns[0]).toMatchObject({ id: "meta_123", channel: "meta_ads", source: "meta_ads" });
    expect(normalizeMeta([row({ actions: [{ action_type: "lead", value: "7" }] })], "lead").rows[0].conversions).toBe(7);
  });
  it("treats missing actions as zero and drops invalid rows visibly", () => {
    const n = normalizeMeta([row({ actions: undefined, action_values: undefined }), row({ spend: "abc" }), row({ date_start: "bad" }), row({ clicks: "-1" })]);
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].conversions).toBe(0);
    expect(n.skipped).toEqual({ invalid_row: 3 });
  });
  it("validates ad account ids", () => {
    expect(normalizeAdAccountId("1234")).toBe("act_1234");
    expect(normalizeAdAccountId("act_1234")).toBe("act_1234");
    expect(() => normalizeAdAccountId("act_1234/../me")).toThrow();
  });

  it("paginates by cursor, keeps the token out of the URL, and never follows paging.next", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { data: [row()], paging: { cursors: { after: "CUR1" }, next: "https://graph.facebook.com/next?access_token=LEAK" } }))
      .mockResolvedValueOnce(res(200, { data: [row({ date_start: "2026-03-11" })], paging: { cursors: { after: "CUR2" } } }));
    const out = await new MetaConnector({ accessToken: "TOKEN", adAccountId: "999" }, f as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-11" });
    expect(out.rows).toHaveLength(2);
    const [url1, init1] = f.mock.calls[0];
    expect(url1).toContain("/act_999/insights");
    expect(url1).toContain("time_increment=1");
    expect(url1).not.toContain("TOKEN");
    expect((init1 as RequestInit).headers).toEqual({ authorization: "Bearer TOKEN" });
    expect(f.mock.calls[1][0]).toContain("after=CUR1");
    expect(f.mock.calls[1][0]).not.toContain("LEAK");
  });

  it("maps token errors to auth errors and retries Meta rate-limit codes", async () => {
    const auth = vi.fn().mockResolvedValue(res(400, { error: { code: 190, message: "Error validating access token" } }));
    await expect(new MetaConnector({ accessToken: "T", adAccountId: "1" }, auth as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" })).rejects.toBeInstanceOf(ConnectorAuthError);

    const limited = vi.fn().mockResolvedValueOnce(res(400, { error: { code: 17, message: "User request limit reached" } })).mockResolvedValueOnce(res(200, { data: [] }));
    const out = await new MetaConnector({ accessToken: "T", adAccountId: "1" }, limited as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" });
    expect(out.rows).toEqual([]);
    expect(limited).toHaveBeenCalledTimes(2);

    const other = vi.fn().mockResolvedValue(res(400, { error: { code: 100, message: "Invalid parameter" } }));
    await expect(new MetaConnector({ accessToken: "T", adAccountId: "1" }, other as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" })).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("GA4", () => {
  const dims = (date: string, name: string, source: string, medium: string) => [date, name, source, medium].map((value) => ({ value }));
  const mets = (...v: number[]) => v.map((x) => ({ value: String(x) }));

  it("maps source/medium to channels", () => {
    expect(channelFor("facebook", "paid_social")).toBe("meta_ads");
    expect(channelFor("ig", "cpc")).toBe("meta_ads");
    expect(channelFor("google", "cpc")).toBe("google_ads");
    expect(channelFor("linkedin", "paid")).toBe("linkedin");
    expect(channelFor("newsletter", "email")).toBe("email");
    expect(channelFor("google", "organic")).toBeNull();
    expect(channelFor("tiktok", "cpc")).toBeNull();
  });

  it("sums per campaign/channel/day, converts dates, and reports what it skipped", () => {
    const n = normalizeGa4([
      { dimensionValues: dims("20260310", "Spring Sale", "facebook", "paid_social"), metricValues: mets(100, 4, 200) },
      { dimensionValues: dims("20260310", "Spring Sale", "instagram", "paid_social"), metricValues: mets(50, 1, 50) },
      { dimensionValues: dims("20260310", "(not set)", "google", "organic"), metricValues: mets(900, 9, 0) },
      { dimensionValues: dims("20260310", "Blog", "google", "organic"), metricValues: mets(10, 0, 0) },
      { dimensionValues: dims("2026-03-10", "Bad", "facebook", "cpc"), metricValues: mets(1, 0, 0) },
    ]);
    expect(n.rows).toEqual([{ campaignId: "ga4_spring-sale_meta_ads", date: "2026-03-10", impressions: 0, clicks: 150, spend: 0, conversions: 5, revenue: 250 }]);
    expect(n.campaigns[0]).toMatchObject({ name: "Spring Sale (GA4)", channel: "meta_ads", source: "ga4" });
    expect(n.skipped).toEqual({ no_campaign: 1, unmapped_source_medium: 1, invalid_row: 1 });
  });

  const creds = { propertyId: "properties/42", refreshToken: "RT", clientId: "cid", clientSecret: "csecret" };

  it("refreshes an access token from the stored refresh token, pages through runReport, and sends the right report", async () => {
    const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ dimensionValues: dims("20260310", `C${start + i}`, "google", "cpc"), metricValues: mets(1, 0, 0) }));
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { access_token: "AT" }))
      .mockResolvedValueOnce(res(200, { rows: page(10_000, 0), rowCount: 10_005 }))
      .mockResolvedValueOnce(res(200, { rows: page(5, 10_000), rowCount: 10_005 }));
    const out = await new Ga4Connector(creds, f as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" });
    expect(out.campaigns).toHaveLength(10_005);
    const [tokenUrl, tokenInit] = f.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams((tokenInit as RequestInit).body as URLSearchParams);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: "RT", client_id: "cid", client_secret: "csecret" });
    const [url, init] = f.mock.calls[1];
    expect(url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/42:runReport");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer AT" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.metrics.map((m: { name: string }) => m.name)).toEqual(["sessions", "keyEvents", "totalRevenue"]);
    expect(JSON.parse((f.mock.calls[2][1] as RequestInit).body as string).offset).toBe(10_000);
  });

  it("treats a revoked/expired grant as needs-reauth and a 403 as a permissions problem", async () => {
    const revoked = vi.fn().mockResolvedValue(res(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    await expect(new Ga4Connector(creds, revoked as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" })).rejects.toBeInstanceOf(ConnectorAuthError);
    const badClient = vi.fn().mockResolvedValue(res(401, { error: "invalid_client" }));
    const err = await new Ga4Connector(creds, badClient as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).not.toBeInstanceOf(ConnectorAuthError); // our config problem, not the user's
    const noAccess = vi.fn().mockResolvedValueOnce(res(200, { access_token: "AT" })).mockResolvedValueOnce(res(403, { error: { message: "User does not have sufficient permissions" } }));
    await expect(new Ga4Connector(creds, noAccess as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" })).rejects.toBeInstanceOf(ConnectorAuthError);
    await expect(new Ga4Connector({ ...creds, propertyId: "42/../x" }, vi.fn().mockResolvedValue(res(200, { access_token: "AT" })) as never, noSleep).fetch({ startDate: "2026-03-10", endDate: "2026-03-10" })).rejects.toThrow(/numeric/);
  });
});
