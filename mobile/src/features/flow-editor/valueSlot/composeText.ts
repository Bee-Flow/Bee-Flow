/**
 * A composed text (`{ kind: 'compose', v: 1, parts: ['Beste ', {from, …}, …] }`)
 * as the text a phone field edits, and back. The web edits one with
 * ComposeField; the phone reuses its pill text field (fields/PillTextInput),
 * which edits a RAW text and draws chips over it. So each value part sits in
 * the raw text as a marker that names its place in a parts table:
 *
 *   parts  ['Beste ', {from: …naam}, ', uw orders:\n', {from: …product, take: 'all'}]
 *   raw    'Beste \uE0000\uE001, uw orders:\n\uE0001\uE001'
 *
 * The markers are Unicode private-use characters no keyboard types, so
 * literal text never turns into a value by accident (a typed `{{…}}` in a
 * composed text stays the text it is, as the run renders it). The table only
 * grows while a field is edited: a value taken out is a marker gone, and a
 * value added is a new entry. textToCompose reads the raw text back in part
 * order; nothing else about a part is ever touched, so a compose stored by the
 * web or the AI builder keeps every key it had (`label`, `required`, …).
 *
 * Pure.
 */

import { MAPPING_VERSION, type ComposeBinding, type PickPart } from '@/shared/mapping';

const OPEN = '\uE000';
const CLOSE = '\uE001';
const MARKER_RE = /\uE000(\d+)\uE001/g;

/** The marker of part `index` of the table. */
export function markerFor(index: number): string {
    return `${OPEN}${index}${CLOSE}`;
}

export interface ComposeText {
    raw: string;
    /** Every value part the raw text can name, by index. */
    parts: PickPart[];
}

/** A compose as raw text and its parts table. */
export function composeToText(compose: ComposeBinding): ComposeText {
    const parts: PickPart[] = [];
    let raw = '';
    for (const part of compose.parts) {
        if (typeof part === 'string') {
            // A private-use character a text part somehow holds would read as a marker.
            raw += part.replace(/[\uE000\uE001]/g, '');
            continue;
        }
        raw += markerFor(parts.length);
        parts.push(part);
    }
    return { raw, parts };
}

/** A marker in the raw text: where it sits and the part it names. */
export interface MarkerAt {
    start: number;
    end: number;
    part: PickPart;
}

/** The markers of a raw text that name a part of the table, in order. */
export function markersIn(raw: string, parts: readonly PickPart[]): MarkerAt[] {
    const out: MarkerAt[] = [];
    for (const m of raw.matchAll(MARKER_RE)) {
        const part = parts[Number(m[1])];
        const at = m.index as number;
        if (part) out.push({ start: at, end: at + m[0].length, part });
    }
    return out;
}

/**
 * The raw text read back: the compose it spells, or — when no value is left
 * in it — the plain text (null for the caller to store as its field's text).
 */
export function textToCompose(raw: string, parts: readonly PickPart[]): ComposeBinding | null {
    const out: (string | PickPart)[] = [];
    let last = 0;
    let values = 0;
    const text = (s: string) => {
        if (!s) return;
        const prev = out[out.length - 1];
        if (typeof prev === 'string') out[out.length - 1] = prev + s;
        else out.push(s);
    };
    for (const m of markersIn(raw, parts)) {
        text(raw.slice(last, m.start));
        out.push(m.part);
        values++;
        last = m.end;
    }
    text(raw.slice(last));
    return values ? { kind: 'compose', v: MAPPING_VERSION, parts: out } : null;
}

/** The raw text without its markers: what a compose with no value left says. */
export function plainText(raw: string): string {
    return raw.replace(MARKER_RE, '').replace(/[\uE000\uE001]/g, '');
}
