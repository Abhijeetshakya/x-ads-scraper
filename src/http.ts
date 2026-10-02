import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import JSONbig from 'json-bigint';
import type { Logger, RecordData } from './types.js';
import { record, sleep } from './util.js';

export class SourceError extends Error {
  retryAfterMs?: number;
  constructor(public code: string, message: string, public retryable = false, public status?: number) { super(message); this.name = code; }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Math.max(0, Date.parse(value) - now) || 0;
}
export function backoff(attempt: number, random = Math.random, cap = 15000): number {
  return Math.min(cap, 1000 * 2 ** attempt) * (0.5 + random() * 0.5);
}
export function classify(status: number, body: string): SourceError {
  if (status === 401 || status === 403) return new SourceError('AUTH_OR_ACCESS_DENIED', 'X denied access. For export mode supply a permitted developer xBearerToken; public UI access may be restricted. Do not retry using another identity.', false, status);
  if (status === 429 || status >= 500 || /over capacity|rate.?limit|temporarily unavailable/i.test(body)) return new SourceError('SOURCE_BUSY', `Source temporarily unavailable (HTTP ${status}); retry later or reduce concurrency.`, true, status);
  return new SourceError('SOURCE_REQUEST_REJECTED', `Source rejected the request (HTTP ${status}). Check advertiser, country, dates and access permissions.`, false, status);
}
export function privateIp(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number);
    return x === 0 || x === 10 || x === 127 || x === 169 && y === 254 || x === 172 && y >= 16 && y <= 31 || x === 192 && y === 168 || x === 100 && y >= 64 && y <= 127 || x >= 224 || x === 198 && (y === 18 || y === 19);
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
}
export async function publicUrl(value: string, allowLocal = false): Promise<URL> {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new SourceError('UNSAFE_URL', 'Only public HTTP(S) URLs without embedded credentials may be fetched.');
  if (allowLocal && url.hostname === '127.0.0.1') return url;
  if (url.protocol !== 'https:' || /(^|\.)(localhost|local|internal)$/.test(url.hostname)) throw new SourceError('UNSAFE_URL', 'Only public HTTPS destinations may be fetched.');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(a => privateIp(a.address))) throw new SourceError('UNSAFE_URL', 'Private or reserved network destinations are blocked.');
  return url;
}
interface Bucket { tokens: number; updated: number; chain: Promise<void>; blockedUntil: number }
export class HostLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(private intervalMs: number, private wait = sleep, private clock = Date.now) {}
  async take(host: string): Promise<void> {
    const b = this.buckets.get(host) ?? { tokens: 1, updated: this.clock(), chain: Promise.resolve(), blockedUntil: 0 };
    this.buckets.set(host, b);
    const operation = b.chain.then(async () => {
      if (b.blockedUntil > this.clock()) await this.wait(b.blockedUntil - this.clock());
      const elapsed = this.clock() - b.updated;
      b.tokens = Math.min(1, b.tokens + elapsed / Math.max(1, this.intervalMs));
      if (b.tokens < 1) await this.wait((1 - b.tokens) * this.intervalMs);
      b.tokens = 0; b.updated = this.clock();
    });
    b.chain = operation.catch(() => {}); await operation;
  }
  block(host: string, ms: number) {
    const b = this.buckets.get(host);
    if (b) b.blockedUntil = Math.max(b.blockedUntil, this.clock() + ms);
  }
}
export interface HttpOptions {
  method?: string; headers?: Record<string, string>; body?: string | (() => Readable);
  timeoutMs?: number; retries?: number; idempotent?: boolean; maxBytes?: number;
  safePublic?: boolean; redirect?: 'follow' | 'manual';
}
export class Http {
  readonly limiter: HostLimiter;
  private dispatcher?: Dispatcher;
  readonly testMode: boolean;
  constructor(private logger: Logger, private retries = 3, delayMs = 1000, proxyUrl?: string, private wait = sleep) {
    this.limiter = new HostLimiter(delayMs, wait);
    this.testMode = process.env.XADS_TEST_MODE === '1' && process.env.APIFY_IS_AT_HOME !== '1';
    if (proxyUrl) this.dispatcher = new ProxyAgent(proxyUrl);
  }
  async request(url: string, options: HttpOptions = {}) {
    if (options.safePublic) await publicUrl(url, this.testMode);
    const host = new URL(url).host;
    for (let i = 0; ; i++) {
      await this.limiter.take(host);
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET', headers: options.headers, body: typeof options.body === 'function' ? options.body() : options.body,
          ...(typeof options.body === 'function' ? { duplex: 'half' as const } : {}),
          signal: AbortSignal.timeout(options.timeoutMs ?? 30000), redirect: options.redirect ?? 'manual', dispatcher: this.dispatcher,
        });
        if (response.status >= 200 && response.status < 400) return response;
        const text = (await response.text()).slice(0, 10000);
        const error = classify(response.status, text);
        if (options.idempotent === false && error.retryable) throw new SourceError('SUBMISSION_AMBIGUOUS', 'Export submission returned a retryable error without an ID. Verify it before resubmitting; no automatic duplicate mutation is made.', false, response.status);
        const pause = retryAfter(response.headers.get('retry-after'));
        this.limiter.block(host, pause);
        if (!error.retryable || i >= (options.retries ?? this.retries)) throw error;
        this.logger.warning('Retryable source response.', { host, status: response.status, attempt: i + 1 });
        await this.wait(Math.max(backoff(i), pause));
      } catch (e) {
        if (e instanceof SourceError) throw e;
        if (options.idempotent === false) throw new SourceError('SUBMISSION_AMBIGUOUS', 'Export submission was interrupted before an ID was received. Submission may have succeeded; automatic resubmission is disabled to avoid duplicate jobs.', false);
        if (i >= (options.retries ?? this.retries)) throw new SourceError('NETWORK_OR_TIMEOUT', 'Source network request failed or timed out after bounded retries.', true);
        this.logger.warning('Retryable network failure.', { host, attempt: i + 1 }); await this.wait(backoff(i));
      }
    }
  }
  async text(url: string, options: HttpOptions = {}): Promise<string> {
    const r = await this.request(url, options);
    if (r.status >= 300) throw new SourceError('UNEXPECTED_REDIRECT', 'Source redirected unexpectedly; no credentials were forwarded.');
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of r.body!) {
      size += chunk.length;
      if (size > (options.maxBytes ?? 20 * 1024 * 1024)) { await r.body!.cancel().catch(() => {}); throw new SourceError('RESPONSE_TOO_LARGE', 'Source response exceeded the safety cap; narrow the query.'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  async json(url: string, options: HttpOptions = {}): Promise<RecordData> {
    const text = await this.text(url, options);
    let data: unknown;
    try { data = JSONbig({ storeAsString: true, strict: true }).parse(text); }
    catch { throw new SourceError('INVALID_SOURCE_JSON', 'Source returned invalid JSON; query completeness cannot be established.'); }
    const obj = record(data);
    if (obj.errors || obj.error) {
      const body = JSON.stringify(obj.errors ?? obj.error);
      throw /over capacity|rate.?limit|RateLimited|Timeout|InternalServer/i.test(body)
        ? new SourceError('SOURCE_BUSY', 'Source GraphQL reported capacity, rate-limit or timeout errors.', true)
        : new SourceError('SOURCE_GRAPHQL_ERROR', 'Source reported a GraphQL error; check token permissions and current operation IDs.');
    }
    return obj;
  }
  async stream(url: string, options: HttpOptions = {}): Promise<Readable> {
    // A download link is public, not an authorization destination. Never attach bearer headers.
    let current = url;
    for (let i = 0; i < 5; i++) {
      const r = await this.request(current, { ...options, headers: undefined, safePublic: true, timeoutMs: 120000 });
      if (r.status < 300) return Readable.fromWeb(r.body as never);
      const location = r.headers.get('location'); await r.body?.cancel();
      if (!location) throw new SourceError('INVALID_DOWNLOAD_REDIRECT', 'Export redirect lacks a destination.');
      current = new URL(location, current).href;
    }
    throw new SourceError('REDIRECT_LIMIT', 'Export download exceeded five redirects.');
  }
  async close() { await this.dispatcher?.close(); }
}
