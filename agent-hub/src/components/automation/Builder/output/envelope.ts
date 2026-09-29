import { isPlainObject } from './valueHelpers';

/**
 * Field names that describe the REQUEST rather than the result: the envelope
 * a search API wraps its rows in. A Gmail search returns
 * `{ query: 'isv', total: 201, results: [ … ] }`, and the panel used to lead
 * with "Query: isv / Total: 201 / Results": the search term the user had just
 * typed, a number the Output header already reports, and a label for the only
 * table on screen, pushing the actual data below the fold.
 *
 * A NAMED list, deliberately, not a shape rule: `{ urgency: 'Medium',
 * topSenders: [ … ] }` has exactly the same shape and every word of it is the
 * answer. Only names that can't be anything but envelope are listed here.
 */
const ENVELOPE_FIELDS = new Set([
    'query', 'q', 'searchquery',
    'total', 'totalresults', 'totalcount', 'count', 'resultcount', 'resultsizeestimate',
    'nextpagetoken', 'pagetoken', 'page', 'offset', 'limit', 'maxresults',
    'took', 'tookms', 'elapsedms', 'durationms', 'historyid',
]);

/**
 * The fields a "Call a web service" step wraps its answer in. They describe the
 * TRANSPORT, not the answer, so when such a step also produced a parsed list,
 * that list is the content and these are chrome.
 *
 * Kept as a strict signature (`status` + `ok` + `headers` must all be present,
 * and nothing outside this set may appear beside the list) because the general
 * rule is deliberately narrow: an unrecognised scalar normally means "this
 * object is content".
 */
const HTTP_TRANSPORT_FIELDS = new Set(['status', 'ok', 'truncated', 'headers', 'body']);

type Entry = [string, unknown];

function httpResponseListKey(entries: Entry[]): string | null {
    const names = new Set(entries.map(([k]) => k));
    if (!names.has('status') || !names.has('ok') || !names.has('headers')) return null;
    let key: string | null = null;
    for (const [k, v] of entries) {
        if (HTTP_TRANSPORT_FIELDS.has(k)) continue;
        if (Array.isArray(v)) {
            if (key) return null;
            if (v.length === 0 || !v.some(isPlainObject)) return null;
            key = k;
        } else if (isPlainObject(v)) {
            // A parsed OBJECT payload (`{status, ok, headers, body, data: {…}}`)
            // unwraps too, or the raw `body` string sits above the half of the
            // response anyone wanted (BFSF-402).
            if (key) return null;
            if (Object.keys(v).length === 0) return null;
            key = k;
        } else {
            return null;
        }
    }
    return key;
}

/**
 * The one list to draw on its own, or null. Requires an envelope: exactly one
 * non-empty list of records, every other field a scalar, and at least one of
 * those scalars a known envelope name. Without that last condition
 * `{ invoices: [ … ] }` would lose "Invoices", the only word naming its table.
 */
export function envelopedListKey(entries: Entry[]): string | null {
    const http = httpResponseListKey(entries);
    if (http) return http;
    let key: string | null = null;
    let envelopeFields = 0;
    for (const [k, v] of entries) {
        if (Array.isArray(v)) {
            if (key) return null;
            if (v.length === 0 || !v.some(isPlainObject)) return null;
            key = k;
        } else if (v !== null && typeof v === 'object') {
            return null;
        } else if (ENVELOPE_FIELDS.has(String(k).toLowerCase().replace(/_/g, ''))) {
            envelopeFields++;
        } else {
            return null;
        }
    }
    return (key && envelopeFields > 0) ? key : null;
}

/**
 * Is this the "run once per item" envelope the runner emits: one row per
 * iteration, shaped `{ index, item, output, status }`? Those rows carry the
 * upstream item the step LOOPED OVER beside what the step ITSELF returned,
 * and a flat grid merges them into one ambiguous blob (BFSF-369).
 */
export function isForEachEnvelope(rows: unknown[], baseCols: string[]): boolean {
    if (!baseCols.includes('item') || !baseCols.includes('output')) return false;
    if (!baseCols.includes('index') && !baseCols.includes('status')) return false;
    const objs = rows.filter(isPlainObject);
    return objs.length > 0 && objs.every(r => 'item' in r && 'output' in r);
}

interface HeaderSpan { label: string | null; span: number }

/**
 * Contiguous header spans for the envelope's two halves, so the grid says
 * which side of the loop each column came from. Null when the columns aren't
 * the envelope's: never a row of empty headers.
 */
export function envelopeSpans(cols: string[]): HeaderSpan[] | null {
    const labelFor = (c: string): string | null => {
        if (c === 'item' || c.startsWith('item.') || c.startsWith('item[')) return 'Looped over';
        if (c === 'output' || c.startsWith('output.') || c.startsWith('output[')) return 'This step returned';
        return null;
    };
    const spans: HeaderSpan[] = [];
    for (const c of cols) {
        const label = labelFor(c);
        const last = spans[spans.length - 1];
        if (last && last.label === label) last.span += 1;
        else spans.push({ label, span: 1 });
    }
    return spans.some(s => s.label) ? spans : null;
}

/**
 * The one list of records a plain object carries beside nothing but scalars,
 * `{ files: [ … ], count: 23, folder: '/' }`: the step drawer shows that list
 * as the table and the scalars as small fields under it (artboard 4b). Wider
 * than `envelopedListKey` on purpose: the scalars stay on screen, so none of
 * them is being hidden.
 */
export function soleRecordListKey(value: unknown): string | null {
    if (!isPlainObject(value)) return null;
    let key: string | null = null;
    for (const [k, v] of Object.entries(value)) {
        if (Array.isArray(v)) {
            if (key) return null;
            if (v.length === 0 || !v.some(isPlainObject)) return null;
            key = k;
        } else if (v !== null && typeof v === 'object') {
            return null;
        }
    }
    return key;
}
