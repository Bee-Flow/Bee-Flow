/**
 * "Suggest outputs", part two: reading phrases, dates and numbers out of a
 * description and turning them into rule expressions. Dates build EXCLUSIVE
 * next-day bounds, because a field may hold whole days or full timestamps and
 * `<= "2026-01-31"` silently drops everything timestamped on the 31st. From
 * agent-hub `Builder/flow/settings/routeIntents.js`; pinned by
 * settings.lockstep.test.ts.
 */

export interface Rule {
    name: string;
    expr: string;
}

/** A port name: lowercase, word characters only — it labels an edge. */
export function slugName(text: unknown): string {
    const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'output';
}

export function quote(value: unknown): string {
    return JSON.stringify(String(value));
}

// ── Phrases ─────────────────────────────────────────────────────────────
const QUOTED_RE = /"([^"]+)"|'([^']+)'|“([^”]+)”/g;
// A bare "with" is NOT a lead-in: "do the usual thing with these" is a shrug.
const CONTAINS_LEAD = /\b(?:contains?|containing|mentions?|mentioning|includes?|including|with the words?)\s+(.+)$/i;

export function findPhrases(src: string): string[] {
    const quoted: string[] = [];
    QUOTED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QUOTED_RE.exec(src))) {
        const phrase = (m[1] || m[2] || m[3] || '').trim();
        if (phrase) quoted.push(phrase);
    }
    if (quoted.length) return quoted;
    const lead = CONTAINS_LEAD.exec(src);
    if (!lead) return [];
    return (lead[1] as string)
        .split(/\s*,\s*|\s+\band\b\s+|\s+\bor\b\s+|\s*\/\s*/i)
        .map((s) => s.trim().replace(/[.!?]+$/, '').replace(/\bin (?:it|them|the (?:subject|body|text|title))\b/i, '').trim())
        .filter((s) => s && s.length > 1);
}

// ── Overlapping clauses: earliest start, longest span wins ─────────────
interface Span {
    at: number;
    end: number;
}

function keepEarliest<T extends Span>(found: T[]): T[] {
    const kept: T[] = [];
    for (const c of found.sort((a, b) => a.at - b.at || b.end - a.end)) {
        if (kept.some((k) => c.at < k.end && c.end > k.at)) continue;
        kept.push(c);
    }
    return kept;
}

function scan<T>(src: string, patterns: { re: RegExp; kind: string }[], make: (m: RegExpExecArray, kind: string) => T | null): (T & Span)[] {
    const out: (T & Span)[] = [];
    for (const { re, kind } of patterns) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
            const made = make(m, kind);
            if (made) out.push({ ...made, at: m.index, end: m.index + m[0].length });
        }
    }
    return keepEarliest(out);
}

// ── Dates ──────────────────────────────────────────────────────────────
const ISO_DATE = '\\d{4}-\\d{2}-\\d{2}';

const DATE_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+(${ISO_DATE})\\s+(?:and|to|until)\\s+(${ISO_DATE})`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:before|earlier than|prior to|up to)\\s+(${ISO_DATE})`, 'g'), kind: 'before' },
    { re: new RegExp(`\\bafter\\s+(${ISO_DATE})`, 'g'), kind: 'after' },
    { re: new RegExp(`\\b(?:since|from|on or after)\\s+(${ISO_DATE})`, 'g'), kind: 'since' },
    { re: new RegExp(`\\bon\\s+(${ISO_DATE})`, 'g'), kind: 'on' },
];

interface DateClause {
    kind: string;
    a: string;
    b: string | null;
}

export function findDateClauses(lower: string): DateClause[] {
    return scan<DateClause>(lower, DATE_CLAUSES, (m, kind) => ({ kind, a: m[1] as string, b: m[2] || null }));
}

/** The day after an ISO date, as an ISO date; null when it is not a date. */
export function nextDay(iso: string | null): string | null {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function dateRule(c: DateClause, path: string): Rule | null {
    const range = (from: string, until: string | null) => (until ? `${path} >= ${quote(from)} && ${path} < ${quote(until)}` : null);
    if (c.kind === 'between') {
        const expr = range(c.a, nextDay(c.b));
        return expr ? { name: slugName(`between ${c.a} and ${c.b}`), expr } : null;
    }
    if (c.kind === 'before') return { name: slugName(`before ${c.a}`), expr: `${path} < ${quote(c.a)}` };
    if (c.kind === 'after') {
        const from = nextDay(c.a);
        return from ? { name: slugName(`after ${c.a}`), expr: `${path} >= ${quote(from)}` } : null;
    }
    if (c.kind === 'since') return { name: slugName(`since ${c.a}`), expr: `${path} >= ${quote(c.a)}` };
    const expr = range(c.a, nextDay(c.a));
    return expr ? { name: slugName(`on ${c.a}`), expr } : null;
}

export function dateRules(clauses: DateClause[], path: string): Rule[] {
    return clauses.map((c) => dateRule(c, path)).filter((r): r is Rule => !!r);
}

// ── Numbers ────────────────────────────────────────────────────────────
const NUM = '(-?[\\d][\\d,]*(?:\\.\\d+)?)';
const NUMBER_CLAUSES = [
    { re: new RegExp(`\\bbetween\\s+${NUM}\\s+(?:and|to)\\s+${NUM}`, 'g'), kind: 'between' },
    { re: new RegExp(`\\b(?:over|more than|greater than|above|higher than|bigger than)\\s+${NUM}`, 'g'), kind: 'gt' },
    { re: new RegExp(`\\b(?:under|less than|below|lower than|smaller than)\\s+${NUM}`, 'g'), kind: 'lt' },
    { re: new RegExp(`\\b(?:at least|minimum of|minimum|no less than)\\s+${NUM}`, 'g'), kind: 'gte' },
    { re: new RegExp(`\\b(?:at most|no more than|maximum of|maximum|up to)\\s+${NUM}`, 'g'), kind: 'lte' },
];

/** Only the COMMA is a thousands separator: in the grammar a dot is a decimal point. */
function parseNumber(raw: unknown): number | null {
    const cleaned = String(raw || '').replace(/,/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
}

interface NumberClause {
    kind: string;
    a: number;
    b: number | null;
}

export function findNumberClauses(lower: string): NumberClause[] {
    return scan<NumberClause>(lower, NUMBER_CLAUSES, (m, kind) => {
        const a = parseNumber(m[1]);
        const b = m[2] == null ? null : parseNumber(m[2]);
        if (a == null || (kind === 'between' && b == null)) return null;
        return { kind, a, b };
    });
}

const NUMBER_SYMBOL: Record<string, string> = { gt: '>', lt: '<', gte: '>=', lte: '<=' };
const NUMBER_WORD: Record<string, string> = { gt: 'over', lt: 'under', gte: 'at least', lte: 'at most' };

export function numberRules(clauses: NumberClause[], path: string): Rule[] {
    return clauses.map((c) => (c.kind === 'between'
        ? { name: slugName(`between ${c.a} and ${c.b}`), expr: `${path} >= ${c.a} && ${path} <= ${c.b}` }
        : { name: slugName(`${NUMBER_WORD[c.kind]} ${c.a}`), expr: `${path} ${NUMBER_SYMBOL[c.kind]} ${c.a}` }));
}
