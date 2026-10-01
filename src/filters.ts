import { RE2 } from 're2-wasm';
import type { Ad, Input } from './types.js';

export function fold(text: string, caseSensitive = false): string {
  let s = text.normalize('NFKD').replace(/\p{M}/gu, '').replace(/æ/g, 'ae').replace(/Æ/g, 'AE').replace(/œ/g, 'oe').replace(/Œ/g, 'OE');
  if (!caseSensitive) s = s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  return s;
}
export interface Expression { original: string; test(value: string): boolean }
export function expression(value: string, caseSensitive: boolean): Expression {
  if (!value.trim() || value.length > 512) throw new Error('Keyword expressions must have 1–512 characters.');
  const match = /^\/(.*)\/([imsu]*)$/.exec(value);
  if (value.startsWith('/') && !match) throw new Error('Invalid regex keyword: use /pattern/ or /pattern/i.');
  if (match) {
    let re: RE2;
    try { re = new RE2(fold(match[1], true), [...new Set(`${match[2]}u${caseSensitive ? '' : 'i'}`)].join('')); }
    catch { throw new Error('Invalid or unsupported regex. Use RE2 syntax; backreferences and lookaround are not supported.'); }
    return { original: value, test: s => re.test(fold(s, caseSensitive)) };
  }
  if (value.startsWith('"') !== value.endsWith('"')) throw new Error('Quoted keyword phrases must have matching double quotes.');
  const needle = fold(value.replace(/^"|"$/g, ''), caseSensitive);
  return { original: value, test: s => fold(s, caseSensitive).includes(needle) };
}
export class FilterEngine {
  private include: Expression[];
  private exclude: Expression[];
  private locations: Expression[];
  constructor(private input: Input) {
    this.include = input.keywords.map(s => expression(s, input.caseSensitive));
    this.exclude = input.excludeKeywords.map(s => expression(s, input.caseSensitive));
    this.locations = input.targetedLocations.map(s => expression(s, false));
  }
  match(ad: Ad): boolean {
    ad.matchedKeywords = []; ad.matchedFields = []; ad.filterUncertain = false;
    const known: { field: string; value: string | null }[] = this.input.keywordFields.map(field => ({ field, value: ({
      creativeText: ad.creative.text,
      advertiser: [ad.advertiser.handle, ad.advertiser.name, ad.advertiser.userId].filter(Boolean).join(' ') || null,
      targeting: ad.targetingStatus === 'not_disclosed' ? null : ad.targetingSummary,
      landingUrl: ad.creative.landingUrl,
    })[field] }));
    const unknown = known.some(f => f.value === null);
    for (const e of this.exclude) if (known.some(f => f.value !== null && e.test(f.value))) return false;
    if ((this.include.length || this.exclude.length) && unknown) {
      if (this.input.strictFilters) return false;
      ad.filterUncertain = true;
    }
    for (const e of this.include) {
      const fields = known.filter(f => f.value !== null && e.test(f.value));
      if (fields.length) { ad.matchedKeywords.push(e.original); ad.matchedFields.push(...fields.map(f => f.field)); }
    }
    ad.matchedFields = [...new Set(ad.matchedFields)];
    if (this.include.length) {
      const matched = this.input.keywordMatch === 'all' ? ad.matchedKeywords.length === this.include.length : ad.matchedKeywords.length > 0;
      if (!matched && !unknown) return false;
      if (!matched) ad.filterUncertain = true;
    }
    const decide = (value: unknown | null, predicate: (value: unknown) => boolean): boolean => {
      if (value === null) { ad.filterUncertain = true; return !this.input.strictFilters; }
      return predicate(value);
    };
    if (this.locations.length && !decide(ad.targetedLocationsStatus === 'not_disclosed' ? null : ad.targetedLocations, v => (v as string[]).some(s => this.locations.some(e => e.test(s))))) return false;
    for (const [field, minimum] of [['impressions', this.input.minImpressions], ['reach', this.input.minReach]] as const) if (minimum !== null && !decide(ad[field], v => Number(v) >= minimum)) return false;
    for (const [values, current] of [[this.input.approvalStatuses, ad.approvalStatus], [this.input.fundingTypes, ad.funding.instrumentType]] as const) if (values.length && !decide(current, v => values.map(s => fold(s)).includes(fold(String(v))))) return false;
    if (this.input.mediaTypes.length && !decide(ad.creative.mediaType === 'unknown' && !this.input.mediaTypes.includes('unknown') ? null : ad.creative.mediaType, v => this.input.mediaTypes.includes(String(v)))) return false;
    return true;
  }
}
