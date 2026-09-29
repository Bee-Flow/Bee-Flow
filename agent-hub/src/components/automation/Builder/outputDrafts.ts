/**
 * The values the hand-written-output sheet edits, and the cap on what it may
 * save. Pure: no React, no DOM. `draftRecords` reads the sheet's JSON text
 * into rows the field list can show, `draftValue` turns those rows back into
 * the value that gets saved, and the two are each other's inverse for every
 * shape `outputShape` names.
 */

/**
 * How big a hand-written output may be, in bytes of JSON.
 *
 * Not a style choice. The inspector PUTs the ENTIRE definition on every save,
 * so an oversized pin does not fail once — it 400s every later, unrelated edit
 * to the same routine, and failedPatchRef retries straight back into it. 64 KB
 * is generous for a shape (a hundred-odd fields, or a couple of sample records)
 * and nowhere near the definition limits.
 */
export const MAX_PINNED_BYTES = 64 * 1024;

/** Which face the sheet opens on; null is a real answer — see outputShape. */
export type OutputShape = 'fields' | 'records' | 'value';

/** The kinds the author can pick between in the field list. */
export type OutFieldKind = 'text' | 'number' | 'yesno';

/** Those, plus the one the field list shows and refuses to flatten. */
export type RowEditorKind = OutFieldKind | 'nested';

/**
 * One field of the draft. `key` is null for the single-value face — the row
 * that has no name to type — and '' for a field added but not yet named, which
 * is the pair recordValue tells apart.
 */
export interface OutputRow {
    id: string;
    key: string | null;
    kind: RowEditorKind;
    value: unknown;
    /** The typing buffer: `1.` and `-` are each halfway to a number. */
    text: string;
    multiline?: boolean;
}

/** One record of the draft: the single object's fields, or one row of a list. */
export interface OutputRecord {
    id: string;
    rows: OutputRow[];
}

/** JSON, pretty, without throwing on a cycle or a BigInt. */
export function safeJsonText(v: unknown): string {
    try { return JSON.stringify(v, null, 2) ?? ''; } catch { return ''; }
}

/** Byte length of the JSON encoding — null when it cannot be encoded at all. */
export function jsonByteLength(v: unknown): number | null {
    try {
        const text = JSON.stringify(v);
        if (typeof text !== 'string') return null;
        // Bytes, not characters: an emoji or a CJK name is 3–4 bytes and the
        // server's limit is on the stored document, not on `.length`.
        return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
    } catch {
        return null;
    }
}

/**
 * Which face the sheet opens on: `'fields'` for an object, `'records'` for a
 * list of objects (including the empty list, so a table can be started from
 * nothing), `'value'` for a single scalar, and null for everything else.
 *
 * `'value'` is not a corner case, it is the commonest seed in the drawer: an
 * AI step with no declared output fields describes itself as the one string
 * `"<AI response>"`, and on the raw editor that is a pair of quotes the author
 * has to type inside and must not delete. One box with the text in it says the
 * same thing and cannot be broken.
 *
 * Null is a real answer, not a gap to be filled in later. A list of strings and
 * a mixed list have no names to show and no single value to put in a box, and
 * the save contract says what leaves this sheet is what the author saw — so a
 * field list would have to invent something. Those shapes stay on the raw
 * editor, which shows them exactly.
 */
