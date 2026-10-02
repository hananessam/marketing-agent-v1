export type Channel = "google_ads" | "meta_ads";
export type Provider = "meta_ads" | "ga4";
export type DateRange = { startDate: string; endDate: string };

export type MetricRow = {
  campaignId: string; // internal, deterministic per provider
  date: string;
  impressions: number; clicks: number; spend: number; conversions: number; revenue: number;
};
export type CampaignInfo = { id: string; name: string; channel: Channel; source: Provider };

export type ConnectorResult = {
  campaigns: CampaignInfo[];
  rows: MetricRow[];
  /** Rows dropped on purpose, grouped by reason, so a sync never silently loses data. */
  skipped: Record<string, number>;
};

export interface Connector {
  readonly provider: Provider;
  fetch(range: DateRange): Promise<ConnectorResult>;
}
