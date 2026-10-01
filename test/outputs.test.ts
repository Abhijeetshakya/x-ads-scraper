import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Actor } from 'apify';
import { generateExports, analyze, columns } from '../src/exports.js';
import { notify } from '../src/notifications.js';
import { Http } from '../src/http.js';
import { defaults } from '../src/input.js';
import { Metering } from '../src/metering.js';
import { DiskIndex } from '../src/storage.js';
import { ad, logger, server, MemoryStore } from './mock.js';

it('verifies all four exports, safe text, Excel dates, hyperlinks and five sheets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xads-output-'));
  const item = ad(); item.adName = '=HYPERLINK("bad")'; item.creative.text = '<script>alert("bad")</script>&';
  const rows = () => [item];
  const files = await generateExports(directory, ['csv', 'json', 'xlsx', 'html'], rows, { example: true });
  expect(files).toHaveLength(4);
  const csv = await readFile(join(directory, 'ads.csv'), 'utf8'); expect(csv.charCodeAt(0)).toBe(0xfeff); expect(csv).toContain("'=HYPERLINK");
  const json = JSON.parse(await readFile(join(directory, 'ads.json'), 'utf8')); expect(json[0].tweetId).toBe(item.tweetId); expect(json[0].creative.assetCount).toBeNull();
  const html = await readFile(join(directory, 'report.html'), 'utf8'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>alert'); expect(html).not.toMatch(/src="https?:/);
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(join(directory, 'ads.xlsx'));
  expect(book.worksheets.map(s => s.name).sort()).toEqual(['Ads', 'Advertisers', 'Changes', 'Countries', 'Summary']);
  const sheet = book.getWorksheet('Ads')!; expect(sheet.views[0].state).toBe('frozen'); expect(sheet.autoFilter).toBeTruthy();
  expect(sheet.getRow(2).getCell(columns.indexOf('adCreatedAt') + 1).value).toBeInstanceOf(Date);
  expect(sheet.getRow(2).getCell(columns.indexOf('adUrl') + 1).value).toMatchObject({ hyperlink: item.adUrl });
  expect(sheet.getRow(2).getCell(columns.indexOf('tweetId') + 1).value).toBe(item.tweetId);
  expect(analyze(rows).totals.impressions).toBe(100);
});

it('sends signed full webhook and native Slack/Discord digests with retry against a local server', async () => {
  vi.stubEnv('XADS_TEST_MODE', '1');
  const received: { path: string; body: string; signature: string | undefined }[] = [];
  let attempts = 0;
  const mock = await server((req, res, body) => {
    if (req.url === '/generic' && attempts++ === 0) { res.statusCode = 429; res.setHeader('retry-after', '0'); res.end('retry'); return; }
    received.push({ path: req.url!, body, signature: req.headers['x-x-ads-signature'] as string | undefined }); res.end('ok');
  });
  const http = new Http(logger, 2, 0, undefined, async () => {});
  try {
    const directory = await mkdtemp(join(tmpdir(), 'xads-notify-'));
    const input = { ...defaults, webhookUrl: `${mock.url}/generic`, webhookSecret: 'local-test-secret', slackWebhookUrl: `${mock.url}/slack`, discordWebhookUrl: `${mock.url}/discord` };
    const item = ad(); item.changeStatus = 'NEW';
    const result = await notify(directory, () => [item], input, 'mock-run', http, logger);
    expect(result.map(r => r.status)).toEqual(['sent', 'sent', 'sent']); expect(attempts).toBe(2);
    const generic = received.find(r => r.path === '/generic')!;
    expect(generic.signature).toBe(`sha256=${createHmac('sha256', input.webhookSecret).update(generic.body).digest('hex')}`);
    expect(JSON.parse(generic.body).ads).toHaveLength(1);
    expect(JSON.parse(received.find(r => r.path === '/slack')!.body).blocks[0].type).toBe('header');
    expect(JSON.parse(received.find(r => r.path === '/discord')!.body).allowed_mentions.parse).toEqual([]);
  } finally { await http.close(); await mock.close(); vi.unstubAllEnvs(); }
});

it('metering respects budget and never charges the same saved row twice', async () => {
  vi.stubEnv('DISABLE_METERING', '0');
  const charge = vi.spyOn(Actor, 'charge').mockResolvedValue({ chargedCount: 1, eventChargeLimitReached: true } as Awaited<ReturnType<typeof Actor.charge>>);
  const manager = vi.spyOn(Actor, 'getChargingManager').mockReturnValue({ getPricingInfo: () => ({ isPayPerEvent: true }), calculateMaxEventChargeCountWithinLimit: () => 1, getChargedEventCount: () => 1 } as unknown as ReturnType<typeof Actor.getChargingManager>);
  try {
    const meter = new Metering({ stateVersion: 1, inputHash: 'test', runToken: 'test', jobs: {}, phases: {}, charged: {} }, new MemoryStore());
    expect(meter.capacity()).toBe(1); expect(await meter.saved([ad()])).toBe(true); expect(await meter.saved([ad()])).toBe(false); expect(charge).toHaveBeenCalledTimes(1);
  } finally { charge.mockRestore(); manager.mockRestore(); vi.unstubAllEnvs(); }
});

it('dataset reconciliation is idempotent and chunk reach is not summed as unique people', () => {
  const index = new DiskIndex(':memory:');
  try {
    const a = ad(); const b = ad({ impressions: 200, reach: 80 });
    a.source.dateSemantics = b.source.dateSemantics = 'verified_requested_range_metrics';
    a.extra._queryRange = { endDate: '2026-08-31' }; b.extra._queryRange = { endDate: '2026-09-30' };
    index.observe('a', a); index.observe('b', b); index.consolidate(); const merged = [...index.ads()][0];
    expect(merged.impressions).toBe(300); expect(merged.reach).toBeNull(); expect(merged.reachLower).toBe(80); expect(merged.reachUpper).toBe(130);
    index.markEmitted(a); index.markEmitted(a); expect(index.advertiserCount(a.advertiser.userId)).toBe(1);
    a.source.dateSemantics = b.source.dateSemantics = 'export_end_semantics_unverified';
    index.db.exec('DELETE FROM observations'); index.observe('a', a); index.observe('b', b); index.consolidate();
    expect([...index.ads()][0].impressions).toBeNull();
  } finally { index.close(); }
});
