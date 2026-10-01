import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Ad, Logger, Query, RecordData, Store } from '../src/types.js';
import { normalize, SchemaTracker } from '../src/normalize.js';

export const logger: Logger = { info() {}, warning() {}, error() {} };
export const query: Query = { key: 'test-query', advertiser: { userId: '8940342', handle: 'Nike', name: 'Nike', profileUrl: 'https://x.com/Nike' }, countries: ['FR'], startDate: '2026-09-01', endDate: '2026-09-30', keywords: [], targetedLocations: [] };
export function ad(overrides: RecordData = {}): Ad {
  return normalize({ tweetId: '1346889436626259968', lineItemId: 'line-1', country: 'FR', impressions: 100, reach: 50, approvalStatus: 'Verified', ...overrides }, query, 'export', new SchemaTracker(logger)).ad;
}
export class MemoryStore implements Store {
  values = new Map<string, unknown>();
  async getValue<T>(key: string) { return (structuredClone(this.values.get(key)) ?? null) as T | null; }
  async setValue(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
}
export async function server(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>) {
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    try { await handler(req, res, body); } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())) };
}
export async function sourceServer() {
  let submissions = 0; let polls = 0;
  let csv = await readFile(new URL('./fixtures/ads.csv', import.meta.url), 'utf8');
  const source = await server((req, res, body) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    res.setHeader('content-type', 'application/json');
    if (path === '/ads-repository') { res.setHeader('content-type', 'text/html'); res.end('<script src="/fixture.js"></script>'); }
    else if (path === '/fixture.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end('params:{id:"mock_create",metadata:{},name:"CreateExportReportMutation"};params:{id:"mock_status",metadata:{},name:"GetExportReportStatusQuery"};Y={France:"FR",Germany:"DE"};He=Object.freeze([{displayValue:F.fr,systemValue:Y.France},{displayValue:F.de,systemValue:Y.Germany}]);new Date("2023-08-26");"/ads-repository/api/user-search";"/ads-repository/api/ads-search";');
    } else if (path.endsWith('/user-search')) res.end(JSON.stringify({ id_str: '8940342', screen_name: 'Nike', name: 'Nike' }));
    else if (path.endsWith('/ads-search')) { const q = JSON.parse(body); res.end(JSON.stringify({ complete: true, ads: [{ tweetId: '1346889436626259968', lineItemId: 'line-1', country: q.countries[0], impressions: 1200, reach: 800, approvalStatus: 'Verified' }] })); }
    else if (path.endsWith('/CreateExportReportMutation')) { submissions++; res.end(JSON.stringify({ data: { create_digital_services_act_export_insert: { export_id: 'job-1' } } })); }
    else if (path.endsWith('/GetExportReportStatusQuery')) { polls++; res.end(JSON.stringify({ data: { digital_services_act_export_status: { export_id: 'job-1', export_status: 'Finished', export_download_url: `${source.url}/download.csv` } } })); }
    else if (path === '/download.csv') { res.setHeader('content-type', 'text/csv'); res.end(csv); }
    else { res.statusCode = 404; res.end('{}'); }
  });
  return { ...source, submissions: () => submissions, polls: () => polls, setCsv: (value: string) => { csv = value; } };
}
