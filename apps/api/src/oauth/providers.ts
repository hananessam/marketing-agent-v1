import { googleAccessToken, GA_SCOPE, GOOGLE_TOKEN_URL, type GoogleClient } from "../connectors/google-auth";
import { ConnectorAuthError, ConnectorError, requestJson } from "../connectors/http";
import { META_API_VERSION } from "../connectors/meta";
import type { Provider } from "../connectors/types";

export type Account = { id: string; name: string };
export type Grant = { secret: Record<string, string>; config: Record<string, string> };

export interface OAuthProvider {
  readonly slug: "google" | "meta";
  readonly provider: Provider;
  readonly usesPkce: boolean;
  configured(): boolean;
  authUrl(p: { state: string; codeChallenge?: string }): string;
  exchangeCode(p: { code: string; codeVerifier?: string }): Promise<Grant>;
  listAccounts(secret: Record<string, string>): Promise<Account[]>;
}

type Deps = { fetchFn?: typeof fetch; sleep?: (ms: number) => Promise<void> };

export const redirectUri = (apiPublicUrl: string, slug: string) => `${apiPublicUrl.replace(/\/$/, "")}/connections/oauth/${slug}/callback`;

// ---------------------------------------------------------------- Google (GA4)

export class GoogleOAuth implements OAuthProvider {
  readonly slug = "google" as const;
  readonly provider = "ga4" as const;
  readonly usesPkce = true;
  constructor(private readonly cfg: { clientId?: string; clientSecret?: string; apiPublicUrl: string }, private readonly d: Deps = {}) {}

  configured() { return Boolean(this.cfg.clientId && this.cfg.clientSecret); }
  private client(): GoogleClient { return { clientId: this.cfg.clientId!, clientSecret: this.cfg.clientSecret! }; }

