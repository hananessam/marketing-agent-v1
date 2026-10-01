import { ConnectorAuthError, ConnectorError, requestJson } from "./http";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export type GoogleClient = { clientId: string; clientSecret: string };

/** Trade a stored refresh token for a short-lived access token. A revoked/expired grant means the user must reconnect. */
export async function googleAccessToken(client: GoogleClient, refreshToken: string, fetchFn: typeof fetch = fetch, sleep?: (ms: number) => Promise<void>): Promise<string> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret });
  const res = await requestJson(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }, { fetchFn, sleep });
  if (res.ok && res.json?.access_token) return res.json.access_token as string;
  // invalid_grant = revoked, expired (Testing-mode 7 days), or password change; invalid_client = our own misconfiguration.
  if (res.json?.error === "invalid_grant") throw new ConnectorAuthError("Google access was revoked or expired. Please reconnect Google Analytics.");
  throw new ConnectorError(`Google token refresh failed: ${res.json?.error ?? `HTTP ${res.status}`}`, res.status);
}
