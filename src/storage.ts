import { DatabaseSync } from 'node:sqlite';
import type { Ad, Progress, Store } from './types.js';
import { mergeSameQuery, refreshAvailability } from './normalize.js';
import { record } from './util.js';

/** Disk-backed indices keep memory independent of CSV/dataset size. KVS pages are the durable authority. */
export class DiskIndex {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS observations(queryKey TEXT, adKey TEXT, data TEXT, PRIMARY KEY(queryKey,adKey));
      CREATE TABLE IF NOT EXISTS ads(adKey TEXT PRIMARY KEY, userId TEXT, country TEXT, impressions REAL, reach REAL, recency TEXT, advertiser TEXT, data TEXT);
      CREATE TABLE IF NOT EXISTS emitted(adKey TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE IF NOT EXISTS candidates(adKey TEXT PRIMARY KEY, userId TEXT, impressions REAL, reach REAL, recency TEXT, advertiser TEXT, data TEXT, patch TEXT);
      CREATE TABLE IF NOT EXISTS counters(userId TEXT PRIMARY KEY, count INTEGER);`);
  }
  observe(queryKey: string, ad: Ad) {
    const previous = this.db.prepare('SELECT data FROM observations WHERE queryKey=? AND adKey=?').get(queryKey, ad.adKey);
    const value = previous ? mergeSameQuery(JSON.parse(String(previous.data)), ad) : ad;
    this.db.prepare('INSERT OR REPLACE INTO observations VALUES (?,?,?)').run(queryKey, ad.adKey, JSON.stringify(value));
  }
  clearVolatile() { this.db.exec('DELETE FROM observations; DELETE FROM ads; DELETE FROM candidates; DELETE FROM emitted; DELETE FROM counters;'); }
  consolidate() {
    this.db.exec('DELETE FROM ads');
    const values = this.db.prepare('SELECT data FROM observations ORDER BY adKey,queryKey').iterate();
    let key: string | null = null; let records: Ad[] = [];
    const save = () => {
      if (!records.length) return;
      // Date chunks are disjoint. Latest chunk wins for material fields; unique reach is non-additive.
      records.sort((a, b) => String(record(a.extra._queryRange).endDate).localeCompare(String(record(b.extra._queryRange).endDate)));
      const ad = records.at(-1)!;
      ad.source.queryKeys = records.map(r => r.source.queryKey);
      if (records.length > 1) {
        const windowVerified = records.every(r => r.source.dateSemantics === 'verified_requested_range_metrics');
        ad.extra.chunkMetrics = records.map(r => ({ queryKey: r.source.queryKey, range: r.extra._queryRange, impressions: r.impressions, reach: r.reach }));
        ad.impressions = windowVerified && records.every(r => r.impressions !== null) ? records.reduce((s, r) => s + r.impressions!, 0) : null;
        ad.impressionsStatus = ad.impressions !== null ? 'sum_disjoint_query_chunks' : windowVerified ? 'incomplete_chunk_metrics' : 'cross_chunk_metric_scope_unverified';
        const reaches = records.map(r => r.reach).filter((n): n is number => n !== null);
        ad.reach = null; ad.reachStatus = 'non_additive_unique_reach_across_chunks';
        ad.reachLower = windowVerified && reaches.length ? Math.max(...reaches) : null;
        ad.reachUpper = windowVerified && reaches.length === records.length ? reaches.reduce((s, n) => s + n, 0) : null;
        const starts = records.map(r => r.deliveryStart).filter((s): s is string => !!s).sort();
        const ends = records.map(r => r.deliveryEnd).filter((s): s is string => !!s).sort();
        ad.deliveryStart = starts[0] ?? null; ad.deliveryEnd = ends.at(-1) ?? null;
        ad.daysActive = null; ad.daysActiveSource = 'continuity_between_chunks_not_disclosed';
        ad.extra.metricAggregation = windowVerified ? 'impressions summed across non-overlapping verified query windows; reach bounds represent possible unique union' : 'per-chunk metrics retained; date-window scope unverified so no aggregate guessed';
      }
      refreshAvailability(ad);
      this.db.prepare('INSERT INTO ads VALUES (?,?,?,?,?,?,?,?)').run(ad.adKey, ad.advertiser.userId, ad.country, ad.impressions, ad.reach, ad.deliveryStart ?? ad.adCreatedAt, ad.advertiser.handle ?? ad.advertiser.userId, JSON.stringify(ad));
    };
    for (const value of values) {
      const ad = JSON.parse(String(value.data)) as Ad;
      if (key !== ad.adKey) { save(); key = ad.adKey; records = []; }
      records.push(ad);
    }
    save();
  }
  *ads(): Generator<Ad> { for (const row of this.db.prepare('SELECT data FROM ads ORDER BY userId,country,adKey').iterate()) yield JSON.parse(String(row.data)); }
  hasAd(key: string) { return !!this.db.prepare('SELECT 1 FROM ads WHERE adKey=?').get(key); }
  isEmitted(key: string) { return !!this.db.prepare('SELECT 1 FROM emitted WHERE adKey=?').get(key); }
  markEmitted(ad: Ad) {
    const result = this.db.prepare('INSERT OR IGNORE INTO emitted VALUES (?,?)').run(ad.adKey, JSON.stringify(ad));
    if (!result.changes) return;
    this.db.prepare('INSERT INTO counters VALUES (?,1) ON CONFLICT(userId) DO UPDATE SET count=count+1').run(ad.advertiser.userId);
  }
  emittedCount() { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM emitted').get()!.n); }
  advertiserCount(userId: string) { return Number(this.db.prepare('SELECT count FROM counters WHERE userId=?').get(userId)?.count ?? 0); }
  candidate(ad: Ad, patch: unknown = null) { this.db.prepare('INSERT OR REPLACE INTO candidates VALUES (?,?,?,?,?,?,?,?)').run(ad.adKey, ad.advertiser.userId, ad.impressions, ad.reach, ad.deliveryStart ?? ad.adCreatedAt, ad.advertiser.handle ?? ad.advertiser.userId, JSON.stringify(ad), JSON.stringify(patch)); }
  *candidates(sort: string): Generator<{ ad: Ad; patch: unknown }> {
    const order = ({ impressions: 'impressions DESC NULLS LAST', reach: 'reach DESC NULLS LAST', recency: 'recency DESC NULLS LAST', advertiser: 'advertiser ASC' } as Record<string, string>)[sort] ?? 'adKey';
    for (const row of this.db.prepare(`SELECT data,patch FROM candidates ORDER BY ${order},adKey`).iterate()) yield { ad: JSON.parse(String(row.data)), patch: JSON.parse(String(row.patch)) };
  }
  *emitted(): Generator<Ad> { for (const row of this.db.prepare('SELECT data FROM emitted ORDER BY rowid').iterate()) yield JSON.parse(String(row.data)); }
  close() { this.db.close(); }
}
export async function restorePages(store: Store, progress: Progress, index: DiskIndex) {
  for (const [queryKey, job] of Object.entries(progress.jobs)) for (let page = 0; page < job.pages; page++) {
    const ads = await store.getValue<Ad[]>(`STAGE-${queryKey}-${page}`);
    if (!ads) throw new Error('MISSING_DURABLE_STAGE_PAGE: cannot safely resume with missing progress data.');
    for (const ad of ads) index.observe(queryKey, ad);
  }
}
export async function savePage(store: Store, progress: Progress, queryKey: string, page: number, ads: Ad[], persist: () => Promise<void>) {
  await store.setValue(`STAGE-${queryKey}-${page}`, ads);
  const job = progress.jobs[queryKey] ??= { pages: 0 };
  job.pages = Math.max(job.pages, page + 1); await persist();
}
