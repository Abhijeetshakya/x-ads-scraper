import { describe, expect, it } from 'vitest';
import { FilterEngine, fold } from '../src/filters.js';
import { defaults } from '../src/input.js';
import { absent, diff, migrate, Monitor, type Scope } from '../src/monitor.js';
import { parseOembed, cacheValid } from '../src/enrichment.js';
import { ad, logger, MemoryStore, query } from './mock.js';

describe('Unicode, phrases and safe regex filters', () => {
  it('folds diacritics, compatibility characters and European cases', () => {
    expect(fold('CAFÉ Straße Łódź')).toContain('cafe strasse');
    const item = ad(); item.creative.text = 'Un CAFÉ à Paris — free shipping';
    const filter = new FilterEngine({ ...defaults, keywords: ['cafe', '"free shipping"', '/paris/'], keywordFields: ['creativeText'], keywordMatch: 'all' });
    expect(filter.match(item)).toBe(true); expect(item.matchedKeywords).toHaveLength(3); expect(item.matchedFields).toEqual(['creativeText']);
  });
  it('supports any/all, case sensitivity, exclusion and unknown-field strictness', () => {
    const item = ad(); item.creative.text = 'New electric cars';
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['cars', 'boats'] }).match(item)).toBe(true);
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['cars', 'boats'], keywordMatch: 'all' }).match(item)).toBe(false);
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['cars'], excludeKeywords: ['/electric/'] }).match(item)).toBe(false);
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['CARS'], caseSensitive: true }).match(item)).toBe(false);
    item.creative.text = null;
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['cars'] }).match(item)).toBe(true); expect(item.filterUncertain).toBe(true);
    expect(new FilterEngine({ ...defaults, keywordFields: ['creativeText'], keywords: ['cars'], strictFilters: true }).match(item)).toBe(false);
    expect(() => new FilterEngine({ ...defaults, keywords: ['/([a-z]+)\\1/'] })).toThrow(/RE2/);
  });
  it('does not confuse served country and disclosed geo-targeting', () => {
    const item = ad(); item.targetedLocations = ['Paris']; item.targetedLocationsStatus = 'repository';
    expect(new FilterEngine({ ...defaults, targetedLocations: ['Paris'] }).match(item)).toBe(true);
    expect(new FilterEngine({ ...defaults, targetedLocations: ['France'] }).match(item)).toBe(false);
  });
});
describe('monitor campaign lifecycle', () => {
  const scope: Scope = { userId: query.advertiser.userId, country: 'FR', startDate: query.startDate, endDate: query.endDate, complete: true };
  it('NEW → UNCHANGED → CHANGED → REMOVED after grace; default metric growth is ignored', () => {
    const input = { ...defaults, mode: 'monitor' as const };
    const first = diff(ad(), undefined, input, scope); expect(first.ad.changeStatus).toBe('NEW');
    const second = diff(ad({ impressions: 500 }), first.entry, input, scope); expect(second.ad.changeStatus).toBe('UNCHANGED');
    const third = diff(ad({ approvalStatus: 'Halted' }), second.entry, input, scope); expect(third.ad.changeStatus).toBe('CHANGED'); expect(third.ad.changedFields).toContain('approvalStatus'); expect(third.ad.previous.approvalStatus).toBe('Verified');
    const miss = absent(third.entry, { ...scope, runToken: 'r4' }, 2)!; expect(miss.removed).toBe(false);
    expect(absent(miss, { ...scope, runToken: 'r4' }, 2)).toBeNull(); // Resuming the same run cannot count twice.
    expect(absent(miss, { ...scope, runToken: 'r5' }, 2)!.removed).toBe(true);
    expect(absent(third.entry, { ...scope, complete: false }, 2)).toBeNull();
  });
  it('never removes on partial/failed scope or a shrinking/rolling date window', () => {
    const entry = diff(ad(), undefined, defaults, scope).entry;
    expect(absent(entry, { ...scope, complete: false }, 1)).toBeNull();
    expect(absent(entry, { ...scope, startDate: '2026-09-02' }, 1)).toBeNull();
  });
  it('includes metric changes only when requested and migrates versioned shards', () => {
    const entry = diff(ad(), undefined, defaults, scope).entry;
    expect(diff(ad({ impressions: 130 }), entry, { ...defaults, metricChangeThresholdPercent: 20 }, scope).ad.changedFields).toContain('impressions');
    expect(migrate({ stateVersion: 1, entries: { [entry.adKey]: entry } }).stateVersion).toBe(2);
    expect(() => migrate({ stateVersion: 999 })).toThrow(/newer/);
  });
  it('persists minimal sharded state and lists removals only after complete queries', async () => {
    const store = new MemoryStore(); const monitor = new Monitor(store, { ...defaults, mode: 'monitor', advertisers: ['nike'], countries: ['FR'], removalGraceRuns: 1 }, logger);
    await monitor.acquire();
    const first = await monitor.compare(ad(), scope); await monitor.apply(first.patch);
    const removed = []; for await (const change of monitor.removals(scope, query, () => false)) removed.push(change);
    expect(removed).toHaveLength(1); expect(removed[0].ad?.changeStatus).toBe('REMOVED'); expect(removed[0].ad?.impressions).toBeNull();
    const partial = []; for await (const change of monitor.removals({ ...scope, complete: false }, query, () => false)) partial.push(change); expect(partial).toEqual([]);
    await monitor.release();
  });
});
describe('public oEmbed enrichment', () => {
  it('extracts only post text/author/links and leaves incomplete asset count unknown', () => {
    const parsed = parseOembed({ author_name: 'Public advertiser', html: '<blockquote><p>Café<br>#Offers @Nike <a href="https://t.co/test">link</a></p><footer>metadata date</footer></blockquote><script>evil()</script>' });
    expect(parsed.text).toBe('Café\n#Offers @Nike link'); expect(parsed.links).toEqual(['https://t.co/test']); expect(parsed.assets).toEqual([]);
    const item = ad(); expect(cacheValid({ creative: item.creative, cachedAt: new Date().toISOString() })).toBe(true);
    item.creative.enrichmentStatus = 'rate_limited'; expect(cacheValid({ creative: item.creative, cachedAt: new Date().toISOString() })).toBe(false);
  });
});