  authUrl({ state, codeChallenge }: { state: string; codeChallenge?: string }) {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId!, redirect_uri: redirectUri(this.cfg.apiPublicUrl, this.slug), response_type: "code",
      scope: GA_SCOPE,
      access_type: "offline", // we need a refresh token
      prompt: "consent", // Google only issues a refresh token on consent
      state, code_challenge: codeChallenge!, code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  async exchangeCode({ code, codeVerifier }: { code: string; codeVerifier?: string }): Promise<Grant> {
    const body = new URLSearchParams({
      grant_type: "authorization_code", code, client_id: this.cfg.clientId!, client_secret: this.cfg.clientSecret!,
      redirect_uri: redirectUri(this.cfg.apiPublicUrl, this.slug), code_verifier: codeVerifier ?? "",
    });
    const res = await requestJson(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { fetchFn: this.d.fetchFn, sleep: this.d.sleep });
    if (!res.ok) throw new ConnectorError(`Google rejected the authorization: ${res.json?.error ?? `HTTP ${res.status}`}`, res.status);
    // The user can untick scopes on the consent screen; make sure read access was actually granted.
    if (!String(res.json?.scope ?? "").split(" ").includes(GA_SCOPE)) throw new ConnectorError("Analytics read access was not granted");
    if (!res.json?.refresh_token) {
      throw new ConnectorError("Google did not return a refresh token. Remove this app at myaccount.google.com/permissions and connect again.");
    }
    return { secret: { refreshToken: res.json.refresh_token }, config: {} };
  }

  async listAccounts(secret: Record<string, string>): Promise<Account[]> {
    const token = await googleAccessToken(this.client(), secret.refreshToken, this.d.fetchFn, this.d.sleep);
    const out: Account[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
      const res = await requestJson(`https://analyticsadmin.googleapis.com/v1beta/accountSummaries?${q}`, { headers: { authorization: `Bearer ${token}` } }, { fetchFn: this.d.fetchFn, sleep: this.d.sleep });
      if (res.status === 401) throw new ConnectorAuthError("Google access was revoked. Please reconnect.");
      if (!res.ok) throw new ConnectorError(`Could not list GA4 properties: ${res.json?.error?.message ?? `HTTP ${res.status}`} (is the Google Analytics Admin API enabled?)`, res.status);
      for (const acc of res.json?.accountSummaries ?? [])
        for (const p of acc.propertySummaries ?? []) {
          const id = String(p.property ?? "").replace(/^properties\//, "");
          if (/^\d+$/.test(id)) out.push({ id, name: `${p.displayName ?? id} (${acc.displayName ?? "account"})` });
        }
      pageToken = res.json?.nextPageToken || undefined;
    } while (pageToken);
    return out;
  }
}

// ---------------------------------------------------------------- Meta

export class MetaOAuth implements OAuthProvider {
  readonly slug = "meta" as const;
  readonly provider = "meta_ads" as const;
  readonly usesPkce = false;
  constructor(private readonly cfg: { appId?: string; appSecret?: string; apiPublicUrl: string }, private readonly d: Deps = {}) {}

  configured() { return Boolean(this.cfg.appId && this.cfg.appSecret); }

  authUrl({ state }: { state: string }) {
    const p = new URLSearchParams({
      client_id: this.cfg.appId!, redirect_uri: redirectUri(this.cfg.apiPublicUrl, this.slug), state,
      response_type: "code", scope: "ads_read",
    });
    return `https://www.facebook.com/${META_API_VERSION}/dialog/oauth?${p}`;
  }

  private async tokenCall(params: Record<string, string>) {
    const q = new URLSearchParams({ client_id: this.cfg.appId!, client_secret: this.cfg.appSecret!, ...params });
    // Documented as a GET with the secret as a parameter; the URL is never logged or included in errors.
    const res = await requestJson(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${q}`, {}, { fetchFn: this.d.fetchFn, sleep: this.d.sleep });
    if (!res.ok || !res.json?.access_token) throw new ConnectorError(`Meta rejected the authorization: ${res.json?.error?.message ?? `HTTP ${res.status}`}`, res.status);
    return res.json as { access_token: string; expires_in?: number };
  }

  async exchangeCode({ code }: { code: string }): Promise<Grant> {
    const short = await this.tokenCall({ redirect_uri: redirectUri(this.cfg.apiPublicUrl, this.slug), code });
    // Upgrade the 1–2 hour token to the ~60 day one.
    const long = await this.tokenCall({ grant_type: "fb_exchange_token", fb_exchange_token: short.access_token });
    const expiresAt = long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : "";
    return { secret: { accessToken: long.access_token }, config: expiresAt ? { expiresAt } : {} };
  }

  async listAccounts(secret: Record<string, string>): Promise<Account[]> {
    const out: Account[] = [];
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ fields: "id,name", limit: "100", ...(after ? { after } : {}) });
      const res = await requestJson(`https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?${q}`, { headers: { authorization: `Bearer ${secret.accessToken}` } }, { fetchFn: this.d.fetchFn, sleep: this.d.sleep });
      if (!res.ok) {
        const e = res.json?.error;
        if (e?.code === 190 || res.status === 401) throw new ConnectorAuthError("Meta access expired. Please reconnect.");
        throw new ConnectorError(`Could not list ad accounts: ${e?.message ?? `HTTP ${res.status}`}`, res.status);
      }
      for (const a of res.json?.data ?? []) if (/^act_\d+$/.test(a.id ?? "")) out.push({ id: a.id, name: a.name ?? a.id });
      after = res.json?.paging?.next ? res.json?.paging?.cursors?.after : undefined;
    } while (after);
    return out;
  }
}

export function createProviders(env: NodeJS.ProcessEnv = process.env, d: Deps = {}): OAuthProvider[] {
  const apiPublicUrl = env.API_PUBLIC_URL ?? "http://localhost:4000";
  return [
    new GoogleOAuth({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, apiPublicUrl }, d),
    new MetaOAuth({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, apiPublicUrl }, d),
  ];
}
export const OAUTH_PROVIDERS = Symbol("OAUTH_PROVIDERS");
