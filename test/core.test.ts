import { uiOutcome } from '../src/adapters/ui.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { parseCsv, ExportAdapter } from '../src/adapters/export.js';
import { analyzeAssets } from '../src/adapters/discovery.js';
import { ApiAdapter } from '../src/adapters/api.js';
import { defaults, parseAdvertiser, parseDate, validateInput, chunks } from '../src/input.js';
import { Http, backoff, classify, privateIp, retryAfter } from '../src/http.js';
import { normalize, SchemaTracker } from '../src/normalize.js';
import { snowflake } from '../src/util.js';
import type { Progress } from '../src/types.js';
import { logger, query, sourceServer } from './mock.js';

afterEach(() => { delete process.env.XADS_TEST_MODE; });
describe('safe identities and input', () => {
  it('parses handles, profile URLs and numeric IDs without rounding', () => {
    expect([' @Nike ', 'https://twitter.com/Nike/', 'https://x.com/nike'].map(parseAdvertiser)).toEqual(['nike', 'nike', 'nike']);
    expect(parseAdvertiser('2105543067612639232')).toBe('2105543067612639232');
    expect(() => parseAdvertiser('https://x.com/nike/status/1')).toThrow();
    expect(() => parseAdvertiser('https://evil.com/nike')).toThrow();
  });
  it('validates dates, max advertisers, bounds and relative month clamping', () => {
    expect(parseDate('1 month', new Date('2026-03-31'))).toBe('2026-02-28');
    expect(() => parseDate('2026-02-30')).toThrow();
    expect(() => validateInput({ advertisers: Array(201).fill('nike') }, logger)).toThrow(/200/);
    expect(() => validateInput({ startDate: '2026-09-20', endDate: '2026-09-01' }, logger)).toThrow(/startDate/);
    expect(chunks('2026-01-01', '2026-04-01', 30)).toHaveLength(4);
  });
  it('converts a known Snowflake with BigInt arithmetic and rejects unsafe numeric values', () => {
    expect(snowflake('1346889436626259968')).toBe('2021-01-06T18:40:40.344Z');
    expect(snowflake('20')).toBeNull();
    expect(() => normalize({ tweetId: 2105543067612639232, lineItemId: 'l', country: 'FR' }, query, 'ui', new SchemaTracker(logger))).toThrow(/UNSAFE/);
  });
});
describe('CSV and normalization', () => {
  it('maps renamed/reordered headers and retains new columns', async () => {
    const rows = [];
    for await (const row of parseCsv(Readable.from(['Country Code,Post ID,Line Item Identifier,New Metric,Reach,Impression Count,Approval Status\nFR,1346889436626259968,l,secret-free,8,10,Verified\n']))) rows.push(row);
    const { ad } = normalize(rows[0], query, 'export', new SchemaTracker(logger));
    expect(ad.extra['New Metric']).toBe('secret-free'); expect(ad.impressions).toBe(10); expect(ad.tweetId).toBe('1346889436626259968');
    expect(ad.creative.assetCount).toBeNull(); expect(ad.availability['creative.assetCount']).toBe('not_disclosed');
  });
  it('parses empty and huge streams without collecting rows', async () => {
    let count = 0;
    for await (const _row of parseCsv(Readable.from(['']))) count++;
    expect(count).toBe(0);
    async function* fixture() { yield 'tweet_id,line_item_id,country\n'; for (let i = 0; i < 100000; i++) yield `1346889436626259968,line-${i},FR\n`; }
    for await (const row of parseCsv(Readable.from(fixture()))) { expect(typeof row.tweet_id).toBe('string'); count++; }
    expect(count).toBe(100000);
  }, 15000);
  it('quarantines missing identity and keeps unknown metrics null', () => {
    expect(() => normalize({ impressions: '1' }, query, 'export', new SchemaTracker(logger))).toThrow(/identity|tweetId/);
    const { ad } = normalize({ tweetId: '1346889436626259968', lineItemId: 'l', country: 'FR', impressions: '', reach: '0', approvalStatus: 'Halted' }, query, 'export', new SchemaTracker(logger));
    expect(ad.impressions).toBeNull(); expect(ad.reach).toBe(0); expect(ad.isHalted).toBe(true); expect(ad.deliveryStart).toBeNull();
  });
});
describe('adapter and transport contracts', () => {
  it('discovers operation IDs dynamically', () => {
    const d = analyzeAssets(['params:{id:"rotated_a",metadata:{},name:"CreateExportReportMutation"};params:{id:"rotated_b",metadata:{},name:"GetExportReportStatusQuery"}'], 'https://ads.x.com/ads-repository');
    expect(d.operations).toEqual({ create: 'rotated_a', status: 'rotated_b' });
  });
  it('resumes a saved exportId instead of submitting again', async () => {
    process.env.XADS_TEST_MODE = '1'; const server = await sourceServer(); const http = new Http(logger, 0, 0);
    const progress: Progress = { stateVersion: 1, inputHash: '', runToken: 'mock-run', jobs: { [query.key]: { pages: 0, exportId: 'job-1', submittedAt: new Date().toISOString() } }, phases: {}, charged: {} };
    const adapter = new ExportAdapter(http, { ...defaults, xBearerToken: 'mock-only' }, { countries: ['FR'], countriesVerified: true, earliestDate: '2023-08-26', operations: { create: 'mock_create', status: 'mock_status' }, pageUrl: server.url }, progress, async () => {}, async () => query.advertiser, logger, server.url);
    try { const result = adapter.search(query); let count = 0; for await (const _ of result.ads) count++; expect(count).toBe(3); expect(await result.outcome).toMatchObject({ status: 'complete' }); expect(server.submissions()).toBe(0); expect(server.polls()).toBe(1); }
    finally { await http.close(); await server.close(); }
  });
  it('keeps future API unavailable but passes server filters to an injected documented mock', async () => {
    const stub = new ApiAdapter(); expect(await stub.probe()).toBe(false); expect(await stub.search(query).outcome).toMatchObject({ status: 'failed' });
    let passed: unknown;
    const mock = new ApiAdapter({ documentedAt: 'mock documentation', capabilities: { keywordSearch: true, targetingSearch: true, creativeContent: true, landingUrls: true, multiCountryQueries: true }, async probe() { return true; }, async resolveAdvertiser() { return query.advertiser; }, search(q) { passed = q; return { ads: (async function* () { yield { tweetId: '1' }; })(), outcome: Promise.resolve({ status: 'complete', reason: null, rows: 1 }) }; } });
    const q = { ...query, keywords: ['cars'], targetedLocations: ['Paris'] }; mock.search(q); expect(passed).toEqual(q);
  });
  it('classifies capacity/auth errors and honors Retry-After and capped jitter', () => {
    expect(classify(429, '').retryable).toBe(true); expect(classify(200, 'Over capacity').retryable).toBe(true); expect(classify(401, '').retryable).toBe(false);
    expect(retryAfter('3')).toBe(3000); expect(retryAfter('Thu, 01 Oct 2026 00:00:03 GMT', Date.parse('2026-10-01T00:00:00Z'))).toBe(3000);
    expect(backoff(20, () => 1)).toBe(15000); expect(privateIp('::ffff:127.0.0.1')).toBe(true);
  });
});

it('never treats malformed, paginated or unverified UI results as a complete empty scope', () => {
  expect(uiOutcome({ error: 'failed', ads: [] }, 0).status).toBe('failed');
  expect(uiOutcome({ ads: [] }, 0).status).toBe('partial');
  expect(uiOutcome({ ads: [], complete: true }, 0).status).toBe('complete');
  expect(uiOutcome({ ads: [], complete: true, hasMore: true }, 0).status).toBe('partial');
});
