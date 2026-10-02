import { Actor, log } from 'apify';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiAdapter } from './adapters/api.js';
import { discover, type Discovery } from './adapters/discovery.js';
import { ExportAdapter } from './adapters/export.js';
import { BrowserUi, PublicUiHttp, UiAdapter } from './adapters/ui.js';
import { SourceError, Http } from './http.js';
import { applyScope, chunks, fingerprint, validateInput } from './input.js';
import { FilterEngine } from './filters.js';
import { normalize, SchemaTracker } from './normalize.js';
import { DiskIndex, restorePages, savePage } from './storage.js';
import type { Ad, Advertiser, Input, Progress, Query, RunError, SourceAdapter, Store } from './types.js';
import { hash, workers } from './util.js';

export interface PipelineHooks {
  process?: (index: DiskIndex, input: Input, store: Store, queries: Query[], progress: Progress, http: Http, shouldStop: () => boolean) => Promise<void>;
  finalize?: (index: DiskIndex, input: Input, store: Store, summary: Record<string, unknown>, http: Http) => Promise<void>;
}
export async function runPipeline(raw: Partial<Input>, hooks: PipelineHooks = {}) {
  const started = Date.now();
  const input = validateInput(raw, log);
  new FilterEngine(input); // Compile expressions before making any source request.
  const store = await Actor.openKeyValueStore();
  const dataset = await Actor.openDataset();
  const errors = await store.getValue<RunError[]>('ERRORS') ?? [];
  const old = await store.getValue<Progress>('PROGRESS');
  const inputHash = fingerprint(input);
  if (old && old.inputHash !== inputHash) throw new Error('Input differs from the saved run. Start a new run/storage instead of resuming another scope.');
  if (old && old.stateVersion > 1) throw new Error('Run state is from a newer Actor version; do not downgrade an in-progress run.');
  const progress: Progress = old ?? { stateVersion: 1, inputHash, runToken: hash(`${Date.now()}|${Math.random()}`), jobs: {}, phases: {}, charged: {} };
  // Serial persistence prevents an older asynchronous snapshot from overwriting newer state.
  let persistChain = Promise.resolve();
  const persist = () => { const value = structuredClone(progress); persistChain = persistChain.then(() => store.setValue('PROGRESS', value)); return persistChain; };
  const persistErrors = () => store.setValue('ERRORS', errors);
  let stopping = false;
  Actor.on('persistState', persist);
  Actor.on('migrating', async () => { stopping = true; await persist(); await persistErrors(); });
  Actor.on('aborting', async () => { stopping = true; await persist(); await persistErrors(); });
  const directory = await mkdtemp(join(tmpdir(), 'xads-'));
  const index = new DiskIndex(join(directory, 'run.sqlite'));
  let proxyUrl: string | undefined;
  if (input.proxyConfiguration.useApifyProxy || input.proxyConfiguration.proxyUrls?.length) {
    const config = await Actor.createProxyConfiguration(input.proxyConfiguration); proxyUrl = await config?.newUrl();
    log.info('Using the explicitly configured proxy. Datacenter proxies are recommended before any higher-cost option.');
  }
  const http = new Http(log, input.maxRetries, input.requestDelayMs, proxyUrl);
  const testBase = process.env.XADS_TEST_BASE_URL || undefined;
  if (testBase && (!http.testMode || new URL(testBase).hostname !== '127.0.0.1')) throw new Error('Test endpoints are allowed only on loopback in local XADS_TEST_MODE, never on Apify.');
  const base = testBase ?? 'https://ads.x.com';
  let discovery: Discovery;
  let adapter: SourceAdapter | undefined;
  let ui: UiAdapter | undefined;
  const tracker = new SchemaTracker(log);
  for (const warning of await store.getValue<string[]>('SCHEMA_DRIFT_WARNINGS') ?? []) tracker.warnings.add(warning);
  let queries: Query[] = [];
  try {
    await Actor.setStatusMessage('Probing the public X Ads Repository…');
    try { discovery = await discover(http, log, base); }
    catch (e) {
      if (input.sourceMode !== 'export' || !input.operationIds?.create || !input.operationIds.status) throw e;
      log.warning('Source discovery failed; using explicitly configured operations and UNVERIFIED fallback scope.');
      discovery = { countries: (await import('./input.js')).FALLBACK_COUNTRIES, countriesVerified: false, earliestDate: '2023-08-26', operations: input.operationIds, pageUrl: `${base}/ads-repository` };
    }
    await store.setValue('SOURCE_CAPABILITIES', { ...discovery, operations: { create: !!discovery.operations.create, status: !!discovery.operations.status }, verifiedAt: new Date().toISOString() });
    const api = new ApiAdapter();
    ui = new UiAdapter(input, new PublicUiHttp(http, discovery, input.advertisers.find(a => !/^\d+$/.test(a)) ?? ''), new BrowserUi(discovery, log, proxyUrl, input.maxRetries), log);
    let uiProbed = false;
    const resolve = async (value: string): Promise<Advertiser> => {
      if (/^\d+$/.test(value)) return { userId: value, handle: null, name: null, profileUrl: null };
      if (!uiProbed) { if (!await ui!.probe()) throw new SourceError('HANDLE_RESOLUTION_UNAVAILABLE', 'Public handle resolution unavailable; supply numeric advertiser IDs for export mode.'); uiProbed = true; }
      return ui!.resolveAdvertiser(value);
    };
    const exp = new ExportAdapter(http, input, discovery, progress, persist, resolve, log, testBase ?? 'https://api.x.com');
    if (input.sourceMode === 'api') { if (!await api.probe()) throw new SourceError('API_NOT_DOCUMENTED', 'The new official repository API is not verified/documented. Use auto, export or ui.'); adapter = api; }
    else if (input.sourceMode === 'export') adapter = exp;
    else {
      if (await api.probe()) adapter = api;
      else if (await ui.probe()) { adapter = ui; uiProbed = true; }
      else if (input.sourceMode === 'auto' && await exp.probe()) adapter = exp;
      else throw new SourceError('NO_WORKING_SOURCE', 'Neither anonymous UI nor a permitted export source is available. Supply xBearerToken and numeric advertiser IDs for export, or retry public access later.');
    }
    log.info('Selected source adapter.', { adapter: adapter.name });
    applyScope(input, discovery.countries, discovery.earliestDate, adapter.capabilities(), log);
    const advertisers: Advertiser[] = [];
    for (const value of input.advertisers) {
      try { const advertiser = await adapter.resolveAdvertiser(value); if (!advertisers.some(a => a.userId === advertiser.userId)) advertisers.push(advertiser); }
      catch (e) { errors.push({ queryKey: null, advertiser: value, countries: input.countries, chunk: [input.startDate, input.endDate], errorClass: e instanceof SourceError ? e.code : 'ADVERTISER_RESOLUTION_FAILED', reason: e instanceof SourceError ? e.message : 'Could not resolve advertiser.', retryable: e instanceof SourceError && e.retryable }); }
    }
    const countryGroups = adapter.capabilities().multiCountryQueries ? [input.countries] : input.countries.map(c => [c]);
    queries = advertisers.flatMap(advertiser => countryGroups.flatMap(countries => chunks(input.startDate, input.endDate).map(range => ({
      advertiser, countries, ...range, keywords: adapter!.capabilities().keywordSearch ? input.keywords : [],
      targetedLocations: adapter!.capabilities().targetingSearch ? input.targetedLocations : [],
      key: hash(`${adapter!.name}|${advertiser.userId}|${countries.join(',')}|${range.startDate}|${range.endDate}`),
    }))));
    if (queries.length > input.maxExportJobs) throw new Error(`Plan requires ${queries.length} jobs, exceeding maxExportJobs=${input.maxExportJobs}. Narrow countries/dates or raise the cap explicitly.`);
    const estimate = Math.ceil(queries.length / input.concurrency * (adapter.name === 'export' ? 200 : 15) / 60);
    log.info(`${queries.length} jobs, estimated ${estimate} min at concurrency ${input.concurrency}.`, { estimateIsAssumption: true });
    await restorePages(store, progress, index);
    // Reconcile append-only output before resuming; handles a crash after push but before checkpoint.
    for (let offset = 0; ; offset += 500) {
      const page = await dataset.getData({ offset, limit: 500 });
      for (const item of page.items) index.markEmitted(item as unknown as Ad);
      if (page.items.length < 500) break;
    }
    await workers(queries, input.concurrency, async query => {
      if (stopping || progress.jobs[query.key]?.outcome) return;
      // Pending downloads are replayed from the start; discard prior partial staging.
      index.db.prepare('DELETE FROM observations WHERE queryKey=?').run(query.key);
      const pendingJob = progress.jobs[query.key] ??= { pages: 0 };
      pendingJob.pages = 0; await persist();
      const result = adapter!.search(query);
      const buffer: Ad[] = []; let page = 0; let badRows = 0; let drift = false;
      for await (const rawAd of result.ads) {
        if (stopping) break;
        try {
          const value = normalize(rawAd, query, adapter!.name, tracker, input.includeRaw);
          drift ||= value.drift;
          value.ad.extra._queryRange = { startDate: query.startDate, endDate: query.endDate };
          buffer.push(value.ad); index.observe(query.key, value.ad);
        } catch (e) { badRows++; errors.push({ queryKey: query.key, advertiser: query.advertiser.userId, countries: query.countries, chunk: [query.startDate, query.endDate], errorClass: e instanceof SourceError ? e.code : 'NORMALIZATION_FAILED', reason: e instanceof SourceError ? e.message : 'Invalid source row quarantined.', retryable: false }); }
        if (buffer.length >= 250) { await savePage(store, progress, query.key, page++, buffer.splice(0), persist); }
      }
      if (buffer.length) await savePage(store, progress, query.key, page++, buffer, persist);
      if (stopping) { await persist(); return; }
      const outcome = await result.outcome;
      if ((badRows || drift) && outcome.status === 'complete') { outcome.status = 'partial'; outcome.reason = badRows ? 'QUARANTINED_ROWS' : 'SCHEMA_DRIFT'; }
      const job = progress.jobs[query.key] ??= { pages: 0 };
      job.outcome = outcome;
      if (outcome.status !== 'complete') errors.push({ queryKey: query.key, advertiser: query.advertiser.userId, countries: query.countries, chunk: [query.startDate, query.endDate], errorClass: outcome.reason ?? 'PARTIAL_QUERY', reason: outcome.details ?? `Source query ${outcome.status}; ${outcome.rows} raw rows.`, retryable: outcome.retryable ?? false });
      await persist(); await persistErrors();
      await store.setValue('SCHEMA_DRIFT_WARNINGS', [...tracker.warnings]);
      for (const country of query.countries) log.info('Advertiser × country query finished.', { advertiser: query.advertiser.userId, country, chunk: [query.startDate, query.endDate], status: outcome.status, rows: outcome.rows });
      await Actor.setStatusMessage(`Fetched ${Object.values(progress.jobs).filter(j => j.outcome).length}/${queries.length} queries; ${errors.length} issues recorded.`);
    });
    if (stopping) return;
    progress.phases.queriesDone = true; await persist(); index.consolidate();
    if (hooks.process) await hooks.process(index, input, store, queries, progress, http, () => stopping);
    else {
      const batch: Ad[] = [];
      for (const ad of index.ads()) if (!index.isEmitted(ad.adKey)) { batch.push(ad); if (batch.length === 250) { await dataset.pushData(batch); batch.forEach(a => index.markEmitted(a)); batch.length = 0; } }
      if (batch.length) { await dataset.pushData(batch); batch.forEach(a => index.markEmitted(a)); }
    }
    if (stopping) return;
    progress.phases.outputDone = true; await persist();
    const failedQueries = queries.filter(q => progress.jobs[q.key]?.outcome?.status === 'failed').length + errors.filter(e => !e.queryKey).length;
    const summary: Record<string, unknown> = { totalAds: index.emittedCount(), adapterUsed: adapter.name, queriesPlanned: queries.length,
      completeQueries: queries.filter(q => progress.jobs[q.key]?.outcome?.status === 'complete').length,
      partialQueries: queries.filter(q => progress.jobs[q.key]?.outcome?.status === 'partial').length,
      failedQueries, errors, schemaDriftWarnings: [...tracker.warnings], runDurationSeconds: (Date.now() - started) / 1000,
      chargedEvents: progress.charged, notificationStatus: [], sourceScope: { countries: input.countries, countriesVerified: discovery.countriesVerified, startDate: input.startDate, endDate: input.endDate },
    };
    if (hooks.finalize) await hooks.finalize(index, input, store, summary, http);
    await store.setValue('SUMMARY', summary);
    if (Array.isArray(summary.errors)) errors.splice(0, errors.length, ...summary.errors as RunError[]);
    await persistErrors();
    await Actor.setStatusMessage(`Done: ${index.emittedCount()} ads, ${failedQueries} queries failed, ${summary.partialQueries} partial.`);
    if (!queries.length || queries.every(q => progress.jobs[q.key]?.outcome?.status === 'failed')) {
      const causes = [...new Set(errors.map(e => `${e.errorClass}: ${e.reason}`))].slice(0, 3).join(' ');
      throw new SourceError('ALL_QUERIES_FAILED', `Every source query failed (or no advertiser could be resolved). ${causes} Inspect the ERRORS record for details.`);
    }
    return summary;
  } catch (e) {
    if (!errors.length) errors.push({ queryKey: null, advertiser: null, countries: input.countries, chunk: [input.startDate, input.endDate], errorClass: e instanceof SourceError ? e.code : 'RUN_SETUP_FAILED', reason: e instanceof SourceError ? e.message : 'Run setup/validation failed. Inspect the run log.', retryable: e instanceof SourceError && e.retryable });
    await persistErrors();
    await store.setValue('SUMMARY', { totalAds: index.emittedCount(), adapterUsed: adapter?.name ?? null, failedQueries: errors.length, errors, schemaDriftWarnings: [...tracker.warnings], status: 'failed', runDurationSeconds: (Date.now() - started) / 1000 });
    throw e;
  } finally { await persist(); await adapter?.close(); if (ui !== adapter) await ui?.close(); await http.close(); index.close(); Actor.off('persistState', persist); }
}
