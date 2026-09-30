import { decryptSecret } from "./crypto";
import { Ga4Connector, type Ga4Credentials } from "./ga4";
import { MetaConnector, type MetaCredentials } from "./meta";
import type { Connector, Provider } from "./types";

export type ConnectionRow = { provider: Provider; accountId: string; encryptedSecret: string; config: Record<string, string> };
export type ConnectorFactory = (conn: ConnectionRow) => Connector;
export const CONNECTOR_FACTORY = Symbol("CONNECTOR_FACTORY");

export const buildConnector: ConnectorFactory = (conn) => {
  const secret = decryptSecret<Record<string, unknown>>(conn.encryptedSecret);
  if (conn.provider === "meta_ads") {
    return new MetaConnector({ ...(secret as Pick<MetaCredentials, "accessToken">), adAccountId: conn.accountId, conversionAction: conn.config.conversionAction });
  }
  return new Ga4Connector({ propertyId: conn.accountId, serviceAccount: secret.serviceAccount as Ga4Credentials["serviceAccount"] });
};