export function outputShape(value: unknown): OutputShape | null {
    if (isPlainObject(value)) return 'fields';
    if (Array.isArray(value) && value.every(isPlainObject)) return 'records';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return 'value';
    return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Row and record ids — React keys only; nothing persists them. */
let outRowSeq = 0;
export const nextRowId = (): string => `of${++outRowSeq}`;

/**
 * Which EDITOR a value gets. Deliberately coarser than fieldKinds.kindOfValue:
 * that one answers "what is this", this one answers "what control can change
 * it without losing it". A date is an ISO string and edits as text; anything
 * with structure inside it — a group, a list, a file — gets no control at all
 * rather than a text box, because String({…}) is "[object Object]" and an
 * explicit Save would store exactly that.
 */
function editorKindOf(v: unknown): RowEditorKind {
    if (v === null || v === undefined || typeof v === 'string') return 'text';
    if (typeof v === 'number' || typeof v === 'bigint') return 'number';
    if (typeof v === 'boolean') return 'yesno';
    return 'nested';
}

/** The kinds the author can pick between, in the variable tree's own words. */
export const OUT_FIELD_KINDS: OutFieldKind[] = ['text', 'number', 'yesno'];

/** Is this <select> value one of the kinds a row may be set to? */
export function isOutFieldKind(value: string): value is OutFieldKind {
    return (OUT_FIELD_KINDS as string[]).includes(value);
}

export const rowText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * Does this row need a TEXTAREA rather than a one-line box?
 *
 * Not cosmetics — `<input type="text">` runs the HTML value sanitisation
 * algorithm, which STRIPS every LF and CR. A pinned "Dear Ada,\n\nThanks…"
 * therefore renders as "Dear Ada,Thanks…" in a one-line box, and the first
 * keystroke in it hands that flattened string back through onChange and into
 * the JSON. The paragraphs are gone without a single visible edit — and the
 * value this happens to first is the commonest one in this whole sheet, an AI
 * step's own answer, which arrives as one multi-paragraph string on the
 * NAMELESS single-value face. A sheet that exists so nobody has to type JSON
 * must not quietly delete the text it was handed.
 *
 * Sticky, kept on the ROW rather than recomputed from the text: deleting the
 * last newline would otherwise swap the control back to an input mid-sentence
 * and take the caret with it.
 */
export const isMultilineText = (v: unknown): boolean => typeof v === 'string' && /[\r\n]/.test(v);

export function rowDraft(key: string | null, value: unknown): OutputRow {
    const kind = editorKindOf(value);
    return { id: nextRowId(), key, kind, value, text: rowText(value), multiline: isMultilineText(value) };
}

function recordDraft(obj: Record<string, unknown>): OutputRecord {
    return { id: nextRowId(), rows: Object.entries(obj).map(([k, v]) => rowDraft(k, v)) };
}

/**
 * The draft the field list edits, read out of the sheet's JSON text.
 *
 * A single value becomes one NAMELESS row — `key: null`, which is what the row
 * reads to leave its name box out. Empty string would not do: that is what an
 * added-but-unnamed field carries, and those are the rows recordValue drops.
 */
export function draftRecords(text: string): OutputRecord[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (Array.isArray(parsed)) return parsed.map(r => recordDraft(isPlainObject(r) ? r : {}));
    if (isPlainObject(parsed)) return [recordDraft(parsed)];
    return [{ id: nextRowId(), rows: [rowDraft(null, parsed)] }];
}

function recordValue(rec: Pick<OutputRecord, 'rows'>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // An UNNAMED row is not a field yet. It is a value on its way to a name,
    // and writing it under "" would both collide with the next unnamed row and
    // save a key nothing downstream can bind to. It stays in the draft — on
    // screen, where the author put it — and joins the JSON when it is named.
    for (const row of rec.rows) if (row.key) out[row.key] = row.value;
    return out;
}

/** The draft, back as the value the sheet saves. */
export function draftValue(shape: OutputShape | null, records: OutputRecord[]): unknown {
    if (shape === 'records') return records.map(recordValue);
    if (shape === 'value') return records[0]?.rows?.[0]?.value ?? '';
    return recordValue(records[0] || { rows: [] });
}

/**
 * What a typed-in field is WORTH, for the kind its row is set to.
 *
 * Text stays text: an order id of `0042` or a postcode of `1011` is a string,
 * and a field list that sniffed its input for numbers would quietly retype
 * both. Only a NUMBER row converts, and it keeps the typing buffer (`row.text`)
 * beside the value because `1.` and `-` are each halfway to a number —
 * rendering the converted value back into the box would delete the character
 * just typed. A number row holding something that is not a number keeps that
 * text AS text rather than rounding it to 0 or dropping it: the raw editor
 * below shows it quoted, which is the honest report of what will be saved.
 */
export function typedValue(kind: RowEditorKind, text: string): string | number | null {
    if (kind !== 'number') return text;
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
}

/** Changing a row's kind converts what is already in it — explicitly, on ask. */
export function coerceToKind(kind: RowEditorKind, value: unknown): string | number | boolean {
    if (kind === 'yesno') {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        return /^\s*(true|yes|ja|1)\s*$/i.test(String(value ?? ''));
    }
    if (kind === 'number') {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }
    return rowText(value);
}
