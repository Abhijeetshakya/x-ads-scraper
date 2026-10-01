import { createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ad, Input, Logger } from './types.js';
import { Http, SourceError } from './http.js';

export interface Digest {
  runId: string; counts: Record<string, number>; total: number;
  items: { adKey: string; advertiser: string; country: string; text: string | null; impressions: number | null; url: string; status: string }[];
}
export function digest(rows: () => Iterable<Ad>, input: Input, runId: string): Digest {
  const result: Digest = { runId, counts: { NEW: 0, CHANGED: 0, REMOVED: 0 }, total: 0, items: [] };
  for (const ad of rows()) if (input.notifyOn.includes(ad.changeStatus)) {
    result.total++; result.counts[ad.changeStatus] = (result.counts[ad.changeStatus] ?? 0) + 1;
    if (result.items.length < input.notifyMaxItems) result.items.push({ adKey: ad.adKey, advertiser: ad.advertiser.handle ?? ad.advertiser.userId, country: ad.country, text: ad.creative.text?.slice(0, 240) ?? null, impressions: ad.impressions, url: ad.adUrl, status: ad.changeStatus });
  }
  return result;
}
const title = (d: Digest) => `X ads: ${d.counts.NEW} new · ${d.counts.CHANGED} changed · ${d.counts.REMOVED} removed`;
export function slackPayload(d: Digest) {
  return { text: title(d), blocks: [
    { type: 'header', text: { type: 'plain_text', text: title(d) } },
    ...d.items.slice(0, 45).map(item => ({ type: 'section', text: { type: 'plain_text', text: `${item.status} · ${item.advertiser} · ${item.country}\n${item.text ?? 'Creative unavailable'}\nImpressions: ${item.impressions ?? 'unknown'}` }, accessory: { type: 'button', text: { type: 'plain_text', text: 'View post' }, url: item.url } })),
    { type: 'context', elements: [{ type: 'plain_text', text: `Run ${d.runId}. EU repository disclosures; partial queries cannot establish removal.` }] },
  ] };
}
export function discordPayload(d: Digest) {
  return { content: title(d), allowed_mentions: { parse: [] }, embeds: d.items.slice(0, 10).map(item => ({ title: `${item.status}: ${item.advertiser} (${item.country})`.slice(0, 256), description: item.text ?? 'Creative unavailable', url: item.url, color: item.status === 'REMOVED' ? 0xca554a : 0x4f83ff, fields: [{ name: 'Impressions', value: String(item.impressions ?? 'unknown'), inline: true }] })) };
}
export async function genericPayloadFile(path: string, d: Digest, rows: () => Iterable<Ad>, input: Input): Promise<string> {
  const hmac = createHmac('sha256', input.webhookSecret!); const out = createWriteStream(path);
  const finished = once(out, 'finish');
  const write = async (s: string) => { hmac.update(s); if (!out.write(s)) await once(out, 'drain'); };
  await write(`{"runId":${JSON.stringify(d.runId)},"counts":${JSON.stringify(d.counts)},"total":${d.total},"highlights":${JSON.stringify(d.items)},"ads":[`);
  let first = true;
  for (const ad of rows()) if (input.notifyOn.includes(ad.changeStatus)) { await write(`${first ? '' : ','}${JSON.stringify(ad)}`); first = false; }
  await write(']}'); out.end(); await finished; return `sha256=${hmac.digest('hex')}`;
}
export async function notify(directory: string, rows: () => Iterable<Ad>, input: Input, runId: string, http: Http, logger: Logger) {
  const d = digest(rows, input, runId);
  const statuses: { channel: string; status: string; reason?: string; items: number }[] = [];
  if (!d.total && !input.notifyOnEmpty) return [{ channel: 'all', status: 'skipped_empty', items: 0 }];
  for (const [channel, url] of [['webhook', input.webhookUrl], ['slack', input.slackWebhookUrl], ['discord', input.discordWebhookUrl]] as const) {
    if (!url) continue;
    try {
      let body: string | (() => ReturnType<typeof createReadStream>);
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-x-ads-run-id': runId, 'idempotency-key': `${runId}-${channel}` };
      if (channel === 'webhook') {
        const path = join(directory, 'webhook-payload.json'); headers['x-x-ads-signature'] = await genericPayloadFile(path, d, rows, input);
        headers['content-length'] = String((await stat(path)).size); body = () => createReadStream(path);
      } else body = JSON.stringify(channel === 'slack' ? slackPayload(d) : discordPayload(d));
      const response = await http.request(url, { method: 'POST', headers, body, retries: input.maxRetries, timeoutMs: 15000, safePublic: true });
      await response.body?.cancel();
      if (response.status >= 300) throw new SourceError('WEBHOOK_REDIRECT', 'Webhook redirects are not followed to avoid leaking the signed payload.');
      statuses.push({ channel, status: 'sent', items: d.total });
    } catch (e) {
      const reason = e instanceof SourceError ? e.code : 'NOTIFICATION_ERROR';
      statuses.push({ channel, status: 'failed', reason, items: d.total }); logger.warning('Notification failed softly.', { channel, reason });
    }
  }
  return statuses;
}
