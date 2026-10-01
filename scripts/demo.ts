import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseCsv } from '../src/adapters/export.js';
import { normalize, SchemaTracker, mergeSameQuery } from '../src/normalize.js';
import { generateExports, analyze } from '../src/exports.js';
import { Monitor } from '../src/monitor.js';
import { defaults } from '../src/input.js';
import { ad, query, logger, MemoryStore } from '../test/mock.js';
import type { Ad } from '../src/types.js';
const directory = 'artifacts'; await mkdir(directory, { recursive: true });
const values = new Map<string, Ad>(); const tracker = new SchemaTracker(logger);
for await (const raw of parseCsv(Readable.from([await readFile('test/fixtures/ads.csv')]))) {
  const row = normalize(raw, query, 'export', tracker).ad;
  const old = values.get(row.adKey); values.set(row.adKey, old ? mergeSameQuery(old, row) : row);
}
const rows = () => values.values();
await generateExports(directory, ['csv', 'json', 'xlsx', 'html'], rows, { synthetic: true, ...analyze(rows) });
const input = { ...defaults, advertisers: ['Nike'], countries: ['FR'], mode: 'monitor' as const, monitorKey: 'synthetic-demo' };
const state = new MemoryStore(); const events: unknown[] = [];
for (let run = 1; run <= 5; run++) {
  const monitor = new Monitor(state, input, logger); await monitor.acquire();
  const scope = { userId: query.advertiser.userId, country: 'FR', startDate: query.startDate, endDate: query.endDate, complete: true, runToken: `run-${run}` };
  const present = new Set<string>(); const statuses: string[] = [];
  if (run <= 3) {
    const row = ad(run === 3 ? { approvalStatus: 'Halted' } : {}); present.add(row.adKey);
    const result = await monitor.compare(row, scope); await monitor.apply(result.patch); statuses.push(result.ad.changeStatus);
  }
  for await (const result of monitor.removals(scope, query, key => present.has(key))) { await monitor.apply(result.patch); if (result.ad) statuses.push(result.ad.changeStatus); }
  await monitor.release(); events.push({ run, statuses });
}
await writeFile(`${directory}/monitor-demo.json`, JSON.stringify({ synthetic: true, events }, null, 2));
await writeFile(`${directory}/README.txt`, 'SYNTHETIC fixture reports, not live X disclosures. Reproduce with npm run demo.\n');
console.log(`Generated four synthetic exports and monitor lifecycle in ${directory}/`);
