import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserUi, UiAdapter } from '../src/adapters/ui.js';
import { defaults } from '../src/input.js';
import type { Discovery } from '../src/adapters/discovery.js';
import type { Query, RecordData } from '../src/types.js';
import { logger } from './mock.js';

const requests: RecordData[] = [];
let failures = 0;
let status = 200;
let payload: RecordData = { ads: [{ tweetId: '1346889436626259968', lineItemId: 'line-1', country: 'FR', impressions: 10, reach: 8, approvalStatus: 'Verified' }] };
let browser: BrowserUi;
let discovery: Discovery;
const fixture = await readFile(new URL('./fixtures/public-ui.html', import.meta.url), 'utf8');
const server = createServer(async (req, res) => {
  if (req.url === '/ads-repository') { res.setHeader('content-type', 'text/html'); res.end(fixture); return; }
  if (req.url === '/fixture.js') {
    res.setHeader('content-type', 'application/javascript');
    res.end('var Y={Austria:"AT",Belgium:"BE",France:"FR",CzechRepublic:"CZ"}; Object.freeze([{displayValue:"Austria",systemValue:Y.Austria},{displayValue:"Belgium",systemValue:Y.Belgium},{displayValue:"France",systemValue:Y.France},{displayValue:"Czech Republic",systemValue:Y.CzechRepublic}]); new Date("2023-08-26"); "/ads-repository/api/user-search"; "/ads-repository/api/ads-search";'); return;
  }
  let body = ''; for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url?.endsWith('user-search')) { res.end(JSON.stringify({ id_str: '415859364', screen_name: 'Nike', name: 'Nike' })); return; }
  if (req.url?.endsWith('ads-search')) {
    requests.push(JSON.parse(body));
    const code = failures-- > 0 ? 503 : status; res.statusCode = code;
    res.end(JSON.stringify(code === 200 ? payload : { errors: [{ message: 'Over capacity', code: 130 }] })); return;
  }
  res.statusCode = 404; res.end('{}');
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test server');
  discovery = { pageUrl: `http://127.0.0.1:${address.port}/ads-repository`, countries: ['AT', 'BE', 'FR', 'CZ'], countriesVerified: true, earliestDate: '2023-08-26', operations: {}, uiUserPath: '/ads-repository/api/user-search', uiSearchPath: '/ads-repository/api/ads-search' };
  browser = new BrowserUi(discovery, logger, undefined, 1);
}, 30000);
async function runCli() {
  const directory = await mkdtemp(join(tmpdir(), 'xads-browser-cli-'));
  const input = { advertisers: ['Nike'], countries: ['FR'], startDate: '2025-09-01', endDate: '2025-09-02', sourceMode: 'ui', enablePublicUiTransport: false, maxRetries: 0, requestDelayMs: 0, enrichCreatives: false, keywordFields: ['advertiser'], exportFormats: ['csv', 'json', 'xlsx', 'html'] };
  const result = await new Promise<{ code: number; output: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/.bin/apify'), 'run', '--input', JSON.stringify(input)], {
      env: { ...process.env, APIFY_CLI_DISABLE_TELEMETRY: '1', DISABLE_METERING: '1', XADS_TEST_MODE: '1', XADS_TEST_BASE_URL: new URL(discovery.pageUrl).origin, APIFY_LOCAL_STORAGE_DIR: relative(process.cwd(), directory), APIFY_STORAGE_DIR: relative(process.cwd(), directory) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    child.on('error', reject); child.on('close', code => done({ code: code ?? 1, output }));
  });
  return { ...result, directory, summary: JSON.parse(await readFile(join(directory, 'key_value_stores/default/SUMMARY.json'), 'utf8')) };
}
it('runs the browser path through Apify CLI and writes real report files from fixture rows', async () => {
  const run = await runCli(); expect(run.code, run.output).toBe(0);
  expect(run.summary).toMatchObject({ totalAds: 1, adapterUsed: 'ui', partialQueries: 1 });
  for (const name of ['ads.csv', 'ads.json', 'ads.xlsx', 'report.html']) expect((await readFile(join(run.directory, 'key_value_stores/default', name))).length).toBeGreaterThan(0);
}, 60000);
it('persists the upstream error through Apify CLI instead of claiming a successful empty run', async () => {
  status = 503;
  try {
    const run = await runCli(); expect(run.code).not.toBe(0);
    expect(run.output).toContain('SOURCE_BUSY'); expect(run.output).toContain('503');
    expect(run.summary).toMatchObject({ totalAds: 0, status: 'failed' });
    const errors = JSON.parse(await readFile(join(run.directory, 'key_value_stores/default/ERRORS.json'), 'utf8'));
    expect(errors[0]).toMatchObject({ errorClass: 'SOURCE_BUSY', retryable: true, reason: expect.stringContaining('503') });
  } finally { status = 200; }
}, 60000);
afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
const query = (startDate: string, endDate: string, countries = ['FR']): Query => ({ key: `${startDate}|${countries.join()}`, advertiser: { userId: '415859364', handle: 'Nike', name: 'Nike', profileUrl: 'https://x.com/Nike' }, countries, startDate, endDate, keywords: [], targetedLocations: [] });

