import JSONbig from 'json-bigint';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { Http, SourceError } from '../http.js';
import type { Advertiser, Capabilities, Input, Logger, Query, QueryOutcome, RecordData, SearchResult, SourceAdapter } from '../types.js';
import { addDays, deferred, record, str } from '../util.js';
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
  private browser?: Browser;
  private context?: BrowserContext;
  constructor(private discovery: Discovery, private logger: Logger, private proxyUrl?: string) {}
  private async open(): Promise<Page> {
    this.browser ??= await chromium.launch({ headless: true, ...(this.proxyUrl ? { proxy: { server: this.proxyUrl } } : {}) });
    this.context ??= await this.browser.newContext({ locale: 'en-US', timezoneId: 'UTC' });
    const page = await this.context.newPage();
    // Tweets are enriched through public oEmbed, not by loading executable embed scripts.
    await page.route('**/*', async route => {
      const request = route.request();
      if (['image', 'media', 'font'].includes(request.resourceType()) || request.url().includes('/embed/Tweet.html')) await route.abort();
      else await route.continue();
    });
    await page.goto(this.discovery.pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const text = await page.locator('body').innerText();
    if (/verify you are human|checking your browser|unusual traffic|automated traffic|captcha/i.test(text)) { await page.close(); throw new SourceError('PUBLIC_UI_CHALLENGE', 'Public repository asks for human verification. This Actor does not solve or bypass challenges.'); }
    await page.getByRole('textbox').first().waitFor({ timeout: 45000 });
    return page;
  }
  async probe() {
    try { const page = await this.open(); await page.close(); return true; }
    catch (e) { this.logger.warning('Anonymous browser probe unavailable.', { errorClass: e instanceof SourceError ? e.code : 'BROWSER_UNAVAILABLE' }); return false; }
  }
  private async chooseAdvertiser(page: Page, handle: string): Promise<Advertiser> {
    const path = this.discovery.uiUserPath;
    const response = page.waitForResponse(r => path ? new URL(r.url()).pathname === path : r.url().includes('/users/search.json'), { timeout: 45000 });
    await page.getByRole('textbox').first().fill(handle);
    const r = await response;
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
    const page = await this.open();
    try {
      if (!q.advertiser.handle) throw new SourceError('UI_NUMERIC_ID_NEEDS_EXPORT', 'The public UI requires a handle to select an account. For numeric-only advertisers use export mode with xBearerToken.');
      await this.chooseAdvertiser(page, q.advertiser.handle);
      const countryTrigger = page.getByText(new RegExp(`^(?:${this.discovery.countries.map(countryLabel).join('|')}|Entire EU) [▼▲]$`));
      await countryTrigger.click();
      const allSelected = page.getByRole('button', { name: /☑ Entire EU/ });
      if (await allSelected.count()) await allSelected.click();
      for (const code of this.discovery.countries) {
        const selected = page.getByRole('button', { name: `☑ ${countryLabel(code)}`, exact: true });
        if (await selected.count() && !q.countries.includes(code)) await selected.click();
      }
      for (const code of q.countries) {
        const unchecked = page.getByRole('button', { name: `☐ ${countryLabel(code)}`, exact: true });
        if (await unchecked.count()) await unchecked.click();
      }
      await page.getByRole('heading', { name: 'Ads Repository', exact: true }).first().click();
      const dateButton = page.getByRole('button', { name: /^(Today|Yesterday|Last 7 days|Last quarter|This year|\d{4}-\d{2}-\d{2}.*)$/ });
      await dateButton.first().click();
      const selects = page.locator('select');
      if (await selects.count() !== 4) throw new SourceError('UI_SCHEMA_DRIFT', 'Anonymous UI date controls changed; select export mode or update the browser adapter.');
      const start = new Date(q.startDate); const end = new Date(q.endDate);
      // Dropdown option labels are observed in the date picker; their values may change.
      await selects.nth(1).selectOption({ label: String(start.getUTCFullYear()) });
      await selects.nth(0).selectOption({ label: start.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
      await selects.nth(3).selectOption({ label: String(end.getUTCFullYear()) });
      await selects.nth(2).selectOption({ label: end.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
      const response = page.waitForResponse(r => {
        if (!this.discovery.uiSearchPath || new URL(r.url()).pathname !== this.discovery.uiSearchPath) return false;
        try { const body = record(JSONbig({ storeAsString: true }).parse(r.request().postData() ?? '{}')); return String(body.userId) === q.advertiser.userId && body.startDate === q.startDate && body.endDate === addDays(q.endDate, 1) && JSON.stringify(body.countries) === JSON.stringify(q.countries); }
        catch { return false; }
      }, { timeout: 90000 });
      const tables = page.getByRole('table');
      await tables.nth(0).getByRole('cell', { name: String(start.getUTCDate()), exact: true }).click();
      await tables.nth(start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear() ? 0 : 1).getByRole('cell', { name: String(end.getUTCDate()), exact: true }).click();
      const r = await response;
      if (!r.ok()) throw new SourceError('PUBLIC_UI_QUERY_FAILED', `Anonymous UI query returned HTTP ${r.status()}.`, r.status() === 429 || r.status() >= 500);
      const data = record(JSONbig({ storeAsString: true }).parse(await r.text()));
      // The response belongs to a user-visible query; read a settled result heading as a UI check.
      await page.getByText(/promoted tweets? found|No promoted tweets found/).first().waitFor({ timeout: 15000 });
      return data;
    } finally { await page.close(); }
  }
  async close() { await this.context?.close(); await this.browser?.close(); }
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
        for (const row of data.ads) { rows++; yield record(row); }
        d.resolve(uiOutcome(data, rows));
      } catch (e) { d.resolve({ status: rows ? 'partial' : 'failed', reason: e instanceof SourceError ? e.code : 'UI_QUERY_ERROR', retryable: e instanceof SourceError && e.retryable, rows }); }
    }).call(this);
    return { ads, outcome: d.promise };
  }
  async close() { await this.httpTransport.close(); await this.browserTransport.close(); }
}
