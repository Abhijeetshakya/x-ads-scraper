import type { Ad, Creative, Logger, Query, RecordData, Target } from './types.js';
import { bool, hash, iso, number, record, snowflake, stable, str } from './util.js';
import { SourceError } from './http.js';

export const headerKey = (key: string) => key.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<string, string[]> = {
  tweetId: ['tweetid', 'tweetidentifier', 'postid', 'promotedtweetid', 'promotedtweetidstr'],
  lineItemId: ['lineitemid', 'lineitemidentifier', 'campaignlineitemid'],
  accountId: ['accountid', 'accountidstr', 'advertiseraccountid', 'adsaccountid'],
  adId: ['adid', 'advertisementid', 'repositoryadid'],
  country: ['country', 'countrycode', 'geolocationabbreviation', 'servedcountry', 'deliverycountry'],
  impressions: ['impressions', 'impression', 'impressioncount', 'totalimpressions'],
  reach: ['reach', 'totalreach', 'reachcount'],
  impressionsLower: ['impressionslower', 'impressionslowerbound'], impressionsUpper: ['impressionsupper', 'impressionsupperbound'],
  reachLower: ['reachlower', 'reachlowerbound'], reachUpper: ['reachupper', 'reachupperbound'],
  fundingType: ['fundinginstrumenttype', 'fundinginstrumentfundinginstrumenttype', 'fundingtype', 'paymenttype'],
  currency: ['currency', 'fundinginstrumentcurrency', 'fundingcurrency'],
  fundingEntity: ['fundingentity', 'fundinginstrumentfundingentity', 'fundinginstrumententity', 'payer', 'fundedby'],
  approvalStatus: ['approvalstatus', 'promotedtweetapprovalstatus', 'adapprovalstatus', 'status'],
  isHalted: ['ishalted', 'halted'],
  targeting: ['targeting', 'targetingparameters', 'advertisermain targetingparameters'.replace(/ /g, '')],
  targetingName: ['targetingname', 'targetname'], targetingType: ['targetingtype', 'targettype'],
  targetingIncluded: ['targetingincluded', 'included'],
  targetedLocations: ['targetedlocations', 'geotargeting', 'targetlocations'],
  deliveryStart: ['deliverystart', 'startdate', 'deliverystartdate', 'deliveryrangestartdate'],
  deliveryEnd: ['deliveryend', 'enddate', 'deliveryenddate', 'deliveryrangeenddate'],
  creativeText: ['creativetext', 'creativebody', 'tweettext', 'text'],
  landingUrl: ['landingurl', 'destinationurl', 'landingpageurl'],
  authorName: ['authorname', 'creativesauthorname'],
  assets: ['assets', 'creativeassets', 'media'],
  mediaType: ['mediatype', 'creativemediatype'],
};
const aliasLookup = new Map(Object.entries(aliases).flatMap(([k, values]) => values.map(v => [v, k] as const)));
function flatten(row: RecordData, prefix = ''): RecordData {
  const result: RecordData = {};
  for (const [k, v] of Object.entries(row)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !['targeting', 'assets', 'media'].includes(k)) Object.assign(result, flatten(record(v), key));
    else result[key] = v;
  }
  return result;
}
export class SchemaTracker {
  readonly warnings = new Set<string>();
  private warned = false;
  constructor(private logger: Logger) {}
  inspect(row: RecordData): { fields: RecordData; extra: RecordData; drift: boolean } {
    const fields: RecordData = {}; const extra: RecordData = {};
    for (const [key, value] of Object.entries(flatten(row))) {
      const mapped = aliasLookup.get(headerKey(key));
      if (mapped) fields[mapped] = value; else extra[key] = value;
    }
    const missing = ['tweetId', 'lineItemId', 'country', 'impressions', 'reach', 'approvalStatus'].filter(k => !(k in fields));
    const added = Object.keys(extra);
    // Stable ancillary account fields are retained but not classified as unexpected changes.
    const unknown = added.filter(k => !['account.name', 'account.id', 'advertiser', 'advertiser.name', 'advertiser.handle', 'advertiser.userId'].includes(k));
    if (missing.length) this.warnings.add(`MISSING_FIELDS: ${missing.sort().join(', ')}`);
    if (unknown.length) this.warnings.add(`UNKNOWN_FIELDS: ${unknown.sort().join(', ')}`);
    if ((missing.length || unknown.length) && !this.warned) { this.warned = true; this.logger.warning('Source schema drift detected; unmapped fields are retained and missing fields stay null. See SUMMARY.schemaDriftWarnings.'); }
    return { fields, extra, drift: missing.length > 0 };
  }
}
export function emptyCreative(): Creative {
  return {
    text: null, textSource: 'not_disclosed', authorName: null, authorNameSource: 'not_disclosed',
    mediaType: 'unknown', mediaTypeSource: 'not_disclosed', assetCount: null, assetCountSource: 'not_disclosed',
    assets: [], hashtags: [], mentions: [], landingUrl: null, landingUrlStatus: 'not_disclosed',
    landingDomain: null, landingDomainSource: 'not_disclosed', utm: {}, enrichmentStatus: 'not_attempted',
  };
}
function arrayValue(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : [parsed]; }
    catch { return [value]; }
  }
  return value === null || value === undefined || value === '' ? null : [value];
}
export function parseTargeting(f: RecordData): { targeting: Target[]; disclosed: boolean } {
  const values = arrayValue(f.targeting);
  const targets: Target[] = values?.map(v => {
    if (typeof v === 'string') return { name: str(v), type: null, included: null };
    const t = record(v);
    return { type: str(t.type ?? t.targetingType ?? t.targeting_type), name: str(t.name ?? t.targetingName ?? t.targeting_name), included: bool(t.included ?? t.isIncluded ?? t.inclusion) };
  }) ?? [];
  if (!values && (f.targetingName || f.targetingType)) targets.push({ name: str(f.targetingName), type: str(f.targetingType), included: bool(f.targetingIncluded) });
  return { targeting: targets, disclosed: values !== null || targets.length > 0 };
}
export function deriveName(ad: Ad) {
  const utm = ad.creative.utm;
  const campaign = utm.utm_campaign || utm.utm_content;
  if (campaign) { ad.adName = campaign.slice(0, 80); ad.adNameSource = utm.utm_campaign ? 'derived_utm_campaign' : 'derived_utm_content'; }
  else if (ad.creative.text) { ad.adName = ad.creative.text.split(/\r?\n/).find(s => s.trim())!.trim().slice(0, 80); ad.adNameSource = 'derived_creative_headline'; }
  else { ad.adName = `${ad.advertiser.handle ?? ad.advertiser.userId} - ${ad.tweetId}`; ad.adNameSource = 'derived_identity'; }
}
export function refreshAvailability(ad: Ad) {
  const availability: Record<string, string> = {};
  const walk = (value: unknown, prefix: string) => {
    if (value === null) availability[prefix] = 'not_disclosed';
    else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${prefix}[${i}]`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!['availability', 'raw', 'extra', 'previous'].includes(k)) walk(v, prefix ? `${prefix}.${k}` : k);
  };
  walk(ad, '');
  if (ad.adCreatedAt === null) availability.adCreatedAt = ad.adCreatedAtSource;
  if (ad.daysActive === null) availability.daysActive = ad.daysActiveSource;
  for (const k of ['text', 'authorName', 'assetCount', 'landingUrl', 'landingDomain'] as const) {
    if (ad.creative[k] === null) availability[`creative.${k}`] = k === 'landingUrl' ? ad.creative.landingUrlStatus : ad.creative[`${k}Source`];
  }
  if (ad.reach === null) availability.reach = ad.reachStatus;
  if (ad.impressions === null) availability.impressions = ad.impressionsStatus;
  ad.availability = availability;
}
export function normalize(raw: RecordData, query: Query, adapter: string, tracker: SchemaTracker, includeRaw = false, now = new Date()): { ad: Ad; drift: boolean } {
  const { fields: f, extra, drift } = tracker.inspect(raw);
  const tweetId = str(f.tweetId), lineItemId = str(f.lineItemId), country = str(f.country)?.toUpperCase();
  if (!tweetId || !/^\d+$/.test(tweetId) || !lineItemId || !country || !/^[A-Z]{2}$/.test(country)) throw new SourceError('MISSING_OR_INVALID_AD_IDENTITY', 'Source row lacks a safe tweetId, lineItemId or served country. Row quarantined; no identity was invented.');
  if (!query.countries.includes(country)) throw new SourceError('COUNTRY_OUTSIDE_QUERY', 'Source row country differs from the requested scope.');
  const { targeting, disclosed } = parseTargeting(f);
  const geo = arrayValue(f.targetedLocations)?.map(str).filter((s): s is string => !!s) ?? targeting.filter(t => /^(?:GEO|LOCATION|COUNTRY|CITY|REGION|POSTAL|GEO_LOCATION)(?:_|$)/i.test(t.type ?? '') && t.included !== false).map(t => t.name).filter((s): s is string => !!s);
  const creative = emptyCreative();
  creative.text = str(f.creativeText); creative.textSource = creative.text ? 'repository' : 'not_disclosed';
  creative.authorName = str(f.authorName); creative.authorNameSource = creative.authorName ? 'repository' : 'not_disclosed';
  const link = str(f.landingUrl);
  if (link && /^https?:\/\//i.test(link)) { creative.landingUrl = link; creative.landingUrlStatus = 'repository'; creative.landingDomain = new URL(link).hostname; creative.landingDomainSource = 'derived_landing_url'; }
  const assets = arrayValue(f.assets);
  if (assets) {
    creative.assets = assets.map(v => { const a = record(v); return { type: str(a.type), url: str(a.url), width: number(a.width), height: number(a.height), durationMs: number(a.durationMs) }; });
    creative.assetCount = assets.length; creative.assetCountSource = 'repository';
  }
  if (str(f.mediaType) && ['text', 'image', 'video', 'gif', 'carousel'].includes(String(f.mediaType).toLowerCase())) { creative.mediaType = String(f.mediaType).toLowerCase(); creative.mediaTypeSource = 'repository'; }
  const approvalStatus = str(f.approvalStatus), halted = bool(f.isHalted);
  const start = iso(f.deliveryStart), end = iso(f.deliveryEnd);
  const created = snowflake(tweetId); const stamp = now.toISOString();
  const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(country);
  const impressions = number(f.impressions), reach = number(f.reach);
  const ad: Ad = {
    adKey: hash(`${query.advertiser.userId}|${tweetId}|${lineItemId}|${country}`), adId: str(f.adId) ?? tweetId,
    adIdSource: str(f.adId) ? 'repository' : 'tweet_id_fallback', tweetId, lineItemId, accountId: str(f.accountId),
    adName: '', adNameSource: '', adUrl: `https://x.com/i/web/status/${tweetId}`, advertiser: query.advertiser,
    adCreatedAt: created, adCreatedAtSource: created ? 'derived_tweet_snowflake' : 'invalid_or_pre_snowflake_id',
    deliveryStart: start, deliveryStartSource: start ? 'repository' : 'not_disclosed',
    deliveryEnd: end, deliveryEndSource: end ? 'repository' : 'not_disclosed',
    daysActive: start && end && end >= start ? Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1 : null,
    daysActiveSource: start && end && end >= start ? 'derived_disclosed_delivery_dates' : 'delivery_dates_not_disclosed',
    firstSeenAt: stamp, lastSeenAt: stamp, scrapedAt: stamp,
    country, countryName: name && name !== country ? name : null, countryNameSource: name && name !== country ? 'iso3166_intl' : 'unrecognized_country',
    targetedLocations: [...new Set(geo)], targetedLocationsStatus: f.targetedLocations !== undefined || disclosed ? 'repository' : 'not_disclosed',
    targeting, targetingStatus: disclosed ? 'repository' : 'not_disclosed', targetingSummary: targeting.map(t => `${t.included === false ? 'EXCLUDE ' : ''}${t.type ?? 'unknown'}: ${t.name ?? 'unknown'}`).join('; '),
    impressions, impressionsStatus: impressions === null ? 'not_disclosed_or_invalid' : 'repository',
    reach, reachStatus: reach === null ? 'not_disclosed_or_invalid' : 'repository',
    impressionsLower: number(f.impressionsLower), impressionsUpper: number(f.impressionsUpper), reachLower: number(f.reachLower), reachUpper: number(f.reachUpper),
    funding: { instrumentType: str(f.fundingType), currency: str(f.currency), entity: str(f.fundingEntity) }, fundingStatus: 'repository_fields_or_not_disclosed',
    approvalStatus, approvalStatusSource: approvalStatus ? 'repository' : 'not_disclosed',
    isHalted: halted ?? (approvalStatus && /^halted$/i.test(approvalStatus) ? true : null), isHaltedSource: halted !== null ? 'repository' : approvalStatus && /^halted$/i.test(approvalStatus) ? 'derived_explicit_halted_status' : 'not_disclosed',
    creative, changeStatus: 'UNCHANGED', changedFields: [], previous: {}, matchedKeywords: [], matchedFields: [], filterUncertain: false,
    source: { adapter, queryKey: query.key, queryKeys: [query.key], dateSemantics: adapter === 'ui' ? 'inclusive_input_exclusive_ui_end' : 'export_end_semantics_unverified' },
    schemaVersion: '1.0.0', extra, ...(includeRaw ? { raw } : {}), availability: {},
  };
  deriveName(ad); refreshAvailability(ad); return { ad, drift };
}
/** Targets can appear on separate CSV lines for the same ad; do not multiply its metrics. */
export function mergeSameQuery(a: Ad, b: Ad): Ad {
  const targeting = [...new Map([...a.targeting, ...b.targeting].map(t => [stable(t), t])).values()];
  const merged = { ...b, targeting, targetedLocations: [...new Set([...a.targetedLocations, ...b.targetedLocations])], extra: { ...a.extra, ...b.extra },
    impressions: a.impressions === null ? b.impressions : b.impressions === null ? a.impressions : Math.max(a.impressions, b.impressions),
    reach: a.reach === null ? b.reach : b.reach === null ? a.reach : Math.max(a.reach, b.reach),
  };
  merged.targetingSummary = targeting.map(t => `${t.included === false ? 'EXCLUDE ' : ''}${t.type ?? 'unknown'}: ${t.name ?? 'unknown'}`).join('; ');
  return merged;
}
