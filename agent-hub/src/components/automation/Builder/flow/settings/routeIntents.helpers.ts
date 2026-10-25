import { appendKey } from '@shared/expr/path.mjs';
import { fileTypeOf } from '@shared/expr/rules.mjs';
import { filesListKey, itemIsFile, listTarget, mentionsFiles } from './routeIntentsFiles';
import type { DateClause, IntentContext, IntentField, IntentResult, IntentResultArgs, IntentRule, NumberClause } from './routeIntents.types';
import { MAX_RULES, FILE_NAME_KEYS, TEXT_KEYS, NUMBER_KEYS, DATE_KEYS, QUOTED_RE, CONTAINS_LEAD, DATE_CLAUSES, DATE_WORDS, NUMBER_CLAUSES } from './routeIntents.constants';

// ── Small helpers ───────────────────────────────────────────────────────
function lastSegment(path?: string) {
    const cleaned = String(path || '').replace(/\[(?:\*|\d+)\]/g, '');
    return cleaned.split('.').filter(Boolean).pop() || '';
}

function fieldKey(field?: IntentField | null) {
    return lastSegment(field?.path).toLowerCase();
}

/** Port names must be unique — two cases with one name is an unwireable node. */
function withUniqueNames(rules: IntentRule[]) {
    const seen = new Set<string>();
    return rules.map((r: IntentRule) => {
        let name = r.name;
        let i = 1;
        while (seen.has(name)) name = `${r.name}_${++i}`;
        seen.add(name);
        return { ...r, name };
    });
}

export function result({
    kind = null, understood = '', field = null, rules = [], problem = null, problemCode = null,
    truncated = false, filesInside = null,
}: IntentResultArgs): IntentResult {
    return {
        kind, understood, field, rules: withUniqueNames(rules).slice(0, MAX_RULES),
        problem, problemCode, truncated, filesInside,
    };
}

export function quote(value: unknown) {
    return JSON.stringify(String(value));
}

/**
 * The number in "over 1000". Only the COMMA is treated as a thousands
 * separator: in the expression grammar a dot is a decimal point, so reading
 * `1.000` as one thousand here would silently disagree with what the very
 * same characters mean in the generated expression.
 */
function parseNumber(raw: unknown) {
    const cleaned = String(raw || '').replace(/,/g, '').trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    return Number(cleaned);
}

/**
 * The day after an ISO date, as an ISO date.
 *
 * Date fields hold whole days ("2026-01-31") in some steps and full
 * timestamps ("2026-01-31T14:02:00Z") in others, and the expression engine
 * compares both as plain strings. `<= "2026-01-31"` therefore drops every row
 * timestamped ON the 31st — the classic "the last day of my range is missing"
 * report. An exclusive `< "2026-02-01"` bound is right for both shapes, so
 * ranges are built that way and the rule NAME keeps the date the author
 * actually typed.
 */
