import { Http, SourceError } from '../http.js';
import { FALLBACK_COUNTRIES } from '../input.js';
import type { Logger } from '../types.js';

export interface Discovery {
  countries: string[]; countriesVerified: boolean; earliestDate: string;
  operations: { create?: string; status?: string };
  uiSearchPath?: string; uiUserPath?: string; pageUrl: string;
}
export function analyzeAssets(assets: string[], pageUrl: string): Discovery {
  const text = assets.join('\n');
  const operations: Discovery['operations'] = {};
  for (const [key, name] of [['create', 'CreateExportReportMutation'], ['status', 'GetExportReportStatusQuery']] as const) {
    const m = new RegExp(`params:\\s*\\{id:\\s*["']([\\w-]+)["'],metadata:\\s*\\{[^}]*\\},name:\\s*["']${name}["']`).exec(text);
    if (m) operations[key] = m[1];
  }
  const values = new Map<string, string>();
  for (const m of text.matchAll(/([A-Z][A-Za-z]+):"([A-Z]{2})"/g)) values.set(m[1], m[2]);
  const list = /Object\.freeze\(\[\{displayValue:[\s\S]*?\}\]\)/.exec(text)?.[0] ?? '';
  const countries = [...new Set([...list.matchAll(/systemValue:\w+\.([A-Za-z]+)/g)].map(m => values.get(m[1])).filter((v): v is string => !!v))];
  const uiSearchPath = /["'](\/ads-repository\/api\/[\w-]*ads[\w-]*search[\w-]*)["']/.exec(text)?.[1];
  const uiUserPath = /["'](\/ads-repository\/api\/[\w-]*user[\w-]*search[\w-]*)["']/.exec(text)?.[1];
  const dates = [...text.matchAll(/new Date\(["'](2023-\d{2}-\d{2})["']\)/g)].map(m => m[1]).sort();
  return { countries: countries.length ? countries : FALLBACK_COUNTRIES, countriesVerified: countries.length > 0, earliestDate: dates[0] ?? '2023-08-26', operations, uiSearchPath, uiUserPath, pageUrl };
}
export function chunkUrls(script: string): string[] {
  const prefix = /\w+\.p="(https:\/\/[^"\s]+\/ads-repository\/)"/.exec(script)?.[1];
  if (!prefix) return [];
  const beforeCss = script.split(/\w+\.miniCssF/)[0];
  const map = new Map([...beforeCss.matchAll(/(\d+):"([a-f0-9]{20})"/g)].map(m => [m[1], m[2]]));
  // Only the page's initial bootstrap imports, not all of Ads Manager's chunks.
  const initial = /Promise\.all\(\[([\s\S]*?)\]\)\.then/.exec(script)?.[1] ?? '';
  const ids = [...initial.matchAll(/\w+\.e\((\d+)\)/g)].map(m => m[1]);
  return [...new Set(ids)].filter(id => map.has(id)).map(id => `${prefix}js/${id}.${map.get(id)}.js`);
}
export async function discover(http: Http, logger: Logger, base: string): Promise<Discovery> {
  const pageUrl = `${base}/ads-repository`;
  const html = await http.text(pageUrl, { maxBytes: 2e6 });
  const scripts = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(m => new URL(m[1], pageUrl).href);
  const assets: string[] = [html];
  for (const url of scripts.slice(0, 5)) {
    const host = new URL(url).hostname;
    if (!['ton.twimg.com', 'ton.twitter.com', new URL(base).hostname].includes(host)) continue;
    const script = await http.text(url, { maxBytes: 3e6 }); assets.push(script);
    for (const chunk of chunkUrls(script).slice(0, 15)) {
      try { assets.push(await http.text(chunk, { maxBytes: 3e6 })); }
      catch (e) { if (e instanceof SourceError && e.status === 404) continue; throw e; }
    }
  }
  const result = analyzeAssets(assets, pageUrl);
  if (!result.countriesVerified) logger.warning('Live country discovery unavailable; fallback EU/EEA list is UNVERIFIED.');
  logger.info('Source capabilities discovered without extracting credentials.', { supportedCountries: result.countries.length, countriesVerified: result.countriesVerified, exportOperationsFound: !!result.operations.create && !!result.operations.status, publicUiServiceFound: !!result.uiSearchPath });
  return result;
}
