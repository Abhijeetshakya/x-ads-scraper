import { SourceError } from '../http.js';
import type { SourceAdapter, Capabilities, Query, SearchResult, Advertiser } from '../types.js';

/** A documented future API client must be implemented explicitly, never inferred from a URL. */
export interface RepositoryApiClient {
  documentedAt: string;
  capabilities: Capabilities;
  probe(): Promise<boolean>;
  resolveAdvertiser(value: string): Promise<Advertiser>;
  search(query: Query): SearchResult;
}
export class ApiAdapter implements SourceAdapter {
  readonly name = 'api';
  constructor(private client?: RepositoryApiClient) {}
  capabilities(): Capabilities { return this.client?.capabilities ?? { keywordSearch: false, targetingSearch: false, creativeContent: false, landingUrls: false, multiCountryQueries: false }; }
  async probe() { return this.client ? this.client.probe() : false; }
  async resolveAdvertiser(value: string) {
    if (!this.client) throw new SourceError('API_NOT_DOCUMENTED', 'No new documented repository API has been verified. Use auto, ui, or the documented export flow.');
    return this.client.resolveAdvertiser(value);
  }
  search(query: Query): SearchResult {
    if (!this.client) return { ads: (async function* () {})(), outcome: Promise.resolve({ status: 'failed', reason: 'API_NOT_DOCUMENTED', rows: 0 }) };
    return this.client.search(query); // Full query includes content/targeting for server-side filtering.
  }
  async close() {}
}
