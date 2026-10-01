/**
 * A field's text as a person reads it: every data reference drawn as a pill
 * named for a person ("gmail search ▸ Total"), the literal text around it as
 * typed. The phone's half of the web's RefTokenInput (agent-hub
 * `Builder/mapping/RefTokenInput.jsx` + `refEditorDom.js`), which keeps the
 * reference one atomic pill at all times — never `{{steps.act_4d4307a.output.total}}`
 * on screen while someone writes a prompt.
 *
 * A TextInput can hold styled spans (its children) but not nodes, so the field
 * shows the DISPLAY text — each reference replaced by its pill label — and this
 * module maps between that and the stored RAW text:
 *
 *   raw      Re: {{steps.act_1.output.total}}
 *   display  Re:  gmail search ▸ Total        (the label padded, spaces non-breaking)
 *
 * The stored value is never rewritten: an edit of the display text is applied
 * to the raw text around the pills, and a pill the edit touches goes as a
 * whole (one backspace removes the reference, as on the web).
 *
 * Pure on purpose: the component (PillTextInput) only renders and relays.
 */

import { chipLabel, type TextChip } from './bindingText';

export type PillSegment =
    | { kind: 'text'; text: string; rawStart: number; start: number; end: number }
    | { kind: 'pill'; chip: TextChip; label: string; rawStart: number; rawEnd: number; start: number; end: number };

export interface PillText {
    raw: string;
    segments: PillSegment[];
    display: string;
}

export interface TextRange {
    start: number;
    end: number;
}

/** An edit of the raw text: the new text and where the caret goes (raw). */
export interface PillEdit {
    raw: string;
    caret: number;
    /** The raw range the person typed, empty when they only deleted. */
    typed: TextRange | null;
}

const NBSP = ' ';

/**
 * How a pill reads inside the field. Padded like the web's `px-1.5`, and its
 * spaces non-breaking so a pill never wraps in two (`whitespace-nowrap`).
 */
export function pillLabel(chip: Pick<TextChip, 'name' | 'suffix'>): string {
    return `${NBSP}${chipLabel(chip).replace(/ /g, NBSP)}${NBSP}`;
}

/** The raw text split into literal runs and pills, with both coordinates. */
export function pillText(raw: string, chips: readonly TextChip[]): PillText {
    const segments: PillSegment[] = [];
    let display = '';
    let last = 0;
    const text = (from: number, to: number) => {
        if (to <= from) return;
        const run = raw.slice(from, to);
        segments.push({ kind: 'text', text: run, rawStart: from, start: display.length, end: display.length + run.length });
        display += run;
    };
    for (const chip of chips) {
        if (chip.start < last) continue;
        text(last, chip.start);
        const label = pillLabel(chip);
        segments.push({ kind: 'pill', chip, label, rawStart: chip.start, rawEnd: chip.end, start: display.length, end: display.length + label.length });
        display += label;
        last = chip.end;
    }
    text(last, raw.length);
    return { raw, segments, display };
}

/** A raw position as a display position; one inside a reference lands after its pill. */
export function toDisplay(pt: PillText, rawPos: number): number {
    for (const seg of pt.segments) {
        if (seg.kind === 'text') {
            const rawEnd = seg.rawStart + seg.text.length;
            if (rawPos >= seg.rawStart && rawPos <= rawEnd) return seg.start + (rawPos - seg.rawStart);
        } else if (rawPos <= seg.rawStart) {
            return seg.start;
        } else if (rawPos <= seg.rawEnd) {
            return seg.end;
        }
    }
    return pt.display.length;
}

/** A display position as a raw position; one inside a pill lands after its reference. */
export function toRaw(pt: PillText, displayPos: number): number {
    for (const seg of pt.segments) {
        if (seg.kind === 'text') {
            if (displayPos >= seg.start && displayPos <= seg.end) return seg.rawStart + (displayPos - seg.start);
        } else if (displayPos <= seg.start) {
            return seg.rawStart;
        } else if (displayPos <= seg.end) {
            return seg.rawEnd;
        }
    }
    return pt.raw.length;
}

/** A display range as a raw range. */
export function rangeToRaw(pt: PillText, range: TextRange): TextRange {
    return { start: toRaw(pt, Math.min(range.start, range.end)), end: toRaw(pt, Math.max(range.start, range.end)) };
}

/** What changed between two display texts: `[from, to)` of the old one became `inserted`. */
interface DisplayChange {
    from: number;
    to: number;
    inserted: string;
}

function clamp(n: number, max: number): number {
    return Math.max(0, Math.min(n, max));
}

