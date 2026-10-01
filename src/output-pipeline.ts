import { Actor, log } from 'apify';
import { createReadStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Enricher } from './enrichment.js';
import { analyze, generateExports } from './exports.js';
import { FilterEngine } from './filters.js';
import { Metering } from './metering.js';
import { Monitor, type Scope, type StatePatch } from './monitor.js';
import { refreshAvailability } from './normalize.js';
import { notify } from './notifications.js';
import type { PipelineHooks } from './pipeline.js';
import type { Ad, Store } from './types.js';
import { workers } from './util.js';

export const outputHooks: PipelineHooks = {
  async process(index, input, store, queries, progress, http, shouldStop) {
    const filter = new FilterEngine(input);
    let monitor: Monitor | undefined; let stateStore: Store = store;
    if (input.mode === 'monitor') {
      stateStore = await Actor.openKeyValueStore(input.monitorStoreName);
      monitor = new Monitor(stateStore, input, log); await monitor.acquire();
    }
    const enrichmentBase = http.testMode && process.env.XADS_TEST_BASE_URL ? process.env.XADS_TEST_BASE_URL : 'https://publish.twitter.com';
    const enricher = new Enricher(input, http, stateStore, log, enrichmentBase);
    const scopes = new Map<string, Scope>();
    for (const query of queries) for (const country of query.countries) {
      const key = `${query.advertiser.userId}|${country}`;
      const complete = progress.jobs[query.key]?.outcome?.status === 'complete';
      const old = scopes.get(key);
      scopes.set(key, { userId: query.advertiser.userId, country, startDate: old ? [old.startDate, query.startDate].sort()[0] : query.startDate,
        endDate: old ? [old.endDate, query.endDate].sort().at(-1)! : query.endDate, complete: old ? old.complete && complete : complete, runToken: progress.runToken });
    }
    if (monitor && [...scopes.values()].some(s => !s.complete)) log.warning('Removal inference disabled for partial/failed advertiser × country scopes.');
    const dataset = await Actor.openDataset();
    const meter = new Metering(progress, store);
    let budgetReached = false;
    try {
      const pending = await store.getValue<{ patch: StatePatch; adKey: string }[]>('MONITOR_PENDING_PATCHES') ?? [];
      if (monitor) for (const item of pending) if (index.isEmitted(item.adKey)) await monitor.apply(item.patch);
      await store.setValue('MONITOR_PENDING_PATCHES', []);
      let group: Ad[] = [];
      const processGroup = async (ads: Ad[]) => {
        await workers(ads, input.concurrency, async ad => { await enricher.enrich(ad); });
        for (const ad of ads) {
          const scope = scopes.get(`${ad.advertiser.userId}|${ad.country}`)!;
          const matched = filter.match(ad); refreshAvailability(ad);
          if (monitor) {
            const result = await monitor.compare(ad, scope);
            if (result.ad.changeStatus === 'UNCHANGED' || !matched) {
              // A previously matched but currently filtered-out ad is still present: do not infer removal.
              if (result.ad.changeStatus !== 'NEW') await monitor.apply(result.patch);
            } else index.candidate(result.ad, result.patch);
          } else if (matched) index.candidate(ad);
        }
      };
      // Compare in small groups; only public enrichment requests run in parallel.
      for (const ad of index.ads()) { if (shouldStop()) return; group.push(ad); if (group.length >= 50) { await processGroup(group); group = []; } }
      if (group.length) await processGroup(group);
      if (monitor) for (const scope of scopes.values()) {
        const query = queries.find(q => q.advertiser.userId === scope.userId && q.countries.includes(scope.country))!;
        for await (const result of monitor.removals(scope, query, key => index.hasAd(key))) {
          if (result.ad) { refreshAvailability(result.ad); index.candidate(result.ad, result.patch); }
          else await monitor.apply(result.patch);
        }
      }
      let batch: { ad: Ad; patch: StatePatch | null }[] = [];
      const flush = async () => {
        if (!batch.length) return;
        const capacity = Math.min(batch.length, meter.capacity());
        const saved = batch.slice(0, capacity); batch = [];
        if (!saved.length) { budgetReached = true; return; }
        await store.setValue('MONITOR_PENDING_PATCHES', saved.filter(v => v.patch).map(v => ({ adKey: v.ad.adKey, patch: v.patch })));
        await dataset.pushData(saved.map(v => v.ad));
        for (const item of saved) {
          index.markEmitted(item.ad);
          if (monitor && item.patch) await monitor.apply(item.patch);
        }
        await store.setValue('MONITOR_PENDING_PATCHES', []);
        budgetReached = await meter.saved(saved.map(v => v.ad));
        await store.setValue('PROGRESS', progress);
        await Actor.setStatusMessage(`Saved ${index.emittedCount()} ads; ${input.mode} output.`);
      };
      for (const candidate of index.candidates(input.sortBy)) {
        if (shouldStop()) return;
        if (index.isEmitted(candidate.ad.adKey)) continue;
        if (budgetReached || input.maxItems !== null && index.emittedCount() + batch.length >= input.maxItems) break;
        if (input.maxAdsPerAdvertiser !== null && index.advertiserCount(candidate.ad.advertiser.userId) + batch.filter(v => v.ad.advertiser.userId === candidate.ad.advertiser.userId).length >= input.maxAdsPerAdvertiser) continue;
        batch.push({ ad: candidate.ad, patch: candidate.patch as StatePatch | null });
        if (batch.length >= 250) await flush();
      }
      await flush();
      await store.setValue('OUTPUT_STATUS', { budgetReached, capped: index.emittedCount() < Number(index.db.prepare('SELECT count(*) AS n FROM candidates').get()!.n), meteringDisabled: process.env.DISABLE_METERING === '1' });
    } finally { await monitor?.release(); }
  },
  async finalize(index, input, store, summary, http) {
    const directory = await mkdtemp(join(tmpdir(), 'xads-exports-'));
    const rows = () => index.emitted();
    Object.assign(summary, analyze(rows));
    summary.outputStatus = await store.getValue('OUTPUT_STATUS');
    const progress = await store.getValue<{ runToken: string }>('PROGRESS');
    const runId = Actor.getEnv().actorRunId ?? progress?.runToken ?? 'local';
    const previousNotifications = await store.getValue('NOTIFICATION_STATUS');
    summary.notificationStatus = previousNotifications ?? await notify(directory, rows, input, runId, http, log);
    await store.setValue('NOTIFICATION_STATUS', summary.notificationStatus);
    for (const result of summary.notificationStatus as { channel: string; status: string; reason?: string }[]) if (result.status === 'failed') (summary.errors as unknown[]).push({ queryKey: null, errorClass: result.reason, reason: `Notification ${result.channel} failed`, retryable: true });
    summary.exports = [];
    // A generator failure is recorded separately and never hides already-saved ads.
    for (const format of input.exportFormats) {
      try {
        const files = await generateExports(directory, [format], rows, summary, input.includeRaw);
        for (const file of files) {
          await store.setValue(file.key, createReadStream(file.path), { contentType: file.contentType });
          (summary.exports as string[]).push(file.key);
        }
      } catch { (summary.errors as unknown[]).push({ queryKey: null, errorClass: 'EXPORT_FILE_FAILED', reason: `Optional ${format} file failed`, retryable: true }); log.error('Optional report generation/upload failed.', { format }); (summary.exports as string[]).push(`${format}:failed`); }
    }
  },
};
