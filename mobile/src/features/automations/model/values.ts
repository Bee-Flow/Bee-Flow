/**
 * Step input and output, classified for reading rather than dumped as JSON.
 */

/**
 * Render a step's output for reading. Objects are pretty-printed and clipped:
 * a run step can carry a whole API response, and a 40 KB blob in a ScrollView
 * is a dropped frame plus a wall the eye slides off.
 */
export function previewValue(value: unknown, maxChars = 1200): string | null {
    if (value === null || value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else {
        try {
            text = JSON.stringify(value, null, 2);
        } catch {
            return null;
        }
    }
    text = text.trim();
    if (!text) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

/**
 * What a step's output IS, so it can be drawn instead of dumped.
 *
 * `previewValue` above pretty-prints every non-string output as JSON. That is
 * honest and it is unreadable: the commonest thing an automation step produces is
 * a LIST OF ROWS — the results of a search, the rows of a datatable, the files
 * in a folder — and a person reading a run on their phone gets two braces and
 * a wall of quoted keys where the web builder shows them a table. Web's
 * OutputView has offered Fields / Table / JSON for a while, defaulting away
 * from JSON; mobile never got the same treatment, so the same run reads
 * completely differently depending on which screen you opened it on.
 *
 * This is the classifier half, kept pure and here so it can be unit-tested
 * without a renderer. The component that draws it lives in
 * components/ValuePreview.tsx.
 *
 * Deliberately conservative about what counts as a TABLE. Rows must be plain
 * objects sharing a key set; the moment they disagree, or a cell holds
 * something that is not a scalar, it is not a table any more and falls back
 * rather than inventing empty columns or stringifying a nested object into a
 * cell. A wrong table is worse than honest JSON, because it looks authoritative.
 */

/** A cell we are willing to print inside a table. */
type Scalar = string | number | boolean | null;

export type ValueShape =
    | { kind: 'empty' }
    | { kind: 'scalar'; text: string }
    | { kind: 'list'; items: string[]; total: number }
    | { kind: 'record'; fields: { key: string; value: string }[] }
    | { kind: 'rows'; columns: string[]; rows: string[][]; total: number }
    | { kind: 'raw'; text: string };

/** Rows beyond this are counted, not drawn — a phone list is not a spreadsheet. */
export const MAX_PREVIEW_ROWS = 20;
/** Wider than this and the columns become unreadable slivers. */
export const MAX_PREVIEW_COLUMNS = 6;

function isScalar(v: unknown): v is Scalar {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The two words a boolean cell reads as; the screen passes them translated. */
export interface CellWords {
    yes: string;
    no: string;
}

const ENGLISH: CellWords = { yes: 'Yes', no: 'No' };

/** How a scalar reads in a cell. `null` is a WORD, not an empty cell: an
 *  absent value and a blank string are different facts about the data. */
function cellText(v: Scalar, words: CellWords): string {
    if (v === null) return '—';
    if (typeof v === 'boolean') return v ? words.yes : words.no;
    return String(v);
}

/**
 * A value worth reading as prose rather than as a literal: a string of
 * several words or lines (an AI step's answer, a composed email), which may
 * carry markdown. A number, an id, a date or a single word stays a literal.
 */
export function isProse(value: unknown): boolean {
    return typeof value === 'string' && /\s/.test(value.trim());
}

export function describeValue(value: unknown, words: CellWords = ENGLISH): ValueShape {
    if (value === null || value === undefined) return { kind: 'empty' };
    if (isScalar(value)) {
        const text = String(value).trim();
        return text ? { kind: 'scalar', text } : { kind: 'empty' };
    }

    if (Array.isArray(value)) return describeArray(value, words);
    if (isPlainObject(value)) return describeRecord(value, words);
    return { kind: 'raw', text: previewValue(value) ?? '' };
}

function describeArray(value: unknown[], words: CellWords): ValueShape {
    if (value.length === 0) return { kind: 'empty' };

    // A list of rows: every element a plain object, all sharing the first
    // one's keys. Anything less and it is not a table.
    const table = value.every(isPlainObject) ? describeRows(value, words) : null;
    if (table) return table;

    if (value.every(isScalar)) {
        return {
            kind: 'list',
            items: value.slice(0, MAX_PREVIEW_ROWS).map((v) => cellText(v as Scalar, words)),
            total: value.length,
        };
    }

    return { kind: 'raw', text: previewValue(value) ?? '' };
}

/** The table reading of a list of objects, or null when it is not one. */
function describeRows(value: Record<string, unknown>[], words: CellWords): ValueShape | null {
    const first = value[0] as Record<string, unknown>;
    const columns = Object.keys(first).slice(0, MAX_PREVIEW_COLUMNS);
    const sameShape = value.every((r) => columns.every((c) => c in r));
    const allScalar = value
        .slice(0, MAX_PREVIEW_ROWS)
        .every((r) => columns.every((c) => isScalar(r[c])));
    if (!columns.length || !sameShape || !allScalar) return null;
    const rows = value
        .slice(0, MAX_PREVIEW_ROWS)
        .map((r) => columns.map((c) => cellText(r[c] as Scalar, words)));
    return { kind: 'rows', columns, rows, total: value.length };
}

function describeRecord(value: Record<string, unknown>, words: CellWords): ValueShape {
    const entries = Object.entries(value);
    // An object with no keys has nothing to say. Falling through to `raw`
    // would print a literal "{}" in a box, which reads as a value rather
    // than as the absence of one.
    if (entries.length === 0) return { kind: 'empty' };
    // Only a FLAT record reads as fields. One nested object and the eye
    // needs the structure, so hand it to the raw view rather than printing
    // "[object Object]" next to a label.
    if (entries.every(([, v]) => isScalar(v))) {
        return { kind: 'record', fields: entries.map(([key, v]) => ({ key, value: cellText(v as Scalar, words) })) };
    }
    return { kind: 'raw', text: previewValue(value) ?? '' };
}