it('submits exact multi-country scope and exclusive end through the actual browser controls', async () => {
  const data = await browser.search(query('2025-12-03', '2026-01-07', ['BE', 'CZ']));
  expect(data.ads).toHaveLength(1);
  expect(requests.at(-1)).toEqual({ userId: 415859364, countries: ['BE', 'CZ'], startDate: '2025-12-03', endDate: '2026-01-08' });
}, 30000);
it('handles single-month and same-day ranges, including the current month', async () => {
  const month = new Date().toISOString().slice(0, 7);
  for (const [start, end] of [['2025-09-01', '2025-09-30'], [`${month}-01`, `${month}-01`]]) {
    await browser.search(query(start, end));
    const exclusive = new Date(end); exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    expect(requests.at(-1)).toMatchObject({ startDate: start, endDate: exclusive.toISOString().slice(0, 10), countries: ['FR'] });
  }
}, 30000);
it('supports Entire EU and concurrent queries without mixing page scopes', async () => {
  await Promise.all([browser.search(query('2025-07-01', '2025-08-01', discovery.countries)), browser.search(query('2025-09-01', '2025-09-02', ['AT']))]);
  expect(requests.slice(-2).map(r => r.countries).sort()).toEqual([['AT'], ['FR', 'AT', 'BE', 'CZ']].sort());
}, 30000);
it('retries a capacity error and never interprets the page empty-state as success', async () => {
  failures = 1; const before = requests.length;
  expect((await browser.search(query('2025-09-01', '2025-09-02'))).ads).toHaveLength(1);
  expect(requests.length - before).toBe(2);
  status = 503;
  try {
    const adapter = new UiAdapter({ ...defaults, enablePublicUiTransport: false }, browser, browser, logger);
    expect(await adapter.probe()).toBe(true);
    const result = adapter.search(query('2025-09-01', '2025-09-02')); const rows = [];
    for await (const row of result.ads) rows.push(row);
    expect(rows).toEqual([]);
    expect(await result.outcome).toMatchObject({ status: 'failed', reason: 'SOURCE_BUSY', retryable: true, details: expect.stringContaining('503') });
  } finally { status = 200; }
}, 30000);
it('rejects malformed successful responses instead of reporting empty ads', async () => {
  const original = payload; payload = { unexpected: [] };
  try {
    const adapter = new UiAdapter({ ...defaults, enablePublicUiTransport: false }, browser, browser, logger); await adapter.probe();
    const result = adapter.search(query('2025-09-01', '2025-09-02')); for await (const _ of result.ads) { /* drain */ }
    expect(await result.outcome).toMatchObject({ status: 'failed', reason: 'INVALID_UI_RESPONSE' });
  } finally { payload = original; }
}, 30000);
