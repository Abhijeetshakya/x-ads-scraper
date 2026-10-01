import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawn } from 'node:child_process';

it.skipIf(process.env.RUN_LIVE_TESTS !== '1')('opt-in live 1 advertiser × 1 country × 30 days through apify run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xads-live-'));
  const input = { advertisers: [process.env.LIVE_ADVERTISER ?? 'Nike'], countries: [process.env.LIVE_COUNTRY ?? 'FR'], startDate: '30 days', endDate: '0 days', sourceMode: 'auto', maxItems: 5, enrichCreatives: false, keywordFields: ['advertiser'], exportFormats: ['json'] };
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('node_modules/.bin/apify', ['run', '--purge', '--input', JSON.stringify(input)], { env: { ...process.env, APIFY_CLI_DISABLE_TELEMETRY: '1', APIFY_LOCAL_STORAGE_DIR: relative(process.cwd(), directory), APIFY_STORAGE_DIR: relative(process.cwd(), directory), DISABLE_METERING: '1', XADS_TEST_MODE: '', XADS_TEST_BASE_URL: '' }, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', n => resolve(n ?? 1));
  });
  expect(code).toBe(0);
}, 240000);
