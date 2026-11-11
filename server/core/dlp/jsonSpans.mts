/**
 * jsonSpans.mts: PII spans in a JSON tool result keep the JSON intact.
 *
 * A tool result reaches the guard as compact JSON (toolRound/toolContent.js),
 * and a detected span can run over a string literal's closing quote into the
 * next value: `http://example.nl","Jan Jansen` came back as ONE url span, so
 * one `[url_1]` token swallowed two elements of a sheet row and the model saw
 * four values where there were five. cellSplit.js cuts spans at line and cell
 * breaks; this is the same rule for JSON: a "cell" is one string literal or
 * one bare scalar (a number, true, false, null).
 *
 *   1. Every span is cut into one piece per cell it touches, keeping the
 *      span's category on every piece. Keeping only the piece where the span
 *      starts would be simpler, but the guard merges overlapping spans into
 *      one (the anti-leak union in pii/overlaps.py), so the name next to the
 *      URL exists only as the tail of the URL span: dropping the tail would
 *      put the name in the clear. A piece that is no value of its own (only
 *      structure, a one-digit count) is dropped, as cellSplit does.
 *   2. A bare scalar that holds a piece is quoted first, so its token sits in
 *      a string literal instead of breaking the JSON.
 *   3. The tokenised text must parse with the same shape (array lengths, key
 *      counts). If it does not, every touched cell is tokenised on its own,
 *      decoded and re-encoded; that result is used only when it still hides
 *      every value the whole-text pass hid, otherwise the whole-text result
 *      stands (a broken shape is better than a leaked value).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { isFragment } = nodeRequire('../privacy/piiDetection/cellSplit.js') as {
    isFragment: (category: string, piece: string, particles: Set<string>) => boolean;
};

export interface Span { offset: number; length: number; category?: string; text?: string }

export interface RedactResult {
    content: string;
    tokenMap: Record<string, string>;
    redactedLabels: string[];
    redactedLogLabels: string[];
    blockedCount: number;
    tokenizedCount: number;
}

/** The plain-text redaction, applied to the whole text or to one cell. */
export type RedactRun<E extends Span> = (text: string, entities: E[], tokenMap: Record<string, string>) => RedactResult;

/** `start`/`end` bound the raw characters: a string's content without its quotes. */
interface Cell { start: number; end: number; kind: 'string' | 'scalar' }

/** `spill`: a piece in a later cell than the one its span starts in. */
interface Piece<E> { entity: E; cell: number; spill?: boolean }

const STRUCTURAL = new Set(['[', ']', '{', '}', ',', ':', ' ', '\t', '\n', '\r']);
const NO_PARTICLES = new Set<string>();
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** The parsed value when `text` is a JSON object or array, else undefined. */
export function parseJsonContainer(text: string): unknown {
    const head = text.trimStart()[0];
    if (head !== '{' && head !== '[') return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** Index of the closing quote of the string whose content starts at `from`. */
function stringEnd(text: string, from: number): number {
    let j = from;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    return j;
}

/** Every string literal and bare scalar of valid JSON, in text order. */
export function scanJsonCells(text: string): Cell[] {
    const cells: Cell[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            const end = stringEnd(text, i + 1);
            cells.push({ start: i + 1, end, kind: 'string' });
            i = end + 1;
        } else if (STRUCTURAL.has(ch)) {
            i += 1;
        } else {
            let j = i;
            while (j < text.length && text[j] !== '"' && !STRUCTURAL.has(text[j])) j += 1;
            cells.push({ start: i, end: j, kind: 'scalar' });
            i = j;
        }
    }
    return cells;
}

/**
 * The value of a JSON string's raw content, and per raw position the index in
 * that value (-1 inside an escape sequence, which a cut may not split).
 */
export function decodeJsonString(raw: string): { value: string; at: number[] } {
    const at: number[] = new Array(raw.length + 1).fill(-1);
    let value = '';
    let i = 0;
    while (i < raw.length) {
        at[i] = value.length;
        if (raw[i] !== '\\') {
            value += raw[i];
            i += 1;
        } else if (raw[i + 1] === 'u') {
            value += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16));
            i += 6;
        } else {
            value += ESCAPES[raw[i + 1]] ?? raw[i + 1];
            i += 2;
        }
    }
    at[raw.length] = value.length;
    return { value, at };
}

/** A scalar's position map: every position is its own. */
function identityMap(length: number): number[] {
    return Array.from({ length: length + 1 }, (_, k) => k);
}

/** The raw position map of a cell: a string's escapes, a scalar 1:1. */
function cellMap(text: string, cell: Cell, cache: Map<Cell, number[]>): number[] {
    let at = cache.get(cell);
    if (!at) {
        const raw = text.slice(cell.start, cell.end);
        at = cell.kind === 'string' ? decodeJsonString(raw).at : identityMap(raw.length);
        cache.set(cell, at);
    }
    return at;
}