/**
 * The change as the keyboard made it, read from where the caret was: typing or
 * pasting over the selection, or a backspace/delete beside a collapsed caret.
 * A plain text diff cannot tell which of two equal characters went; the caret
 * can, and next to a pill that decides WHICH pill goes.
 */
function anchoredChange(prev: string, next: string, selection: TextRange | null): DisplayChange | null {
    if (!selection) return null;
    const s = clamp(Math.min(selection.start, selection.end), prev.length);
    const e = clamp(Math.max(selection.start, selection.end), prev.length);
    const insLen = next.length - (prev.length - (e - s));
    if (insLen >= 0 && next.slice(0, s) === prev.slice(0, s) && next.slice(s + insLen) === prev.slice(e)) {
        return { from: s, to: e, inserted: next.slice(s, s + insLen) };
    }
    if (s !== e) return null;
    const k = prev.length - next.length;
    if (k > 0) {
        if (s - k >= 0 && prev.slice(0, s - k) + prev.slice(s) === next) return { from: s - k, to: s, inserted: '' };
        if (s + k <= prev.length && prev.slice(0, s) + prev.slice(s + k) === next) return { from: s, to: s + k, inserted: '' };
        return null;
    }
    // A keyboard that reported the caret where the typing LEFT it, before the
    // text arrived: the run typed is the one that ends at the caret.
    const n = -k;
    const after = clamp(Math.max(selection.start, selection.end), next.length);
    if (n > 0 && after - n >= 0 && next.slice(0, after - n) === prev.slice(0, after - n) && next.slice(after) === prev.slice(after - n)) {
        return { from: after - n, to: after - n, inserted: next.slice(after - n, after) };
    }
    return null;
}

/** The smallest change that turns `prev` into `next` (an autocorrect, a keyboard that skipped the selection event). */
function diffChange(prev: string, next: string): DisplayChange {
    let p = 0;
    const max = Math.min(prev.length, next.length);
    while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
    let s = 0;
    while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
    return { from: p, to: prev.length - s, inserted: next.slice(p, next.length - s) };
}

/** The pill a display position sits strictly inside, if any. */
function pillAround(pt: PillText, pos: number): Extract<PillSegment, { kind: 'pill' }> | null {
    for (const seg of pt.segments) {
        if (seg.kind === 'pill' && seg.start < pos && pos < seg.end) return seg;
    }
    return null;
}

/** The raw text being rebuilt, and where the typed run landed in it. */
interface Rebuild {
    out: string;
    typedAt: number;
    caret: number;
}

/** Put the typed run here, once. */
function place(r: Rebuild, inserted: string): void {
    if (r.caret >= 0) return;
    r.typedAt = r.out.length;
    r.out += inserted;
    r.caret = r.out.length;
}

/** Apply a display change to the raw text: literal runs change, a touched pill goes whole. */
function splice(pt: PillText, { from, to, inserted }: DisplayChange): PillEdit {
    // Typing inside a pill's label cannot edit the reference: it goes after it.
    const host = from === to ? pillAround(pt, from) : null;
    const at = host ? host.end : from;
    const r: Rebuild = { out: '', typedAt: -1, caret: -1 };
    for (const seg of pt.segments) {
        if (seg.kind === 'pill') {
            if (at <= seg.start) place(r, inserted);
            const touched = to > from && seg.start < to && seg.end > from;
            if (!touched) r.out += pt.raw.slice(seg.rawStart, seg.rawEnd);
            else if (at < seg.end) place(r, inserted);
            continue;
        }
        r.out += seg.text.slice(0, clamp(from - seg.start, seg.text.length));
        if (at >= seg.start && at <= seg.end) place(r, inserted);
        r.out += seg.text.slice(clamp(to - seg.start, seg.text.length));
    }
    place(r, inserted);
    return { raw: r.out, caret: r.caret, typed: inserted ? { start: r.typedAt, end: r.caret } : null };
}

/**
 * The raw text after the person changed the display text to `next`, with the
 * caret where the display edit left it. `selection` is the display selection
 * just before the edit (Android reports it before the text changes).
 */
export function applyDisplayEdit(pt: PillText, next: string, selection: TextRange | null): PillEdit {
    if (next === pt.display) {
        const at = toRaw(pt, selection ? Math.max(selection.start, selection.end) : pt.display.length);
        return { raw: pt.raw, caret: at, typed: null };
    }
    return splice(pt, anchoredChange(pt.display, next, selection) ?? diffChange(pt.display, next));
}
