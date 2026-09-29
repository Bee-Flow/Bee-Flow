import { formatBytes as formatBytesJs, looksLikeFile as looksLikeFileJs } from '../mapping/fieldKinds';
import type { OutputColumn } from './columns';
import { isPlainObject, scalarText, type PlainObject } from './valueHelpers';

/**
 * One table cell, summarised so a nested value reads as a short phrase and
 * never as `[object Object]` or clipped JSON (artboard 4d):
 *   group → its first value + "+2"
 *   table → "5 lines"
 *   list  → its first label + "+3" (both labels when there are only two)
 */

const formatBytes = formatBytesJs as (n: unknown) => string | null;
const looksLikeFile = looksLikeFileJs as (v: unknown) => boolean;

export type Tone = 'success' | 'warning' | 'error' | 'neutral';

export type CellSummary =
    | { type: 'empty' }
    | { type: 'text'; text: string; align?: 'right' }
    | { type: 'group'; text: string; more: number }
    | { type: 'table'; count: number }
    | { type: 'list'; chips: string[]; more: number }
    | { type: 'status'; text: string; tone: Tone };

/** The first readable value of a group: a name when it has one. */
function firstValueOf(obj: PlainObject): string {
    const entries = Object.entries(obj);
    const named = entries.find(([k, v]) => /^(name|title|label|displayname|subject)$/i.test(k) && v != null && typeof v !== 'object');
    const first = named || entries.find(([, v]) => v != null && v !== '' && typeof v !== 'object');
    if (first) return scalarText(first[1]);
    const nested = entries.find(([, v]) => isPlainObject(v));
    return nested ? firstValueOf(nested[1] as PlainObject) : '';
}

function statusTone(text: string): Tone {
    const s = text.toLowerCase();
    if (/(fail|error|reject|overdue|cancel|block|denied|expired)/.test(s)) return 'error';
    if (/(wait|pending|open|draft|queue|running|review|new|todo|hold)/.test(s)) return 'warning';
    if (/(done|success|paid|approved|complete|ok|active|sent|closed|ready|finished)/.test(s)) return 'success';
    return 'neutral';
}

function formatDate(v: unknown): string {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) return scalarText(v);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatNumber(v: unknown, col: OutputColumn | null): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return scalarText(v);
    if (col && /(size|bytes)$/i.test(col.key)) return formatBytes(n) || String(n);
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function summariseArray(value: unknown[]): CellSummary {
    if (value.length === 0) return { type: 'empty' };
    if (value.some(isPlainObject)) return { type: 'table', count: value.length };
    const labels = value.map(v => scalarText(v)).filter(Boolean);
    if (labels.length <= 2) return { type: 'list', chips: labels, more: 0 };
    return { type: 'list', chips: [labels[0]], more: labels.length - 1 };
}

function summariseGroup(value: PlainObject): CellSummary {
    if (looksLikeFile(value)) return { type: 'text', text: scalarText(value.name ?? value.filename) };
    return { type: 'group', text: firstValueOf(value), more: Math.max(0, Object.keys(value).length - 1) };
}

export function summariseCell(value: unknown, col: OutputColumn | null = null): CellSummary {
    if (value === null || value === undefined || value === '') return { type: 'empty' };
    if (Array.isArray(value)) return summariseArray(value);
    if (isPlainObject(value)) return summariseGroup(value);
    if (col?.role === 'status' && typeof value === 'string') return { type: 'status', text: value, tone: statusTone(value) };
    if (typeof value === 'number') return { type: 'text', text: formatNumber(value, col), align: 'right' };
    if (col?.kind === 'date' || col?.role === 'date') return { type: 'text', text: formatDate(value) };
    if (typeof value === 'boolean') return { type: 'text', text: value ? 'yes' : 'no' };
    return { type: 'text', text: scalarText(value) };
}

/** Plain-text version of a cell, for the row search and the detail title. */
export function cellText(value: unknown, col: OutputColumn | null = null): string {
    const s = summariseCell(value, col);
    switch (s.type) {
    case 'empty': return '';
    case 'group': return s.text;
    case 'table': return String(s.count);
    case 'list': return s.chips.join(', ');
    default: return s.text;
    }
}

function collectValues(v: unknown, out: string[], depth: number): void {
    if (out.length > 400 || depth > 4 || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v) collectValues(x, out, depth + 1); return; }
    if (isPlainObject(v)) { for (const x of Object.values(v)) collectValues(x, out, depth + 1); return; }
    out.push(scalarText(v).toLowerCase());
}

/**
 * Does any VALUE in this row contain the query? Deep, but capped, and never
 * the field names: "name" would otherwise match every row there is.
 */
export function rowMatches(row: unknown, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const values: string[] = [];
    collectValues(row, values, 0);
    return values.some(v => v.includes(q));
}