/** First cell whose end lies after `offset` (cells are sorted and disjoint). */
function firstCellAfter(cells: Cell[], offset: number): number {
    let lo = 0;
    let hi = cells.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cells[mid].end <= offset) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** The part of [from, to) inside `cell`, widened over a split escape and trimmed. */
function cutInCell(text: string, cell: Cell, from: number, to: number, cache: Map<Cell, number[]>): [number, number] {
    const at = cellMap(text, cell, cache);
    let s = Math.max(from, cell.start);
    let t = Math.min(to, cell.end);
    while (s > cell.start && at[s - cell.start] === -1) s -= 1;
    while (t < cell.end && at[t - cell.start] === -1) t += 1;
    while (s < t && /\s/.test(text[s])) s += 1;
    while (t > s && /\s/.test(text[t - 1])) t -= 1;
    return [s, t];
}

/** The cells [first, last] that the span [from, to) touches. */
function touchedCells(cells: Cell[], from: number, to: number): number[] {
    const out: number[] = [];
    for (let c = firstCellAfter(cells, from); c < cells.length && cells[c].start < to; c += 1) out.push(c);
    return out;
}

/** Is the string cell `cell` an object key (a `:` follows its closing quote)? */
function isKey(text: string, cell: Cell): boolean {
    if (cell.kind !== 'string') return false;
    let j = cell.end + 1;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    return text[j] === ':';
}

/** A piece of a split span that names nothing: structure, a tiny number, a key it ran into. */
function droppedPiece(text: string, cells: Cell[], c: number, spill: boolean, category: string, piece: string): boolean {
    return isFragment(category, piece, NO_PARTICLES) || (spill && isKey(text, cells[c]));
}

/**
 * One span as its pieces, one per touched cell. A piece in a later cell is a
 * spill; a spill into an object key is dropped (the key is the tool's field
 * name, as `"rowCount"` after the last value of a sheet row).
 */
function piecesOf<E extends Span>(e: E, text: string, cells: Cell[], cache: Map<Cell, number[]>): Piece<E>[] {
    const end = e.offset + e.length;
    const touched = touchedCells(cells, e.offset, end);
    const out: Piece<E>[] = [];
    for (const c of touched) {
        const [s, t] = cutInCell(text, cells[c], e.offset, end, cache);
        if (t <= s) continue;
        if (s === e.offset && t === end) {
            out.push({ entity: e, cell: c });
            continue;
        }
        const piece = text.slice(s, t);
        const spill = c !== touched[0];
        if (touched.length > 1 && droppedPiece(text, cells, c, spill, String(e.category || ''), piece)) continue;
        out.push({ entity: { ...e, offset: s, length: t - s, text: piece }, cell: c, spill });
    }
    return out;
}

/**
 * Drop a spilled piece that another span's own piece already covers: the
 * value keeps its redaction and gets the label of the span that found it
 * (`Jan Jansen` as a person, not as the tail of a URL).
 */
function dropCoveredSpills<E extends Span>(pieces: Piece<E>[]): Piece<E>[] {
    const own = new Map<number, E[]>();
    for (const p of pieces) if (!p.spill) own.set(p.cell, [...(own.get(p.cell) || []), p.entity]);
    return pieces.filter(p => !p.spill || !(own.get(p.cell) || []).some(o => o.offset <= p.entity.offset
        && o.offset + o.length >= p.entity.offset + p.entity.length));
}

/** Has the span a usable place in `text`? One without is replaced by its text (tokenizer.js), not cut. */
function positioned(e: Span, text: string): boolean {
    return Number.isFinite(e?.offset) && Number.isFinite(e?.length) && e.offset >= 0 && e.length > 0 && e.offset + e.length <= text.length;
}

/** Every positioned span cut at JSON cell boundaries; a span inside one cell stays itself. */
export function splitAtJsonCells<E extends Span>(entities: E[], text: string, cells: Cell[]): Piece<E>[] {
    const cache = new Map<Cell, number[]>();
    const out: Piece<E>[] = [];
    for (const e of entities) {
        if (!positioned(e, text)) continue;
        out.push(...piecesOf(e, text, cells, cache));
    }
    return dropCoveredSpills(out);
}