export function nextDay(iso: string) {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function bestField(fields: IntentField[] | null | undefined, score: (f: IntentField) => number, minimum = 2) {
    let best: IntentField | null = null;
    let bestScore = 0;
    for (const f of (fields || [])) {
        if (!f?.path) continue;
        const s = score(f);
        if (s > bestScore) { best = f; bestScore = s; }
    }
    return bestScore >= minimum ? best : null;
}

export function pickFileField(fields?: IntentField[]) {
    return bestField(fields, (f: IntentField) => {
        if (Array.isArray(f.sample)) return 0;
        let s = 0;
        // A sample that names a known file type is the strongest signal there
        // is — stronger than any name. fileType reads "other" for anything it
        // does not know, so an e-mail address ending in ".nl" scores nothing.
        if (typeof f.sample === 'string' && fileTypeOf(f.sample) !== 'other') s += 3;
        const key = fieldKey(f);
        if (FILE_NAME_KEYS.test(key)) s += 2;
        else if (key === 'title') s += 1;
        return s;
    });
}

export function pickTextField(fields?: IntentField[]) {
    return bestField(fields, (f: IntentField) => {
        let s = 0;
        if (typeof f.sample === 'string') s += 1;
        if (TEXT_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

export function pickNumberField(fields?: IntentField[]) {
    return bestField(fields, (f: IntentField) => {
        let s = 0;
        if (typeof f.sample === 'number') s += 3;
        if (NUMBER_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

export function pickDateField(fields?: IntentField[]) {
    return bestField(fields, (f: IntentField) => {
        let s = 0;
        if (typeof f.sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(f.sample.trim())) s += 3;
        if (DATE_KEYS.test(fieldKey(f))) s += 2;
        return s;
    });
}

/**
 * A field the author NAMED in the description ("subject contains urgent").
 * What the author says wins over every heuristic below — they can see the
 * field list, the heuristics only see samples. Longest match wins so
 * "from email" is not shadowed by "from".
 */
export function namedField(lower: string, fields?: IntentField[] | null) {
    let best: IntentField | null = null;
    let bestLen = 0;
    for (const f of (fields || [])) {
        if (!f?.path) continue;
        const candidates = [f.label, fieldKey(f).replace(/_/g, ' '), fieldKey(f)]
            .filter(Boolean)
            .map((s: unknown) => String(s).toLowerCase());
        for (const c of candidates) {
            if (c.length < 3 || c.length <= bestLen) continue;
            const re = new RegExp(`(?:^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`);
            if (re.test(lower)) { best = f; bestLen = c.length; } // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an escaped literal between single-character classes, no quantifier: linear
        }
    }
    return best;
}

export function findPhrases(src: string) {
    const quoted: string[] = [];
    let m: RegExpExecArray | null;
    QUOTED_RE.lastIndex = 0;
    while ((m = QUOTED_RE.exec(src))) {
        const phrase = (m[1] || m[2] || m[3] || '').trim();
        if (phrase) quoted.push(phrase);
    }
    if (quoted.length) return quoted;
    const lead = CONTAINS_LEAD.exec(src);
    if (!lead) return [];
    return lead[1]
        .split(/\s*,\s*|\s+\band\b\s+|\s+\bor\b\s+|\s*\/\s*/i)
        .map((s: string) => s.trim().replace(/[.!?]+$/, '').replace(/\bin (?:it|them|the (?:subject|body|text|title))\b/i, '').trim())
        .filter((s: string) => s && s.length > 1);
}

export function findDateClauses(lower: string) {
    const out: DateClause[] = [];
    for (const { re, kind } of DATE_CLAUSES) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lower))) out.push({ kind, at: m.index, end: m.index + m[0].length, a: m[1], b: m[2] || null });
    }
    // The patterns overlap on purpose — "between A and B" contains something
    // the `on` pattern would match again, and one phrase must not become two
    // outputs. Earliest (and therefore longest-leading) clause wins its span;
    // anything starting inside an accepted span is the same phrase read twice.
    const kept: DateClause[] = [];
    for (const c of out.sort((a: DateClause, b: DateClause) => (a.at - b.at) || (b.end - a.end))) {
        if (kept.some((k: DateClause) => c.at < k.end && c.end > k.at)) continue;
        kept.push(c);
    }
    return kept;
}

export function findNumberClauses(lower: string) {
    const out: NumberClause[] = [];
    for (const { re, kind } of NUMBER_CLAUSES) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lower))) {
            const a = parseNumber(m[1]);
            const b = m[2] == null ? null : parseNumber(m[2]);
            if (a == null || (kind === 'between' && b == null)) continue;
            out.push({ kind, at: m.index, end: m.index + m[0].length, a, b });
        }
    }
    // Same overlap rule as the dates, and here it is load-bearing rather than
    // tidy: "no more than 100" contains "more than 100", so without it the one
    // phrase becomes an at-most output AND an over output that says the
    // opposite. Earliest start, longest span wins.
    const kept: NumberClause[] = [];
    for (const c of out.sort((x: NumberClause, y: NumberClause) => (x.at - y.at) || (y.end - x.end))) {
        if (kept.some((k: NumberClause) => c.at < k.end && c.end > k.at)) continue;
        kept.push(c);
    }
    return kept;
}

/** The sentence for a description no intent answered. */
export function unrecognised({ lower, element, allFields }: IntentContext) {
    if (mentionsFiles(lower) && (itemIsFile(element, allFields) || filesListKey(element, allFields))) {
        // About files, but no type named: say which words work, and (S4)
        // still offer to work through the files inside each item.
        const listKey = itemIsFile(element, allFields) ? null : filesListKey(element, allFields);
        return result({
            problem: 'Name the file types to split by, for example “pdf, word and powerpoint”.',
            problemCode: 'name_types',
            filesInside: listKey ? listTarget(appendKey('item', listKey), allFields).filesInside : null,
        });
    }
    if (DATE_WORDS.test(lower)) {
        // A relative date needs the run's clock, and a dd-mm-yyyy date is
        // ambiguous with mm-dd-yyyy. Both are refused out loud instead of
        // being resolved to a date the author never typed.
        return result({ problem: 'Dates have to be written in full, as 2026-01-31. A date relative to today (“last week”) is not something this box can work out on its own.' });
    }
    return result({
        problem: 'Nothing recognised there yet. Try a file type (pdf, word, excel, powerpoint), words in quotes to look for, a date range written as 2026-01-31, or a number comparison such as “amount over 1000”.',
    });
}
