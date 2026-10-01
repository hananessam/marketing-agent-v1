import { decryptSecret } from "./crypto";
import { Ga4Connector } from "./ga4";
import { MetaConnector } from "./meta";
import type { Connector, Provider } from "./types";

export type ConnectionRow = { provider: Provider; accountId: string; encryptedSecret: string; config: Record<string, string> };
export type ConnectorFactory = (conn: ConnectionRow) => Connector;
export const CONNECTOR_FACTORY = Symbol("CONNECTOR_FACTORY");

export const buildConnector: ConnectorFactory = (conn) => {
  const secret = decryptSecret<{ accessToken?: string; refreshToken?: string }>(conn.encryptedSecret);
  if (conn.provider === "meta_ads") {
    if (!secret.accessToken) throw new Error("Stored Meta connection has no access token");
    return new MetaConnector({ accessToken: secret.accessToken, adAccountId: conn.accountId, conversionAction: conn.config.conversionAction });
  }
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret || !secret.refreshToken) throw new Error("Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  return new Ga4Connector({ propertyId: conn.accountId, refreshToken: secret.refreshToken, clientId, clientSecret });
};
