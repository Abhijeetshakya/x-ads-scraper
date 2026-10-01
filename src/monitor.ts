import type { Ad, Input, Logger, Query, Store } from './types.js';
import { normalize, SchemaTracker } from './normalize.js';
import { hash, stable } from './util.js';
import { monitorKey } from './input.js';

export interface Scope { userId: string; country: string; startDate: string; endDate: string; complete: boolean; runToken?: string }
export interface MonitorEntry {
  stateVersion: 2; adKey: string; contentHash: string;
  firstSeenAt: string; lastSeenAt: string; missCount: number; removed: boolean; lastAbsenceRun: string | null;
  material: Record<string, unknown>;
  identity: Pick<Ad, 'tweetId' | 'lineItemId' | 'country' | 'advertiser' | 'accountId' | 'adId' | 'source'>;
  metrics: { impressions: number | null; reach: number | null };
  scope: { startDate: string; endDate: string };
}
export interface StatePatch { shard: string; scopeKey: string; entry: MonitorEntry }
interface Shard { stateVersion: 2; entries: Record<string, MonitorEntry> }
export function material(ad: Ad): Record<string, unknown> {
  return { approvalStatus: ad.approvalStatus, isHalted: ad.isHalted,
    targeting: [...ad.targeting].sort((a, b) => stable(a).localeCompare(stable(b))), funding: ad.funding, advertiser: ad.advertiser,
    'creative.text': ad.creative.text, 'creative.landingUrl': ad.creative.landingUrl };
}
export function migrate(value: unknown): Shard {
  const data = value as { stateVersion?: number; entries?: Record<string, MonitorEntry> } | null;
  if (!data) return { stateVersion: 2, entries: {} };
  if ((data.stateVersion ?? 1) > 2) throw new Error('MONITOR_STATE_VERSION_UNSUPPORTED: state is newer than this Actor.');
  // v1 used the same minimal material snapshot but no removed flag.
  const entries = data.entries ?? {};
  for (const entry of Object.values(entries)) { entry.stateVersion = 2; entry.removed ??= false; entry.missCount ??= 0; }
  return { stateVersion: 2, entries };
}
export function metricChanged(old: number | null, current: number | null, threshold: number | null): boolean {
  if (threshold === null || old === null || current === null || old === current) return false;
  return old === 0 ? current > 0 : Math.abs(current - old) / old * 100 >= threshold;
}
export function diff(ad: Ad, old: MonitorEntry | undefined, input: Input, scope: Scope): { ad: Ad; entry: MonitorEntry } {
  const snapshot = material(ad); const contentHash = hash(stable(snapshot), 'sha256');
  ad.firstSeenAt = old?.firstSeenAt ?? ad.firstSeenAt;
  ad.changeStatus = old ? 'UNCHANGED' : 'NEW'; ad.changedFields = []; ad.previous = {};
  if (old) {
    for (const [field, value] of Object.entries(snapshot)) {
      // Transient enrichment must not convert a known creative to null and trigger a false change.
      if (value === null && field.startsWith('creative.') && ['error', 'rate_limited'].includes(ad.creative.enrichmentStatus)) { snapshot[field] = old.material[field]; continue; }
      if (stable(value) !== stable(old.material[field])) { ad.changedFields.push(field); ad.previous[field] = old.material[field]; }
    }
    for (const field of ['impressions', 'reach'] as const) if (metricChanged(old.metrics[field], ad[field], input.metricChangeThresholdPercent)) { ad.changedFields.push(field); ad.previous[field] = old.metrics[field]; }
    if (old.removed) { ad.changedFields.push('presence'); ad.previous.presence = false; }
    if (ad.changedFields.length) ad.changeStatus = 'CHANGED';
  }
  return { ad, entry: { stateVersion: 2, adKey: ad.adKey, contentHash: hash(stable(snapshot), 'sha256') || contentHash,
    firstSeenAt: ad.firstSeenAt, lastSeenAt: ad.scrapedAt, missCount: 0, removed: false, lastAbsenceRun: null,
    material: snapshot, identity: { tweetId: ad.tweetId, lineItemId: ad.lineItemId, country: ad.country, advertiser: ad.advertiser, accountId: ad.accountId, adId: ad.adId, source: ad.source },
    metrics: { impressions: ad.impressions, reach: ad.reach }, scope: { startDate: scope.startDate, endDate: scope.endDate } } };
}
export function absent(old: MonitorEntry, scope: Scope, grace: number): MonitorEntry | null {
  if (!scope.complete || old.removed || scope.runToken && old.lastAbsenceRun === scope.runToken) return null;
  // A rolling date window can exclude old ads. Only a search that covers the prior window proves absence.
  if (scope.startDate > old.scope.startDate || scope.endDate < old.scope.endDate) return null;
  return { ...old, lastAbsenceRun: scope.runToken ?? null, missCount: old.missCount + 1, removed: old.missCount + 1 >= grace };
}
export function removedRow(entry: MonitorEntry, query: Query, logger: Logger): Ad {
  const material = entry.material;
  const { ad } = normalize({ tweetId: entry.identity.tweetId, lineItemId: entry.identity.lineItemId,
    accountId: entry.identity.accountId, adId: entry.identity.adId, country: entry.identity.country,
    approvalStatus: material.approvalStatus, isHalted: material.isHalted, targeting: material.targeting,
    fundingInstrument: material.funding, creativeText: material['creative.text'], landingUrl: material['creative.landingUrl'],
  }, { ...query, advertiser: entry.identity.advertiser }, entry.identity.source.adapter, new SchemaTracker({ ...logger, warning() {} }));
  ad.funding = structuredClone(material.funding) as Ad['funding'];
  ad.changeStatus = 'REMOVED'; ad.changedFields = ['presence']; ad.previous = { presence: true, ...entry.metrics };
  ad.firstSeenAt = entry.firstSeenAt; ad.lastSeenAt = entry.lastSeenAt;
  ad.impressionsStatus = 'not_observed_in_removal_run'; ad.reachStatus = 'not_observed_in_removal_run';
  return ad;
}
export class Monitor {
  readonly key: string;
  private cache = new Map<string, Shard>();
  private leaseToken = hash(`${Date.now()}|${Math.random()}`);
  constructor(private store: Store, private input: Input, private logger: Logger) { this.key = monitorKey(input); }
  async acquire() {
    const key = `LEASE-${this.key}`;
    const old = await this.store.getValue<{ token: string; expires: number }>(key);
    if (old && old.expires > Date.now()) throw new Error('MONITOR_ALREADY_RUNNING: another run holds this monitor lease. Schedule runs sequentially.');
    await this.store.setValue(key, { token: this.leaseToken, expires: Date.now() + 2 * 3600000 });
    await this.assertLease();
    const metadataKey = `META-${this.key}`;
    const signature = hash(stable({ ...Object.fromEntries(Object.entries(this.input).filter(([k]) => ['advertisers', 'countries', 'keywords', 'excludeKeywords', 'keywordFields', 'keywordMatch', 'caseSensitive', 'targetedLocations', 'minImpressions', 'minReach', 'approvalStatuses', 'fundingTypes', 'mediaTypes', 'strictFilters', 'metricChangeThresholdPercent'].includes(k))) }), 'sha256');
    const meta = await this.store.getValue<{ signature: string }>(metadataKey);
    if (meta && meta.signature !== signature) { await this.release(); throw new Error('MONITOR_SCOPE_CHANGED: this monitorKey belongs to another filter/country scope. Use a new key.'); }
    await this.store.setValue(metadataKey, { stateVersion: 2, signature });
  }
  async assertLease() {
    const lease = await this.store.getValue<{ token: string }>(`LEASE-${this.key}`);
    if (lease?.token !== this.leaseToken) throw new Error('MONITOR_LEASE_LOST: refuse to overwrite another run’s monitor state.');
  }
  scopeKey(scope: Scope) { return `${this.key}-${scope.userId}-${scope.country}`; }
  shardKey(adKey: string, scope: Scope) { return `STATE-${this.scopeKey(scope)}-${adKey.slice(0, 2)}`; }
  private async load(shard: string) {
    if (!this.cache.has(shard)) {
      const directory = await this.store.getValue<{ pages: number }>(`${shard}-INDEX`);
      const values: Record<string, MonitorEntry> = {};
      if (directory) for (let i = 0; i < directory.pages; i++) Object.assign(values, migrate(await this.store.getValue(`${shard}-${i}`)).entries);
      else Object.assign(values, migrate(await this.store.getValue(shard)).entries);
      if (this.cache.size >= 4) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(shard, { stateVersion: 2, entries: values });
    }
    return this.cache.get(shard)!;
  }
  async compare(ad: Ad, scope: Scope) {
    const shard = this.shardKey(ad.adKey, scope); const state = await this.load(shard);
    const value = diff(ad, state.entries[ad.adKey], this.input, scope);
    return { ad: value.ad, patch: { shard, scopeKey: this.scopeKey(scope), entry: value.entry } satisfies StatePatch };
  }
  async apply(patch: StatePatch) {
    await this.assertLease();
    const state = await this.load(patch.shard); state.entries[patch.entry.adKey] = patch.entry;
    const entries = Object.entries(state.entries);
    // Bound each KVS record below 512 KB. Material snapshots are necessary for previous/changedFields.
    let page: [string, MonitorEntry][] = []; let pageNumber = 0; let size = 0;
    const write = async () => { await this.store.setValue(`${patch.shard}-${pageNumber++}`, { stateVersion: 2, entries: Object.fromEntries(page) }); page = []; size = 0; };
    for (const entry of entries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (bytes > 500000) throw new Error('MONITOR_ENTRY_TOO_LARGE: source material snapshot exceeds the state record limit.');
      if (size + bytes > 500000 && page.length) await write();
      page.push(entry); size += bytes;
    }
    if (page.length) await write();
    await this.store.setValue(`${patch.shard}-INDEX`, { stateVersion: 2, pages: pageNumber });
    const indexKey = `SHARDS-${patch.scopeKey}`;
    const shards = await this.store.getValue<string[]>(indexKey) ?? [];
    if (!shards.includes(patch.shard)) { shards.push(patch.shard); await this.store.setValue(indexKey, shards); }
  }
  async *removals(scope: Scope, query: Query, present: (key: string) => boolean): AsyncGenerator<{ ad: Ad | null; patch: StatePatch }> {
    if (!scope.complete) return;
    const shards = await this.store.getValue<string[]>(`SHARDS-${this.scopeKey(scope)}`) ?? [];
    for (const shard of shards) {
      const state = await this.load(shard);
      for (const old of Object.values(state.entries)) {
        if (present(old.adKey)) continue;
        const next = absent(old, scope, this.input.removalGraceRuns);
        if (!next) continue;
        yield { ad: next.removed ? removedRow(next, query, this.logger) : null, patch: { shard, scopeKey: this.scopeKey(scope), entry: next } };
      }
    }
  }
  async release() {
    const lease = await this.store.getValue<{ token: string }>(`LEASE-${this.key}`);
    if (lease?.token === this.leaseToken) await this.store.setValue(`LEASE-${this.key}`, null);
  }
}