/** `text` with every scalar that holds a piece quoted, and the pieces moved along. */
function quoteScalars<E extends Span>(text: string, pieces: Piece<E>[], cells: Cell[]): { text: string; entities: E[] } {
    const quoted = new Set(pieces.filter(p => cells[p.cell].kind === 'scalar').map(p => p.cell));
    if (!quoted.size) return { text, entities: pieces.map(p => p.entity) };
    const shift: number[] = [];
    let parts = '';
    let pos = 0;
    let added = 0;
    cells.forEach((cell, c) => {
        if (!quoted.has(c)) { shift[c] = added; return; }
        parts += `${text.slice(pos, cell.start)}"${text.slice(cell.start, cell.end)}"`;
        pos = cell.end;
        shift[c] = added + 1;
        added += 2;
    });
    const entities = pieces.map(p => ({ ...p.entity, offset: p.entity.offset + shift[p.cell] }));
    return { text: parts + text.slice(pos), entities };
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Same arrays (by length), same objects (by key count), all the way down. */
export function sameShape(a: unknown, b: unknown): boolean {
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]));
    if (isObject(a)) {
        if (!isObject(b)) return false;
        const av = Object.values(a);
        const bv = Object.values(b);
        return av.length === bv.length && av.every((x, i) => sameShape(x, bv[i]));
    }
    return !Array.isArray(b) && !isObject(b);
}

function emptyResult(content: string): RedactResult {
    return { content, tokenMap: {}, redactedLabels: [], redactedLogLabels: [], blockedCount: 0, tokenizedCount: 0 };
}

function addResult(acc: RedactResult, r: RedactResult): void {
    Object.assign(acc.tokenMap, r.tokenMap);
    acc.redactedLabels = [...new Set([...acc.redactedLabels, ...r.redactedLabels])];
    acc.redactedLogLabels = [...new Set([...acc.redactedLogLabels, ...r.redactedLogLabels])];
    acc.blockedCount += r.blockedCount;
    acc.tokenizedCount += r.tokenizedCount;
}

/** The pieces of one cell, in the coordinates of the cell's decoded value. */
function leafEntities<E extends Span>(pieces: Piece<E>[], cell: Cell, at: number[], value: string): E[] {
    return pieces.map(({ entity: e }) => {
        const s = at[e.offset - cell.start];
        const t = at[e.offset + e.length - cell.start];
        return { ...e, offset: s, length: t - s, text: value.slice(s, t) };
    }).filter(e => e.length > 0);
}

/** Each touched cell redacted on its own, decoded and re-encoded as a JSON string. */
function redactPerCell<E extends Span>(text: string, pieces: Piece<E>[], cells: Cell[], run: RedactRun<E>, existing: Record<string, string>): RedactResult {
    const byCell = new Map<number, Piece<E>[]>();
    for (const p of pieces) byCell.set(p.cell, [...(byCell.get(p.cell) || []), p]);
    const acc = emptyResult(text);
    const edits: Array<[number, number, string]> = [];
    for (const c of [...byCell.keys()].sort((x, y) => x - y)) {
        const cell = cells[c];
        const raw = text.slice(cell.start, cell.end);
        const leaf = cell.kind === 'string' ? decodeJsonString(raw) : { value: raw, at: identityMap(raw.length) };
        const r = run(leaf.value, leafEntities(byCell.get(c) || [], cell, leaf.at, leaf.value), { ...existing, ...acc.tokenMap });
        addResult(acc, r);
        if (r.content === leaf.value) continue;
        const quote = cell.kind === 'string' ? 1 : 0;
        edits.push([cell.start - quote, cell.end + quote, JSON.stringify(r.content)]);
    }
    let out = text;
    for (const [s, t, repl] of edits.reverse()) out = out.slice(0, s) + repl + out.slice(t);
    acc.content = out;
    return acc;
}

/** True when `candidate` still shows a value the whole-text pass replaced. */
function showsMore<E extends Span>(candidate: string, whole: RedactResult, pieces: Piece<E>[]): boolean {
    const hidden = [...Object.values(whole.tokenMap), ...pieces.map(p => p.entity.text || '')];
    return hidden.some(v => v.length > 0 && candidate.includes(v) && !whole.content.includes(v));
}

/**
 * Redact a JSON tool result (`parsed` is `JSON.parse(text)`) so the result
 * still parses with the same shape. `run` is the plain-text redaction.
 */
export function redactJson<E extends Span>(text: string, parsed: unknown, entities: E[], run: RedactRun<E>, existing: Record<string, string>): RedactResult {
    const cells = scanJsonCells(text);
    const pieces = splitAtJsonCells(entities, text, cells);
    const loose = entities.filter(e => !positioned(e, text));
    if (!pieces.length && !loose.length) return emptyResult(text);
    const quoted = quoteScalars(text, pieces, cells);
    const whole = run(quoted.text, [...quoted.entities, ...loose], existing);
    // A span without a place belongs to no cell, so only the whole text can hold it.
    if (loose.length || sameShape(parsed, parseJsonContainer(whole.content))) return whole;
    const perCell = redactPerCell(text, pieces, cells, run, existing);
    if (!sameShape(parsed, parseJsonContainer(perCell.content)) || showsMore(perCell.content, whole, pieces)) return whole;
    return perCell;
}
