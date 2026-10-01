import { parse } from 'csv-parse';
import type { Readable } from 'node:stream';
import { Http, SourceError, backoff } from '../http.js';
import type { Advertiser, Capabilities, Input, Logger, Progress, Query, QueryOutcome, RecordData, SearchResult, SourceAdapter } from '../types.js';
import { deferred, get, record, sleep, str } from '../util.js';
import type { Discovery } from './discovery.js';

export async function* parseCsv(stream: Readable): AsyncGenerator<RecordData> {
  const parser = stream.pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 4 * 1024 * 1024 }));
  // ID lexemes remain strings throughout parsing.
  try { for await (const row of parser) yield row as RecordData; }
  finally { parser.destroy(); stream.destroy(); }
}
export class ExportAdapter implements SourceAdapter {
  readonly name = 'export';
  constructor(
    private http: Http, private input: Input, private discovery: Discovery,
    private progress: Progress, private persist: () => Promise<void>,
    private resolve: (value: string) => Promise<Advertiser>, private logger: Logger,
    private base = 'https://api.x.com', private wait = sleep,
  ) {}
  capabilities(): Capabilities { return { keywordSearch: false, targetingSearch: false, creativeContent: false, landingUrls: false, multiCountryQueries: false }; }
  async probe() {
    const ids = { ...this.discovery.operations, ...this.input.operationIds };
    return !!this.input.xBearerToken && !!ids.create && !!ids.status;
  }
  async resolveAdvertiser(value: string) { return this.resolve(value); }
  private async graphql(name: string, id: string, variables: RecordData, mutation: boolean) {
    const url = `${this.base}/graphql/${encodeURIComponent(id)}/${name}`;
    const headers = { authorization: `Bearer ${this.input.xBearerToken}`, 'content-type': 'application/json' };
    return this.http.json(mutation ? url : `${url}?variables=${encodeURIComponent(JSON.stringify(variables))}`, mutation
      ? { method: 'POST', headers, body: JSON.stringify({ queryId: id, variables }), idempotent: false }
      : { headers });
  }
  search(query: Query): SearchResult {
    const d = deferred<QueryOutcome>();
    const ads = (async function* (this: ExportAdapter) {
      let rows = 0;
      try {
        if (!this.input.xBearerToken) throw new SourceError('BEARER_TOKEN_REQUIRED', 'Export mode requires xBearerToken from your X developer app. Use auto/ui for anonymous repository access.');
        if (query.countries.length !== 1) throw new SourceError('EXPORT_MULTI_COUNTRY_UNVERIFIED', 'Export supports one verified country per job.');
        const ids = { ...this.discovery.operations, ...this.input.operationIds };
        if (!ids.create || !ids.status) throw new SourceError('OPERATION_DISCOVERY_FAILED', 'Current GraphQL operation IDs were not discovered. Supply operationIds from your permitted public-page network capture.');
        const job = this.progress.jobs[query.key] ??= { pages: 0 };
        if (!job.exportId) {
          // Persist the intent before submitting: an interrupted intent cannot be silently retried.
          if (job.status === 'submitting') throw new SourceError('SUBMISSION_AMBIGUOUS', 'A previous submission stopped before its exportId was saved. Verify the pending job manually before retrying this scope.');
          job.status = 'submitting'; job.submittedAt = new Date().toISOString(); await this.persist();
          const response = await this.graphql('CreateExportReportMutation', ids.create, {
            user: query.advertiser.userId, geoLocation: query.countries[0],
            deliveryRange: { start_date: query.startDate, end_date: query.endDate },
          }, true);
          const exportId = str(get(response, 'data.create_digital_services_act_export_insert.export_id'));
          if (!exportId) throw new SourceError('MISSING_EXPORT_ID', 'Export creation response omitted the exportId.');
          job.exportId = exportId; job.status = 'pending'; await this.persist();
        } else this.logger.info('Resuming saved export job.', { queryKey: query.key });
        const deadline = Date.parse(job.submittedAt!) + this.input.jobTimeoutMinutes * 60000;
        let attempt = 0;
        while (!job.downloadUrl) {
          if (Date.now() >= deadline) throw new SourceError('EXPORT_JOB_TIMEOUT', 'Export exceeded jobTimeoutMinutes; pending exportId is saved for inspection.', true);
          let response: RecordData;
          try { response = await this.graphql('GetExportReportStatusQuery', ids.status, { exportId: job.exportId }, false); }
          catch (e) { if (e instanceof SourceError && e.retryable && Date.now() < deadline) { await this.wait(backoff(attempt++)); continue; } throw e; }
          const status = record(get(response, 'data.digital_services_act_export_status'));
          if (!status.export_status) throw new SourceError('MISSING_EXPORT_STATUS', 'Export poll omitted its status.');
          job.status = String(status.export_status);
          if (/failed|error|cancelled/i.test(job.status)) throw new SourceError('EXPORT_FAILED', 'X marked this export job failed.', /capacity|rate/i.test(JSON.stringify(status)));
          if (job.status.toLowerCase() === 'finished') {
            const link = str(status.export_download_url);
            if (!link) throw new SourceError('MISSING_DOWNLOAD_URL', 'Finished export omitted its download URL.');
            job.downloadUrl = /^https?:\/\//.test(link) ? link : `https://${link}`;
          }
          await this.persist();
          if (!job.downloadUrl) await this.wait(Math.min(backoff(attempt++), Math.max(0, deadline - Date.now())));
        }
        const stream = await this.http.stream(job.downloadUrl);
        for await (const row of parseCsv(stream)) { rows++; yield row; }
        d.resolve({ status: 'complete', reason: null, rows });
      } catch (error) {
        const e = error instanceof SourceError ? error : new SourceError('EXPORT_PARSE_OR_NETWORK_ERROR', 'Export could not be fully parsed or downloaded.', true);
        d.resolve({ status: rows ? 'partial' : 'failed', reason: e.code, rows, retryable: e.retryable });
        this.logger.warning('Export query did not complete.', { queryKey: query.key, errorClass: e.code, retryable: e.retryable });
      }
    }).call(this);
    return { ads, outcome: d.promise };
  }
  async close() {}
}
