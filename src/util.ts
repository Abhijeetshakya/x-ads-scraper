import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RecordData } from './types.js';

export const hash = (value: string, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex');
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as RecordData;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });
export function str(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('UNSAFE_NUMERIC_ID_OR_VALUE');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export const record = (v: unknown): RecordData => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordData : {};
export function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
export function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (/^(true|yes|1)$/i.test(String(v))) return true;
  if (/^(false|no|0)$/i.test(String(v))) return false;
  return null;
}
export const day = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(s: string, n: number): string { return day(new Date(Date.parse(s) + n * 86400000)); }
export function iso(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(s)) return null;
  const d = new Date(s);
  return Number.isFinite(d.valueOf()) ? d.toISOString() : null;
}
export function snowflake(id: string): string | null {
  if (!/^\d+$/.test(id)) return null;
  try {
    const n = BigInt(id);
    // Twitter's pre-Snowflake IDs cannot provide a timestamp.
    if (n < 1n << 22n || n > (1n << 63n) - 1n) return null;
    return new Date(Number((n >> 22n) + 1288834974657n)).toISOString();
  } catch { return null; }
}
export function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => record(v)[k], obj);
}
export function safeReason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0].slice(0, 240) : 'UNKNOWN_ERROR';
}
export async function workers<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
export function html(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export const spreadsheetText = (value: unknown) => typeof value === 'string' && /^[=+@\-\t\r]/.test(value) ? `'${value}` : value;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
