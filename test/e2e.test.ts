import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { sourceServer } from './mock.js';

export async function localRun(base: string, directory: string, input: unknown, resurrect = false) {
  const args = [resolve('node_modules/.bin/apify'), 'run', '--input', JSON.stringify(input), ...(resurrect ? ['--resurrect'] : ['--purge'])];
  return new Promise<{ code: number; output: string }>((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: { ...process.env, APIFY_CLI_DISABLE_TELEMETRY: '1', APIFY_LOCAL_STORAGE_DIR: relative(process.cwd(), directory), APIFY_STORAGE_DIR: relative(process.cwd(), directory), XADS_TEST_BASE_URL: base, XADS_TEST_MODE: '1', DISABLE_METERING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d); child.on('error', reject); child.on('close', code => done({ code: code ?? 1, output }));
  });
}
it('runs through apify run with mocked HTTP and resumes without duplicate rows or jobs', async () => {
  const server = await sourceServer(); const directory = await mkdtemp(join(tmpdir(), 'xads-e2e-'));
  const input = { advertisers: ['8940342'], countries: ['FR'], startDate: '2026-09-01', endDate: '2026-09-30', sourceMode: 'export', xBearerToken: 'mock-only', requestDelayMs: 0, enrichCreatives: false, keywordFields: ['advertiser'], exportFormats: ['csv', 'json', 'xlsx', 'html'] };
  try {
    const first = await localRun(server.url, directory, input); expect(first.code, first.output).toBe(0);
    const summary = JSON.parse(await readFile(join(directory, 'key_value_stores/default/SUMMARY.json'), 'utf8'));
    expect(summary.totalAds).toBe(2); expect(summary.exports).toEqual(['ads.csv', 'ads.json', 'ads.xlsx', 'report.html']);
    for (const name of summary.exports) expect((await readFile(join(directory, 'key_value_stores/default', name))).length).toBeGreaterThan(0); expect(server.submissions()).toBe(1);
    const second = await localRun(server.url, directory, input, true); expect(second.code, second.output).toBe(0);
    const files = (await readdir(join(directory, 'datasets/default'))).filter(f => /^\d+\.json$/.test(f)); expect(files).toHaveLength(2); expect(server.submissions()).toBe(1);
    expect(first.output).not.toContain('mock-only');
  } finally { await server.close(); }
}, 90000);

it('demonstrates persistent monitor runs: new, unchanged, changed and grace-period removal', async () => {
  const server = await sourceServer(); const directory = await mkdtemp(join(tmpdir(), 'xads-monitor-e2e-'));
  const original = await readFile(new URL('./fixtures/ads.csv', import.meta.url), 'utf8');
  const input = { advertisers: ['8940342'], countries: ['FR'], startDate: '2026-09-01', endDate: '2026-09-30', sourceMode: 'export', xBearerToken: 'mock-only', requestDelayMs: 0, enrichCreatives: false, keywordFields: ['advertiser'], exportFormats: [], mode: 'monitor', monitorKey: 'local-lifecycle', removalGraceRuns: 2 };
  const run = async () => { const result = await localRun(server.url, directory, input); expect(result.code, result.output).toBe(0); return JSON.parse(await readFile(join(directory, 'key_value_stores/default/SUMMARY.json'), 'utf8')); };
  try {
    expect((await run()).changes.NEW).toBe(2);
    expect((await run()).totalAds).toBe(0);
    server.setCsv(original.replaceAll('Verified', 'Halted'));
    expect((await run()).changes.CHANGED).toBe(1);
    server.setCsv(original.split('\n')[0] + '\n');
    expect((await run()).totalAds).toBe(0);
    expect((await run()).changes.REMOVED).toBe(2);
  } finally { await server.close(); }
}, 180000);
