export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordData = Record<string, unknown>;
export interface Logger {
  info(message: string, data?: RecordData): void;
  warning(message: string, data?: RecordData): void;
  error(message: string, data?: RecordData): void;
}
export interface Store {
  getValue<T>(key: string): Promise<T | null>;
  setValue(key: string, value: unknown, options?: { contentType?: string }): Promise<void>;
}
export interface Advertiser {
  handle: string | null; userId: string; name: string | null; profileUrl: string | null;
}
export interface Capabilities {
  keywordSearch: boolean; targetingSearch: boolean; creativeContent: boolean;
  landingUrls: boolean; multiCountryQueries: boolean;
}
export interface Query {
  key: string; advertiser: Advertiser; countries: string[]; startDate: string; endDate: string;
  keywords: string[]; targetedLocations: string[];
}
export interface QueryOutcome {
  status: 'complete' | 'partial' | 'failed'; reason: string | null;
  rows: number; retryable?: boolean;
}
export interface SearchResult {
  ads: AsyncIterable<RecordData>;
  /** Resolved after the ads iterable is exhausted (including error handling). */
  outcome: Promise<QueryOutcome>;
}
export interface SourceAdapter {
  readonly name: string;
  capabilities(): Capabilities;
  probe(): Promise<boolean>;
  resolveAdvertiser(value: string): Promise<Advertiser>;
  search(query: Query): SearchResult;
  close(): Promise<void>;
}
export interface Input {
  advertisers: string[]; countries: string[]; marketPreset: string;
  startDate: string; endDate: string;
  keywords: string[]; excludeKeywords: string[]; keywordMatch: 'any' | 'all';
  keywordFields: ('creativeText' | 'advertiser' | 'targeting' | 'landingUrl')[];
  caseSensitive: boolean; targetedLocations: string[];
  minImpressions: number | null; minReach: number | null;
  approvalStatuses: string[]; fundingTypes: string[]; mediaTypes: string[]; strictFilters: boolean;
  enrichCreatives: boolean; resolveLandingUrls: boolean; lookupMedia: boolean; xBearerToken?: string;
  mode: 'snapshot' | 'monitor'; monitorKey?: string; notifyOn: string[];
  removalGraceRuns: number; metricChangeThresholdPercent: number | null;
  webhookUrl?: string; webhookSecret?: string; slackWebhookUrl?: string; discordWebhookUrl?: string;
  notifyMaxItems: number; notifyOnEmpty: boolean;
  exportFormats: string[]; includeRaw: boolean; sortBy: 'impressions' | 'reach' | 'recency' | 'advertiser';
  maxAdsPerAdvertiser: number | null; maxItems: number | null;
  sourceMode: 'auto' | 'export' | 'api' | 'ui'; concurrency: number;
  requestDelayMs: number; maxRetries: number; jobTimeoutMinutes: number; maxExportJobs: number;
  proxyConfiguration: { useApifyProxy?: boolean; apifyProxyGroups?: string[]; proxyUrls?: string[] };
  enablePublicUiTransport: boolean;
  operationIds?: { create?: string; status?: string };
  monitorStoreName: string;
}
export interface Target { type: string | null; name: string | null; included: boolean | null }
export interface Asset {
  type: string | null; url: string | null; width: number | null; height: number | null; durationMs: number | null;
}
export interface Creative {
  text: string | null; textSource: string; authorName: string | null; authorNameSource: string;
  mediaType: string; mediaTypeSource: string; assetCount: number | null; assetCountSource: string;
  assets: Asset[]; hashtags: string[]; mentions: string[];
  landingUrl: string | null; landingUrlStatus: string; landingDomain: string | null; landingDomainSource: string;
  utm: Record<string, string>; enrichmentStatus: 'ok' | 'not_attempted' | 'deleted_or_unavailable' | 'protected' | 'rate_limited' | 'error';
}
export interface Ad {
  adKey: string; adId: string; adIdSource: string; tweetId: string; lineItemId: string;
  accountId: string | null; adName: string; adNameSource: string; adUrl: string;
  advertiser: Advertiser;
  adCreatedAt: string | null; adCreatedAtSource: string;
  deliveryStart: string | null; deliveryStartSource: string;
  deliveryEnd: string | null; deliveryEndSource: string;
  daysActive: number | null; daysActiveSource: string;
  firstSeenAt: string; lastSeenAt: string; scrapedAt: string;
  country: string; countryName: string | null; countryNameSource: string;
  targetedLocations: string[]; targetedLocationsStatus: string;
  targeting: Target[]; targetingStatus: string; targetingSummary: string;
  impressions: number | null; impressionsStatus: string;
  reach: number | null; reachStatus: string;
  impressionsLower: number | null; impressionsUpper: number | null;
  reachLower: number | null; reachUpper: number | null;
  funding: { instrumentType: string | null; currency: string | null; entity: string | null };
  fundingStatus: string; approvalStatus: string | null; approvalStatusSource: string;
  isHalted: boolean | null; isHaltedSource: string;
  creative: Creative;
  changeStatus: 'NEW' | 'CHANGED' | 'UNCHANGED' | 'REMOVED'; changedFields: string[];
  previous: Record<string, unknown>; matchedKeywords: string[]; matchedFields: string[]; filterUncertain: boolean;
  source: { adapter: string; queryKey: string; queryKeys: string[]; dateSemantics: string };
  schemaVersion: string; extra: RecordData; raw?: RecordData;
  /** Per-field reasons for nulls, including nested targeting/media properties. */
  availability: Record<string, string>;
}
export interface JobProgress {
  exportId?: string; submittedAt?: string; status?: string; downloadUrl?: string;
  pages: number; outcome?: QueryOutcome;
}
export interface Progress {
  stateVersion: number; inputHash: string; runToken: string; jobs: Record<string, JobProgress>;
  phases: { queriesDone?: boolean; outputDone?: boolean; notified?: boolean };
  charged: Record<string, number>;
}
export interface RunError {
  queryKey: string | null; advertiser: string | null; countries: string[]; chunk: string[];
  errorClass: string; reason: string; retryable: boolean;
}
