import type { Capabilities, Input, Logger } from './types.js';
import { addDays, day, hash, stable } from './util.js';

export const EU27 = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');
export const FALLBACK_COUNTRIES = [...EU27, 'IS', 'LI', 'NO'];
export const defaults: Input = {
  advertisers: [], countries: ['FR'], marketPreset: 'Custom', startDate: '90 days', endDate: '0 days',
  keywords: [], excludeKeywords: [], keywordMatch: 'any', keywordFields: ['creativeText', 'advertiser', 'targeting', 'landingUrl'],
  caseSensitive: false, targetedLocations: [], minImpressions: null, minReach: null,
  approvalStatuses: [], fundingTypes: [], mediaTypes: [], strictFilters: false,
  enrichCreatives: true, resolveLandingUrls: true, lookupMedia: false,
  mode: 'snapshot', notifyOn: ['NEW', 'CHANGED', 'REMOVED'], removalGraceRuns: 2, metricChangeThresholdPercent: null,
  notifyMaxItems: 10, notifyOnEmpty: false, exportFormats: ['csv', 'json', 'xlsx', 'html'], includeRaw: false,
  sortBy: 'impressions', maxAdsPerAdvertiser: null, maxItems: null, sourceMode: 'auto', concurrency: 2,
  requestDelayMs: 1000, maxRetries: 3, jobTimeoutMinutes: 15, maxExportJobs: 100,
  proxyConfiguration: { useApifyProxy: false }, enablePublicUiTransport: true, monitorStoreName: 'x-ads-monitor-state',
};
export function parseAdvertiser(v: string): string {
  const value = v.trim();
  if (/^\d+$/.test(value)) return BigInt(value).toString();
  let handle = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname) || url.search || url.hash || url.username || url.password)
      throw new Error(`Invalid advertiser profile URL: use x.com/handle or twitter.com/handle.`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) throw new Error('Advertiser URL must point to a profile, not a post or search.');
    handle = parts[0];
  }
  handle = handle.replace(/^@/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle) || ['home', 'search', 'i', 'intent', 'explore', 'settings'].includes(handle.toLowerCase()))
    throw new Error('Invalid advertiser: supply a handle (1–15 letters, digits or underscores), profile URL, or numeric user ID.');
  return handle.toLowerCase();
}
export function parseDate(value: string, now = new Date()): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value);
    if (Number.isFinite(d.valueOf()) && day(d) === value) return value;
  }
  const m = /^(\d+)\s+(day|week|month|year)s?$/i.exec(value.trim());
  if (m) {
    const n = Number(m[1]);
    if (n > 36500) throw new Error('Relative dates must be within 100 years.');
    const d = new Date(`${day(now)}T00:00:00Z`);
    if (m[2].toLowerCase() === 'day') return addDays(day(d), -n);
    if (m[2].toLowerCase() === 'week') return addDays(day(d), -n * 7);
    const originalDay = d.getUTCDate();
    d.setUTCDate(1);
    if (m[2].toLowerCase() === 'month') d.setUTCMonth(d.getUTCMonth() - n);
    else d.setUTCFullYear(d.getUTCFullYear() - n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(originalDay, last));
    return day(d);
  }
  throw new Error('Invalid date: use a real YYYY-MM-DD date or a relative date such as "30 days".');
}
export function validateInput(raw: Partial<Input>, logger: Logger, now = new Date()): Input {
  const input: Input = { ...defaults, ...raw };
  const lists = ['advertisers', 'countries', 'keywords', 'excludeKeywords', 'keywordFields', 'targetedLocations', 'approvalStatuses', 'fundingTypes', 'mediaTypes', 'notifyOn', 'exportFormats'] as const;
  for (const field of lists) {
    if (!Array.isArray(input[field]) || input[field].some(v => typeof v !== 'string')) throw new Error(`${field} must be an array of strings.`);
  }
  if (input.advertisers.length > 200) throw new Error('At most 200 advertisers are allowed; split the input into tasks.');
  input.advertisers = [...new Set(input.advertisers.map(parseAdvertiser))];
  const enums: Record<string, string[]> = {
    sourceMode: ['auto', 'export', 'api', 'ui'], mode: ['snapshot', 'monitor'], keywordMatch: ['any', 'all'],
    sortBy: ['impressions', 'reach', 'recency', 'advertiser'], marketPreset: ['EU27', 'DACH', 'Nordics', 'Benelux', 'UK & Ireland', 'All supported', 'Custom'],
  };
  for (const [k, values] of Object.entries(enums)) if (!values.includes(String(input[k as keyof Input]))) throw new Error(`Invalid ${k}. Choose ${values.join(', ')}.`);
  const ints: [keyof Input, number, number][] = [['concurrency', 1, 10], ['requestDelayMs', 0, 60000], ['maxRetries', 0, 10], ['maxExportJobs', 1, 10000], ['removalGraceRuns', 1, 100], ['notifyMaxItems', 1, 100]];
  for (const [k, min, max] of ints) if (!Number.isInteger(input[k]) || Number(input[k]) < min || Number(input[k]) > max) throw new Error(`${k} must be an integer between ${min} and ${max}.`);
  if (!Number.isFinite(input.jobTimeoutMinutes) || input.jobTimeoutMinutes < 1 || input.jobTimeoutMinutes > 120) throw new Error('jobTimeoutMinutes must be between 1 and 120.');
  for (const k of ['minImpressions', 'minReach', 'metricChangeThresholdPercent', 'maxItems', 'maxAdsPerAdvertiser'] as const) {
    const n = input[k];
    if (n !== null && (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n) && k.startsWith('max'))) throw new Error(`${k} must be null or a non-negative finite number.`);
    if (k.startsWith('max') && n === 0) throw new Error(`${k} must be at least 1 or null for no limit.`);
  }
  input.startDate = parseDate(input.startDate, now); input.endDate = parseDate(input.endDate, now);
  if (input.startDate > input.endDate) throw new Error('startDate must be on or before endDate.');
  if (input.endDate > day(now)) { logger.warning('endDate clamped to today (UTC).'); input.endDate = day(now); }
  if (input.startDate > input.endDate) throw new Error('Date range contains only future dates.');
  if (input.keywordFields.some(f => !['creativeText', 'advertiser', 'targeting', 'landingUrl'].includes(f))) throw new Error('keywordFields contains an unsupported field.');
  if ((input.keywords.length || input.excludeKeywords.length) && input.keywordFields.length === 0) throw new Error('Select at least one keywordFields value.');
  if (input.keywordFields.includes('creativeText') && !input.enrichCreatives) { input.enrichCreatives = true; logger.info('Enabled enrichCreatives because keywordFields includes creativeText.'); }
  if (input.exportFormats.some(f => !['csv', 'json', 'xlsx', 'html'].includes(f))) throw new Error('exportFormats must contain csv, json, xlsx or html.');
  if (input.mediaTypes.some(f => !['text', 'image', 'video', 'gif', 'carousel', 'unknown'].includes(f))) throw new Error('Invalid mediaTypes.');
  if (input.notifyOn.some(f => !['NEW', 'CHANGED', 'REMOVED'].includes(f))) throw new Error('Invalid notifyOn.');
  for (const field of ['webhookUrl', 'slackWebhookUrl', 'discordWebhookUrl'] as const) {
    if (input[field]) { const u = new URL(input[field]!); if (u.protocol !== 'https:' && !(process.env.XADS_TEST_MODE === '1' && u.hostname === '127.0.0.1')) throw new Error(`${field} must use HTTPS.`); }
  }
  if (input.webhookUrl && !input.webhookSecret) throw new Error('Supply webhookSecret when webhookUrl is set, so every generic digest can be HMAC-signed.');
  if (!/^[\w-]{1,100}$/.test(input.monitorStoreName)) throw new Error('monitorStoreName must use 1–100 letters, digits, underscores or hyphens.');
  return input;
}
export function applyScope(input: Input, supported: string[], earliest: string, caps: Capabilities, logger: Logger): Input {
  if (!input.advertisers.length && !caps.keywordSearch) throw new Error('This source cannot search ad content globally. Supply at least one advertiser handle or numeric user ID; keywords then filter those advertisers’ results after enrichment.');
  if (!input.advertisers.length && !input.keywords.length) throw new Error('Supply advertisers or a keyword on an adapter that supports content search.');
  const presets: Record<string, string[]> = {
    EU27, DACH: ['DE', 'AT', 'CH'], Nordics: ['DK', 'FI', 'SE', 'NO', 'IS'], Benelux: ['BE', 'NL', 'LU'],
    'UK & Ireland': ['GB', 'IE'], 'All supported': supported,
  };
  const countries = presets[input.marketPreset] ?? input.countries;
  input.countries = [...new Set(countries.map(c => c.trim().toUpperCase()))].filter(c => {
    if (supported.includes(c)) return true;
    logger.warning('Unsupported served country skipped.', { country: c }); return false;
  });
  if (!input.countries.length) throw new Error('No supported countries remain. Choose an EU country or All supported.');
  if (input.startDate < earliest) { input.startDate = earliest; logger.warning('startDate clamped to the repository minimum.', { earliest }); }
  if (input.endDate < input.startDate) throw new Error(`Date range ends before the repository minimum ${earliest}.`);
  return input;
}
export function chunks(start: string, end: string, days = 90): { startDate: string; endDate: string }[] {
  const result = [];
  for (let from = start; from <= end; from = addDays(from, days)) result.push({ startDate: from, endDate: [addDays(from, days - 1), end].sort()[0] });
  return result;
}
export function monitorKey(input: Input): string {
  if (input.monitorKey) return hash(input.monitorKey);
  // Served countries are included; date window is separate scope protection in monitor state.
  return hash(stable(Object.fromEntries(Object.entries(input).filter(([k]) => ['advertisers', 'countries', 'keywords', 'excludeKeywords', 'keywordMatch', 'keywordFields', 'caseSensitive', 'targetedLocations', 'minImpressions', 'minReach', 'approvalStatuses', 'fundingTypes', 'mediaTypes', 'strictFilters'].includes(k)))));
}
export function fingerprint(input: Input): string {
  const { xBearerToken: _token, webhookSecret: _secret, webhookUrl: _url, slackWebhookUrl: _slack, discordWebhookUrl: _discord, proxyConfiguration: _proxy, ...safe } = input;
  return hash(stable(safe), 'sha256');
}
