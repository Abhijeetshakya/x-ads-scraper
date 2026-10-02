import JSONbig from 'json-bigint';
import { existsSync } from 'node:fs';
import { chromium, errors as playwrightErrors, type BrowserContext, type Page } from 'playwright';
import { backoff, classify, Http, retryAfter, SourceError } from '../http.js';
import type { Advertiser, Capabilities, Input, Logger, Query, QueryOutcome, RecordData, SearchResult, SourceAdapter } from '../types.js';
import { addDays, deferred, record, safeReason, sleep, str } from '../util.js';
import type { Discovery } from './discovery.js';

const region = new Intl.DisplayNames(['en'], { type: 'region' });
const countryLabel = (c: string) => c === 'CZ' ? 'Czech Republic' : region.of(c)!;
export function userFromResponse(data: RecordData, expected: string): Advertiser {
  const user = record(data.user ?? data);
  const id = str(user.id_str ?? user.userId ?? user.id);
  const handle = str(user.screen_name ?? user.handle);
  if (!id || !/^\d+$/.test(id) || !handle || handle.toLowerCase() !== expected.toLowerCase()) throw new SourceError('ADVERTISER_NOT_FOUND', 'X did not resolve this exact advertiser handle. Check spelling or supply a numeric user ID.');
  return { userId: id, handle, name: str(user.name), profileUrl: `https://x.com/${handle}` };
}
export function uiOutcome(data: RecordData, rows: number): QueryOutcome {
  if (data.error || data.errors || !Array.isArray(data.ads)) return { status: 'failed', reason: 'INVALID_UI_RESPONSE', rows: 0 };
  if (data.hasMore === true || data.nextCursor || data.truncated === true || data.partial === true) return { status: 'partial', reason: 'UI_TRUNCATED_OR_PAGINATED', rows };
  // The inspected UI does not establish an exhaustive contract; only explicit source guarantees count.
  const complete = data.complete === true || data.isComplete === true;
  return { status: complete ? 'complete' : 'partial', reason: complete ? null : 'UI_COMPLETENESS_UNVERIFIED', rows };
}
export interface UiTransport {
  probe(): Promise<boolean>;
  resolveAdvertiser(handle: string): Promise<Advertiser>;
  search(query: Query): Promise<RecordData>;
  close(): Promise<void>;
}
export class PublicUiHttp implements UiTransport {
  private users = new Map<string, Advertiser>();
  constructor(private http: Http, private discovery: Discovery, private probeHandle: string) {}
  async probe() {
    if (!this.discovery.uiSearchPath || !this.discovery.uiUserPath) return false;
    if (/^\d+$/.test(this.probeHandle)) return false; // Startup probe needs a verifiable handle response.
    try { await this.resolveAdvertiser(this.probeHandle); return true; } catch { return false; }
  }
  async resolveAdvertiser(handle: string) {
    const cached = this.users.get(handle); if (cached) return cached;
    if (!this.discovery.uiUserPath) throw new SourceError('UI_SERVICE_NOT_DISCOVERED', 'Public UI handle resolution service was not discovered.');
    const data = await this.http.json(new URL(this.discovery.uiUserPath, this.discovery.pageUrl).href, { method: 'POST', body: JSON.stringify({ screenName: handle }), headers: { 'content-type': 'application/json' } });
    const user = userFromResponse(data, handle); this.users.set(handle, user); return user;
  }
  async search(q: Query) {
    if (!this.discovery.uiSearchPath) throw new SourceError('UI_SERVICE_NOT_DISCOVERED', 'Public UI search service was not discovered.');
    // Decimal JSON lexeme, without converting any ID through Number.
    const body = `{"userId":${BigInt(q.advertiser.userId).toString()},"countries":${JSON.stringify(q.countries)},"startDate":${JSON.stringify(q.startDate)},"endDate":${JSON.stringify(addDays(q.endDate, 1))}}`;
    return this.http.json(new URL(this.discovery.uiSearchPath, this.discovery.pageUrl).href, { method: 'POST', body, headers: { 'content-type': 'application/json' }, maxBytes: 32e6 });
  }
  async close() {}
}
/** Actual anonymous form interaction; captures only result bodies, never cookies or auth headers. */
export class BrowserUi implements UiTransport {
  private context?: Promise<BrowserContext>;
  constructor(private discovery: Discovery, private logger: Logger, private proxyUrl?: string, private maxRetries = 3) {}
  private async createContext(): Promise<BrowserContext> {
    const channel = process.env.XADS_BROWSER_CHANNEL;
    if (channel && channel !== 'chrome' && channel !== 'chromium') throw new SourceError('INVALID_BROWSER_CHANNEL', 'XADS_BROWSER_CHANNEL must be chrome or chromium.');
    if (!channel && !existsSync(chromium.executablePath())) throw new SourceError('BROWSER_NOT_INSTALLED', 'Playwright Chromium is missing. Run npx playwright install --with-deps chromium, or set XADS_BROWSER_CHANNEL=chrome to use installed Google Chrome.');
    const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}), ...(this.proxyUrl ? { proxy: { server: this.proxyUrl } } : {}) });
    try { return await browser.newContext({ locale: 'en-US', timezoneId: 'UTC' }); }
    catch (e) { await browser.close(); throw e; }
  }
  private async open(): Promise<Page> {
    // Share the initialization promise so concurrent queries cannot launch orphan browsers.
    this.context ??= this.createContext().catch(e => { this.context = undefined; throw e; });
    const page = await (await this.context).newPage();
    page.setDefaultTimeout(15000);
    try {
      // Tweets are enriched through public oEmbed, not by loading executable embed scripts.
      await page.route('**/*', async route => {
        const request = route.request();
        if (['image', 'media', 'font'].includes(request.resourceType()) || request.url().includes('/embed/Tweet.html')) await route.abort();
        else await route.continue();
      });
      await page.goto(this.discovery.pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const text = await page.locator('body').innerText();
      if (/verify you are human|checking your browser|unusual traffic|automated traffic|captcha/i.test(text)) throw new SourceError('PUBLIC_UI_CHALLENGE', 'Public repository asks for human verification. This Actor does not solve or bypass challenges.');
      await page.getByRole('textbox').first().waitFor({ timeout: 45000 });
      return page;
    } catch (e) { await page.close(); throw e; }
  }
  async probe() {
    try { const page = await this.open(); await page.close(); return true; }
    catch (e) { this.logger.warning('Anonymous browser probe unavailable.', { errorClass: e instanceof SourceError ? e.code : 'BROWSER_UNAVAILABLE', ...(e instanceof SourceError ? { reason: e.message } : {}) }); return false; }
  }
  private async chooseAdvertiser(page: Page, handle: string): Promise<Advertiser> {
    const path = this.discovery.uiUserPath;
    const [r] = await Promise.all([
      page.waitForResponse(r => path ? new URL(r.url()).pathname === path : r.url().includes('/users/search.json'), { timeout: 45000 }),
      page.getByRole('textbox').first().fill(handle),
    ]);
    if (!r.ok()) throw new SourceError('PUBLIC_UI_SEARCH_FAILED', `Anonymous advertiser lookup returned HTTP ${r.status()}.`, r.status() === 429 || r.status() >= 500);
    const data: unknown = JSONbig({ storeAsString: true }).parse(await r.text());
    const found = Array.isArray(data) ? data.find(v => String(record(v).screen_name).toLowerCase() === handle.toLowerCase()) : data;
    const advertiser = userFromResponse(record(found), handle);
    await page.getByText(`@${advertiser.handle}`, { exact: true }).last().click();
    return advertiser;
  }
  async resolveAdvertiser(handle: string) {
    const page = await this.open();
    try { return await this.chooseAdvertiser(page, handle); } finally { await page.close(); }
  }
  async search(q: Query): Promise<RecordData> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.searchOnce(q); }
      catch (e) {
        if (!(e instanceof SourceError) || e.code !== 'SOURCE_BUSY' || attempt >= this.maxRetries) throw e;
        this.logger.warning('Public browser query temporarily unavailable; retrying in a fresh page.', { queryKey: q.key, status: e.status, attempt: attempt + 1 });
        await sleep(Math.max(backoff(attempt), e.retryAfterMs ?? 0));
      }
    }
  }
  private async searchOnce(q: Query): Promise<RecordData> {
    const page = await this.open();
    let stage = 'selecting the advertiser';
    try {
      if (!q.advertiser.handle) throw new SourceError('UI_NUMERIC_ID_NEEDS_EXPORT', 'The public UI requires a handle to select an account. For numeric-only advertisers use export mode with xBearerToken.');
      if (BigInt(q.advertiser.userId) > BigInt(Number.MAX_SAFE_INTEGER)) throw new SourceError('UI_UNSAFE_ADVERTISER_ID', 'The public page rounds this advertiser ID. Use export mode with a permitted xBearerToken to preserve its identity.');
      await this.chooseAdvertiser(page, q.advertiser.handle);
      stage = 'selecting served countries';
      // Labels and the caret are separate elements; checkbox glyphs have no fixed spacing.
      await page.getByText('▼', { exact: true }).click();
      const allSelected = page.getByRole('button', { name: /^☑\s*Entire EU$/ });
      if (await allSelected.count()) await allSelected.click();
      for (const code of this.discovery.countries) {
        const selected = page.getByRole('button', { name: new RegExp(`^☑\\s*${countryLabel(code)}$`) });
        if (await selected.count() && !q.countries.includes(code)) await selected.click();
      }
      for (const code of q.countries) {
        const unchecked = page.getByRole('button', { name: new RegExp(`^☐\\s*${countryLabel(code)}$`) });
        if (await unchecked.count()) await unchecked.click();
      }
      await page.getByText('▲', { exact: true }).click();
      stage = 'selecting the date range';
      const dateButton = page.getByRole('button', { name: /^(Today|Yesterday|Last 7 days|This quarter|Last quarter|This year|\d{4}-\d{2}-\d{2}.*)$/ });
      await dateButton.first().click();
      const selects = page.locator('select');
      if (await selects.count() !== 4) throw new SourceError('UI_SCHEMA_DRIFT', 'Anonymous UI date controls changed; select export mode or update the browser adapter.');
      const start = new Date(q.startDate); const end = new Date(q.endDate);
      const currentMonth = new Date().toISOString().slice(0, 7);
      const startMonth = q.startDate.slice(0, 7), endMonth = q.endDate.slice(0, 7);
      const setMonth = async (side: number, date: Date) => {
        await selects.nth(side * 2 + 1).selectOption({ label: String(date.getUTCFullYear()) });
        await selects.nth(side * 2).selectOption({ label: date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
      };
      // The two calendars must show distinct months. A range in the current month
      // uses the right calendar; older single-month ranges use the left calendar.
      if (startMonth === currentMonth) await setMonth(1, start);
      else await setMonth(0, start);
      if (endMonth !== startMonth) await setMonth(1, end);
      // Adjacent-month cells can have the same date attributes but be hidden.
      const dayCell = (date: Date) => page.locator(`[role="gridcell"][data-year="${date.getUTCFullYear()}"][data-month="${date.getUTCMonth()}"][data-day="${date.getUTCDate()}"]:visible`).first();
      await dayCell(start).click();
      await dayCell(end).click();
      stage = 'submitting the report';
      if (!this.discovery.uiSearchPath) throw new SourceError('UI_SERVICE_NOT_DISCOVERED', 'Public UI search service was not discovered.');
      const [r] = await Promise.all([
        page.waitForResponse(r => {
          return new URL(r.url()).pathname === this.discovery.uiSearchPath && r.request().method() === 'POST';
        }, { timeout: 90000 }),
        page.getByRole('button', { name: 'Create report', exact: true }).click(),
      ]);
      const body = record(JSONbig({ storeAsString: true }).parse(r.request().postData() ?? '{}'));
      if (String(body.userId) !== q.advertiser.userId || body.startDate !== q.startDate || body.endDate !== addDays(q.endDate, 1)
        || !Array.isArray(body.countries) || JSON.stringify([...body.countries].sort()) !== JSON.stringify([...q.countries].sort())) {
        const actual = { userId: body.userId, countries: body.countries, startDate: body.startDate, endDate: body.endDate };
        throw new SourceError('UI_QUERY_SCOPE_MISMATCH', `The public page submitted a different scope: ${JSON.stringify(actual)}. No mismatched rows were accepted.`);
      }
      const text = await r.text();
      if (!r.ok()) {
        const error = classify(r.status(), text);
        error.retryAfterMs = retryAfter(r.headers()['retry-after'] ?? null);
        throw error;
      }
      // X shows the same empty state on HTTP failure. Only valid response data
      // counts; closing the page also cancels its unrelated export dialog.
      try { return record(JSONbig({ storeAsString: true }).parse(text)); }
      catch { throw new SourceError('INVALID_SOURCE_JSON', 'Public UI returned invalid JSON; query completeness cannot be established.'); }
    } catch (e) {
      if (e instanceof SourceError) throw e;
      throw new SourceError(e instanceof playwrightErrors.TimeoutError ? 'UI_INTERACTION_TIMEOUT' : 'UI_INTERACTION_FAILED', `Public UI failed while ${stage}: ${safeReason(e)}`, e instanceof playwrightErrors.TimeoutError);
    } finally { await page.close(); }
  }
  async close() {
    const context = await this.context?.catch(() => undefined);
    const browser = context?.browser();
    await context?.close(); await browser?.close(); this.context = undefined;
  }
}
export class UiAdapter implements SourceAdapter {
  readonly name = 'ui';
  private transport?: UiTransport;
  constructor(private input: Input, private httpTransport: UiTransport, private browserTransport: UiTransport, private logger: Logger) {}
  capabilities(): Capabilities { return { keywordSearch: false, targetingSearch: false, creativeContent: false, landingUrls: false, multiCountryQueries: true }; }
  async probe() {
    if (this.input.enablePublicUiTransport) {
      this.logger.warning('Using feature-gated, undocumented public UI HTTP transport; browser/export fallback remains available.');
      if (await this.httpTransport.probe()) { this.transport = this.httpTransport; return true; }
      this.logger.warning('Public UI HTTP probe failed; trying the anonymous browser.');
    }
    if (await this.browserTransport.probe()) { this.transport = this.browserTransport; return true; }
    return false;
  }
  async resolveAdvertiser(value: string): Promise<Advertiser> {
    if (/^\d+$/.test(value)) return { userId: value, handle: null, name: null, profileUrl: null };
    if (!this.transport) throw new SourceError('UI_UNAVAILABLE', 'Anonymous UI transport is not available.');
    return this.transport.resolveAdvertiser(value);
  }
  search(query: Query): SearchResult {
    const d = deferred<QueryOutcome>();
    const ads = (async function* (this: UiAdapter) {
      let rows = 0;
      try {
        if (!this.transport) throw new SourceError('UI_UNAVAILABLE', 'Anonymous UI transport unavailable.');
        let data: RecordData;
        try { data = await this.transport.search(query); }
        catch (e) {
          if (this.transport !== this.httpTransport) throw e;
          this.logger.warning('Public UI HTTP query failed; retrying scope through ordinary anonymous browser interaction.', { queryKey: query.key });
          data = await this.browserTransport.search(query);
        }
        if (!Array.isArray(data.ads) || data.errors || data.error) throw new SourceError('INVALID_UI_RESPONSE', 'UI result response lacks a valid ads array.');
        this.logger.info('Public UI response received.', { queryKey: query.key, rawRows: data.ads.length, completenessVerified: data.complete === true || data.isComplete === true });
        for (const row of data.ads) { rows++; yield record(row); }
        d.resolve(uiOutcome(data, rows));
      } catch (e) {
        const code = e instanceof SourceError ? e.code : 'UI_QUERY_ERROR';
        const details = e instanceof SourceError ? e.message : 'Public UI query failed unexpectedly. Inspect the browser adapter and source availability.';
        this.logger.warning('Public UI query did not complete.', { queryKey: query.key, errorClass: code, reason: details });
        d.resolve({ status: rows ? 'partial' : 'failed', reason: code, details, retryable: e instanceof SourceError && e.retryable, rows });
      }
    }).call(this);
    return { ads, outcome: d.promise };
  }
  async close() { await this.httpTransport.close(); await this.browserTransport.close(); }
}
