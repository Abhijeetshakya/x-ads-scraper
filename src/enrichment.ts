import { load } from 'cheerio';
import { Http, SourceError, publicUrl } from './http.js';
import { deriveName, refreshAvailability } from './normalize.js';
import type { Ad, Asset, Creative, Input, Logger, RecordData, Store } from './types.js';
import { hash, number, record, str } from './util.js';

export interface CachedEnrichment { cachedAt: string; creative: Creative }
export function cacheValid(cache: CachedEnrichment, now = Date.now()): boolean {
  return now - Date.parse(cache.cachedAt) < 30 * 86400000 && !['error', 'rate_limited'].includes(cache.creative.enrichmentStatus);
}
export function parseOembed(data: RecordData): { text: string | null; authorName: string | null; links: string[]; assets: Asset[] } {
  const $ = load(typeof data.html === 'string' ? data.html : '');
  $('script,style').remove();
  const paragraph = $('blockquote p').first();
  paragraph.find('br').replaceWith('\n');
  const text = paragraph.length ? paragraph.text().trim() || null : null;
  const links = paragraph.find('a[href]').map((_, el) => $(el).attr('href')!).get().filter(s => /^https?:\/\//i.test(s));
  // oEmbed's normal HTML contains no complete media list. Thumbnails alone are not all creative assets.
  const assets: Asset[] = [];
  for (const image of paragraph.find('img').toArray()) {
    const url = $(image).attr('src');
    if (url && /^https:\/\/(?:pbs\.twimg\.com|video\.twimg\.com)\//.test(url)) assets.push({ type: 'image', url, width: number($(image).attr('width')), height: number($(image).attr('height')), durationMs: null });
  }
  return { text, authorName: str(data.author_name), links, assets };
}
export function tokenizeCreative(creative: Creative) {
  const text = creative.text ?? '';
  creative.hashtags = [...new Set([...text.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}_]+)/gu)].map(m => m[1]))];
  creative.mentions = [...new Set([...text.matchAll(/(?:^|[^\w])@([A-Za-z0-9_]{1,15})\b/g)].map(m => m[1]))];
  if (creative.landingUrl) {
    try {
      const url = new URL(creative.landingUrl); creative.landingDomain = url.hostname; creative.landingDomainSource = 'derived_landing_url';
      creative.utm = Object.fromEntries([...url.searchParams].filter(([k]) => /^utm_/i.test(k)).map(([k, v]) => [k.toLowerCase(), v]));
    } catch { creative.landingDomain = null; creative.landingDomainSource = 'invalid_landing_url'; }
  }
}
export async function resolveLanding(http: Http, value: string): Promise<string> {
  let current = value;
  const deadline = Date.now() + 20000;
  for (let i = 0; i < 5; i++) {
    await publicUrl(current, http.testMode);
    const url = new URL(current);
    if (i > 0 && url.hostname !== 't.co') return current; // Do not crawl arbitrary landing websites.
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SourceError('LANDING_TIMEOUT', 'Landing-link resolution exceeded its time cap.', true);
    const response = await http.request(current, { method: 'HEAD', timeoutMs: Math.min(remaining, 5000), retries: 0, safePublic: true });
    const next = response.headers.get('location'); await response.body?.cancel();
    if (response.status < 300 || !next) return current;
    current = new URL(next, current).href;
  }
  throw new SourceError('LANDING_REDIRECT_LIMIT', 'Landing link exceeded five redirects.');
}
export class Enricher {
  private startedAt = new Date().toISOString();
  private inflight = new Map<string, Promise<CachedEnrichment>>();
  constructor(private input: Input, private http: Http, private store: Store, private logger: Logger, private base = 'https://publish.twitter.com') {}
  async enrich(ad: Ad): Promise<Ad> {
    if (!this.input.enrichCreatives && !this.input.lookupMedia) { tokenizeCreative(ad.creative); deriveName(ad); refreshAvailability(ad); return ad; }
    const key = `CREATIVE-${ad.tweetId}-${hash(`${this.input.lookupMedia}|${this.input.resolveLandingUrls}`)}`;
    let cached = await this.store.getValue<CachedEnrichment>(key);
    if (!cached || (!cacheValid(cached) && cached.cachedAt < this.startedAt)) {
      let promise = this.inflight.get(key);
      if (!promise) { promise = this.fetch(ad); this.inflight.set(key, promise); }
      try { cached = await promise; await this.store.setValue(key, cached); }
      finally { this.inflight.delete(key); }
    }
    // Repository disclosures have priority over enrichment; failed enrichment never clears them.
    const previous = ad.creative;
    ad.creative = structuredClone(cached.creative);
    if (previous.text) { ad.creative.text = previous.text; ad.creative.textSource = previous.textSource; }
    if (previous.landingUrl) { ad.creative.landingUrl = previous.landingUrl; ad.creative.landingUrlStatus = previous.landingUrlStatus; }
    if (previous.assetCount !== null) { ad.creative.assets = previous.assets; ad.creative.assetCount = previous.assetCount; ad.creative.assetCountSource = previous.assetCountSource; }
    tokenizeCreative(ad.creative); deriveName(ad); refreshAvailability(ad); return ad;
  }
  private async fetch(ad: Ad): Promise<CachedEnrichment> {
    const creative = structuredClone(ad.creative);
    let links: string[] = [];
    try {
      if (this.input.enrichCreatives) {
        const data = await this.http.json(`${this.base}/oembed?url=${encodeURIComponent(ad.adUrl)}&omit_script=true&dnt=true`, { maxBytes: 1e6 });
        const parsed = parseOembed(data);
        creative.text = parsed.text; creative.textSource = parsed.text ? 'public_oembed' : 'oembed_text_unavailable';
        creative.authorName = parsed.authorName; creative.authorNameSource = parsed.authorName ? 'public_oembed' : 'not_disclosed';
        links = parsed.links;
        creative.enrichmentStatus = parsed.text ? 'ok' : 'error';
        if (this.input.lookupMedia && parsed.assets.length) {
          creative.assets = parsed.assets;
          creative.assetCount = null; creative.assetCountSource = 'partial_embed_assets_only';
          creative.mediaType = 'image'; creative.mediaTypeSource = 'public_embed_observed_assets';
        }
      }
      if (this.input.lookupMedia && this.input.xBearerToken) await this.media(ad.tweetId, creative);
      const candidates = creative.landingUrl ? [creative.landingUrl] : links.filter(link => {
        const url = new URL(link);
        return !/(^|\.)(x|twitter)\.com$/.test(url.hostname) && !/(^|\.)(pic\.twitter\.com|pbs\.twimg\.com)$/.test(url.hostname);
      });
      if (candidates.length > 1 && !creative.landingUrl) {
        creative.landingUrlStatus = 'multiple_public_links_destination_ambiguous';
      } else if (candidates.length && this.input.resolveLandingUrls) {
        for (const candidate of candidates.slice(0, 5)) {
          try {
            const url = new URL(candidate);
            const resolved = url.hostname === 't.co' ? await resolveLanding(this.http, candidate) : candidate;
            await publicUrl(resolved, this.http.testMode);
            if (/(^|\.)(x|twitter)\.com$/.test(new URL(resolved).hostname)) continue;
            creative.landingUrl = resolved; creative.landingUrlStatus = url.hostname === 't.co' ? 'resolved_public_tco' : 'public_oembed_link'; break;
          } catch (e) { creative.landingUrlStatus = e instanceof SourceError ? e.code.toLowerCase() : 'landing_resolution_error'; }
        }
      } else if (candidates.length && !creative.landingUrl) { creative.landingUrl = candidates[0]; creative.landingUrlStatus = 'public_oembed_link_unresolved'; }
    } catch (e) {
      const error = e instanceof SourceError ? e : null;
      creative.enrichmentStatus = error?.status === 404 || error?.status === 410 ? 'deleted_or_unavailable' : error?.status === 429 ? 'rate_limited' : 'error';
      if (!creative.text) creative.textSource = creative.enrichmentStatus;
      this.logger.warning('Creative enrichment failed softly; repository metrics retained.', { tweetId: ad.tweetId, status: creative.enrichmentStatus });
    }
    tokenizeCreative(creative);
    return { cachedAt: new Date().toISOString(), creative };
  }
  private async media(id: string, creative: Creative) {
    try {
      const api = this.http.testMode && process.env.XADS_TEST_BASE_URL ? process.env.XADS_TEST_BASE_URL : 'https://api.x.com';
      const data = await this.http.json(`${api}/2/tweets/${id}?expansions=attachments.media_keys&media.fields=type,url,width,height,duration_ms,variants,preview_image_url&tweet.fields=attachments,text`, { headers: { authorization: `Bearer ${this.input.xBearerToken}` }, maxBytes: 2e6 });
      const media = record(data.includes).media;
      if (Array.isArray(media) && record(data.data).attachments) {
        const keys = record(record(data.data).attachments).media_keys;
        const selected = media.filter(m => Array.isArray(keys) && keys.includes(record(m).media_key));
        creative.assets = selected.map(v => {
          const m = record(v); const variants = Array.isArray(m.variants) ? m.variants.map(record).filter(v => v.content_type === 'video/mp4').sort((a, b) => (number(b.bit_rate) ?? 0) - (number(a.bit_rate) ?? 0)) : [];
          return { type: str(m.type), url: str(m.url ?? variants[0]?.url), width: number(m.width), height: number(m.height), durationMs: number(m.duration_ms) };
        });
        const complete = Array.isArray(keys) && selected.length === keys.length;
        creative.assetCount = complete ? selected.length : null; creative.assetCountSource = complete ? 'official_x_api_v2' : 'partial_official_media_metadata';
        creative.mediaType = selected.length > 1 ? 'carousel' : selected[0] ? String(record(selected[0]).type).replace('photo', 'image').replace('animated_gif', 'gif') : 'unknown';
        creative.mediaTypeSource = 'official_x_api_v2';
      }
    } catch { this.logger.warning('Optional official media lookup unavailable; creative asset count remains unknown.'); }
  }
}
