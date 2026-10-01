import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import type { Ad } from './types.js';
import { get, html, spreadsheetText } from './util.js';

export interface Breakdown { ads: number; impressions: number; reach: number; unknownImpressions: number; unknownReach: number }
export interface Analysis {
  totals: Breakdown;
  byAdvertiser: Record<string, Breakdown & { handle: string | null }>;
  byCountry: Record<string, Breakdown>;
  changes: Record<string, number>;
  longRunningCampaigns: number;
  totalReachInterpretation: string;
}
const empty = (): Breakdown => ({ ads: 0, impressions: 0, reach: 0, unknownImpressions: 0, unknownReach: 0 });
function add(b: Breakdown, ad: Ad) {
  b.ads++; if (ad.impressions === null) b.unknownImpressions++; else b.impressions += ad.impressions;
  if (ad.reach === null) b.unknownReach++; else b.reach += ad.reach;
}
export function analyze(rows: () => Iterable<Ad>): Analysis {
  const result: Analysis = { totals: empty(), byAdvertiser: {}, byCountry: {}, changes: { NEW: 0, CHANGED: 0, REMOVED: 0, UNCHANGED: 0 }, longRunningCampaigns: 0,
    totalReachInterpretation: 'Sum of disclosed row reach, not deduplicated audience across campaigns/countries. Unknown/multi-chunk reach is excluded and counted separately.' };
  for (const ad of rows()) {
    add(result.totals, ad);
    const advertiser = result.byAdvertiser[ad.advertiser.userId] ??= { ...empty(), handle: ad.advertiser.handle };
    add(advertiser, ad); add(result.byCountry[ad.country] ??= empty(), ad);
    result.changes[ad.changeStatus] = (result.changes[ad.changeStatus] ?? 0) + 1;
    if (ad.daysActive !== null && ad.daysActive >= 30) result.longRunningCampaigns++;
  }
  return result;
}
export const columns = [
  'adKey', 'adId', 'adIdSource', 'tweetId', 'lineItemId', 'accountId', 'adName', 'adNameSource',
  'advertiser.handle', 'advertiser.userId', 'advertiser.name', 'advertiser.profileUrl', 'country', 'countryName',
  'adCreatedAt', 'adCreatedAtSource', 'deliveryStart', 'deliveryEnd', 'daysActive', 'daysActiveSource',
  'firstSeenAt', 'lastSeenAt', 'scrapedAt', 'targetedLocations', 'targetingSummary', 'targetingStatus',
  'impressions', 'impressionsStatus', 'reach', 'reachStatus', 'impressionsLower', 'impressionsUpper', 'reachLower', 'reachUpper',
  'funding.instrumentType', 'funding.currency', 'funding.entity', 'approvalStatus', 'isHalted',
  'creative.text', 'creative.textSource', 'creative.authorName', 'creative.mediaType', 'creative.mediaTypeSource',
  'creative.assetCount', 'creative.assetCountSource', 'creative.assets', 'creative.hashtags', 'creative.mentions',
  'creative.landingUrl', 'creative.landingUrlStatus', 'creative.landingDomain', 'creative.utm', 'creative.enrichmentStatus',
  'changeStatus', 'changedFields', 'previous', 'matchedKeywords', 'matchedFields', 'filterUncertain', 'adUrl',
  'source.adapter', 'source.queryKey', 'source.queryKeys', 'source.dateSemantics', 'schemaVersion', 'availability', 'extra',
];
export function flat(ad: Ad, includeRaw = false): Record<string, unknown> {
  return Object.fromEntries([...columns, ...(includeRaw ? ['raw'] : [])].map(k => {
    const value = get(ad, k);
    return [k, value && typeof value === 'object' ? JSON.stringify(value) : value ?? null];
  }));
}
async function write(stream: ReturnType<typeof createWriteStream>, text: string) { if (!stream.write(text)) await once(stream, 'drain'); }
async function finish(stream: ReturnType<typeof createWriteStream>) { stream.end(); await once(stream, 'finish'); }
export async function csvFile(path: string, rows: () => Iterable<Ad>, includeRaw = false) {
  const output = createWriteStream(path); const fields = [...columns, ...(includeRaw ? ['raw'] : [])];
  const csv = stringify({ header: true, columns: fields, bom: true }); csv.pipe(output);
  const finished = once(output, 'finish');
  for (const row of rows()) {
    const data = Object.fromEntries(Object.entries(flat(row, includeRaw)).map(([k, v]) => [k, spreadsheetText(v)]));
    if (!csv.write(data)) await once(csv, 'drain');
  }
  csv.end(); await finished;
}
export async function jsonFile(path: string, rows: () => Iterable<Ad>) {
  const output = createWriteStream(path); await write(output, '[\n'); let first = true;
  for (const ad of rows()) { await write(output, `${first ? '' : ',\n'}${JSON.stringify(ad)}`); first = false; }
  await write(output, '\n]\n'); await finish(output);
}
const dateFields = new Set(['adCreatedAt', 'deliveryStart', 'deliveryEnd', 'firstSeenAt', 'lastSeenAt', 'scrapedAt']);
const linkFields = new Set(['adUrl', 'advertiser.profileUrl', 'creative.landingUrl']);
export async function xlsxFile(path: string, rows: () => Iterable<Ad>, summary: Record<string, unknown>, includeRaw = false) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true, useSharedStrings: false });
  const fields = [...columns, ...(includeRaw ? ['raw'] : [])];
  const ads = workbook.addWorksheet('Ads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ads.columns = fields.map(k => ({ header: k, key: k, width: k === 'creative.text' ? 60 : 24 }));
  ads.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fields.length } };
  ads.getRow(1).font = { bold: true }; ads.getRow(1).commit();
  const changes = workbook.addWorksheet('Changes', { views: [{ state: 'frozen', ySplit: 1 }] });
  changes.columns = ['changeStatus', 'adName', 'advertiser', 'country', 'changedFields', 'previous', 'adUrl'].map(k => ({ header: k, key: k, width: 28 }));
  changes.autoFilter = 'A1:G1'; changes.getRow(1).font = { bold: true }; changes.getRow(1).commit();
  for (const ad of rows()) {
    const values = flat(ad, includeRaw);
    for (const [k, v] of Object.entries(values)) {
      if (dateFields.has(k) && typeof v === 'string') values[k] = new Date(v);
      else if (linkFields.has(k) && typeof v === 'string' && /^https:\/\//.test(v)) values[k] = { text: v, hyperlink: v };
      else values[k] = spreadsheetText(v);
    }
    const row = ads.addRow(values);
    for (const field of dateFields) row.getCell(field).numFmt = 'yyyy-mm-dd hh:mm:ss';
    row.commit();
    if (ad.changeStatus !== 'UNCHANGED') changes.addRow({ changeStatus: ad.changeStatus, adName: spreadsheetText(ad.adName), advertiser: spreadsheetText(ad.advertiser.handle), country: ad.country, changedFields: JSON.stringify(ad.changedFields), previous: spreadsheetText(JSON.stringify(ad.previous)), adUrl: { text: ad.adUrl, hyperlink: ad.adUrl } }).commit();
  }
  ads.commit(); changes.commit();
  const analysis = analyze(rows);
  for (const [name, groups] of [['Advertisers', analysis.byAdvertiser], ['Countries', analysis.byCountry]] as const) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const fields = ['id', 'handle', 'ads', 'impressions', 'reach', 'unknownImpressions', 'unknownReach'];
    sheet.columns = fields.map(k => ({ header: k, key: k, width: 26 })); sheet.autoFilter = 'A1:G1'; sheet.getRow(1).font = { bold: true }; sheet.getRow(1).commit();
    for (const [id, value] of Object.entries(groups)) sheet.addRow({ id, ...value }).commit(); sheet.commit();
  }
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [{ header: 'Metric', key: 'metric', width: 40 }, { header: 'Value', key: 'value', width: 100 }]; sheet.autoFilter = 'A1:B1'; sheet.getRow(1).font = { bold: true }; sheet.getRow(1).commit();
  for (const [k, v] of Object.entries({ ...analysis.totals, ...summary, totalReachInterpretation: analysis.totalReachInterpretation })) sheet.addRow({ metric: k, value: v && typeof v === 'object' ? JSON.stringify(v) : spreadsheetText(v) }).commit(); sheet.commit();
  await workbook.commit();
}
function chart(groups: Record<string, Breakdown>): string {
  const entries = Object.entries(groups).sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 30);
  const maximum = Math.max(1, ...entries.map(([, b]) => b.impressions));
  return `<svg role="img" aria-label="Observed impressions by served country" viewBox="0 0 640 ${Math.max(40, entries.length * 30)}">${entries.map(([c, b], i) => `<text x="0" y="${i * 30 + 20}" fill="currentColor">${html(c)}</text><rect x="45" y="${i * 30 + 5}" width="${b.impressions / maximum * 400}" height="20" rx="3" fill="#4f83ff"/><text x="${55 + b.impressions / maximum * 400}" y="${i * 30 + 20}" fill="currentColor">${b.impressions.toLocaleString('en-US')}</text>`).join('')}</svg>`;
}
export async function htmlFile(path: string, rows: () => Iterable<Ad>, summary: Record<string, unknown>) {
  const analysis = analyze(rows); const out = createWriteStream(path);
  await write(out, `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>X ads competitor report</title><style>
  :root{color-scheme:light dark;--bg:#f4f6fa;--panel:#fff;--fg:#162239;--border:#d4dceb}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}body.dark{--bg:#101827;--panel:#192638;--fg:#eef3fc;--border:#35475e}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:28px;margin-bottom:8px}button,input{font:inherit;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--fg)}button{cursor:pointer}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:24px 0}.card,section{background:var(--panel);padding:16px;border-radius:12px;border:1px solid var(--border)}.card strong{font-size:26px;display:block}svg{width:100%;max-width:640px}a{color:#4684df}.table-wrap{overflow:auto;margin-top:16px}table{width:100%;border-collapse:collapse;background:var(--panel)}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--border);vertical-align:top}th{cursor:pointer;white-space:nowrap}td.snippet{min-width:220px;max-width:400px;white-space:pre-wrap;word-break:break-word}header{display:flex;gap:12px;align-items:center;justify-content:space-between}.muted{opacity:.72}@media(max-width:650px){main{padding:12px}h1{font-size:22px}}@media(prefers-color-scheme:dark){body:not(.light){--bg:#101827;--panel:#192638;--fg:#eef3fc;--border:#35475e}}
  </style></head><body><main><header><h1>X ads competitor report</h1><button id="theme" type="button">Light / dark</button></header><p class="muted">Public repository disclosures for EU-served ads. Source: ${html(summary.adapterUsed)}. Null means unavailable; names are derived. Not affiliated with X.</p><div class="cards">${[['Ads', analysis.totals.ads], ['Impressions (known)', analysis.totals.impressions], ['Row reach (known)', analysis.totals.reach], ['New', analysis.changes.NEW], ['Changed', analysis.changes.CHANGED], ['Removed', analysis.changes.REMOVED]].map(([k, v]) => `<div class="card">${html(k)}<strong>${html(v)}</strong></div>`).join('')}</div><section><h2>Compare served countries</h2>${chart(analysis.byCountry)}<p class="muted">${html(analysis.totalReachInterpretation)} Queries may be partial; consult SUMMARY and ERRORS.</p></section><p><label for="search">Search results </label><input id="search" placeholder="Advertiser, targeting or creative text…"><span id="count" aria-live="polite"></span></p><div class="table-wrap"><table id="ads"><thead><tr>${['Advertiser', 'Country', 'Ad name', 'Creative', 'Impressions', 'Reach', 'Active days', 'Targeting', 'Change', 'Link'].map(s => `<th tabindex="0" scope="col">${s}</th>`).join('')}</tr></thead><tbody>`);
  for (const ad of rows()) await write(out, `<tr><td>${html(ad.advertiser.handle ?? ad.advertiser.userId)}</td><td>${html(ad.country)}</td><td>${html(ad.adName)}</td><td class="snippet">${html(ad.creative.text ?? 'Unavailable')}</td><td data-sort="${ad.impressions ?? -1}">${html(ad.impressions ?? 'Unknown')}</td><td data-sort="${ad.reach ?? -1}">${html(ad.reach ?? 'Unknown')}</td><td data-sort="${ad.daysActive ?? -1}">${html(ad.daysActive ?? 'Unknown')}</td><td class="snippet">${html(ad.targetingSummary)}</td><td>${html(ad.changeStatus)}</td><td><a target="_blank" rel="noopener noreferrer" href="${html(ad.adUrl)}">Post</a></td></tr>`);
  await write(out, `</tbody></table></div><p class="muted">Generated ${html(new Date().toISOString())}. Campaign duration is only available from disclosed delivery dates; post age is not campaign age.</p></main><script>
  const table=document.getElementById('ads'),body=table.tBodies[0],rows=Array.from(body.rows),count=document.getElementById('count');
  function search(){const q=document.getElementById('search').value.normalize('NFKD').toLowerCase();let n=0;rows.forEach(r=>{r.hidden=!r.textContent.normalize('NFKD').toLowerCase().includes(q);if(!r.hidden)n++});count.textContent=' '+n+' / '+rows.length+' rows'}document.getElementById('search').addEventListener('input',search);search();
  let direction=1;Array.from(table.tHead.rows[0].cells).forEach((th,i)=>{function sort(){direction=-direction;rows.sort((a,b)=>{const x=a.cells[i],y=b.cells[i];return direction*(x.dataset.sort!==undefined?Number(x.dataset.sort)-Number(y.dataset.sort):x.textContent.localeCompare(y.textContent))});rows.forEach(r=>body.appendChild(r))}th.addEventListener('click',sort);th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sort()}})});
  document.getElementById('theme').addEventListener('click',()=>{const dark=document.body.classList.contains('dark')||!document.body.classList.contains('light')&&matchMedia('(prefers-color-scheme:dark)').matches;document.body.classList.toggle('dark',!dark);document.body.classList.toggle('light',dark)});
  </script></body></html>`); await finish(out);
}
export async function generateExports(directory: string, formats: string[], rows: () => Iterable<Ad>, summary: Record<string, unknown>, includeRaw = false) {
  await mkdir(directory, { recursive: true });
  const files: { key: string; path: string; contentType: string }[] = [];
  for (const format of formats) {
    const key = format === 'html' ? 'report.html' : `ads.${format}`; const path = join(directory, key);
    if (format === 'csv') await csvFile(path, rows, includeRaw);
    else if (format === 'json') await jsonFile(path, rows);
    else if (format === 'xlsx') await xlsxFile(path, rows, summary, includeRaw);
    else if (format === 'html') await htmlFile(path, rows, summary);
    files.push({ key, path, contentType: ({ csv: 'text/csv; charset=utf-8', json: 'application/json', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', html: 'text/html; charset=utf-8' } as Record<string, string>)[format] });
  }
  return files;
}
