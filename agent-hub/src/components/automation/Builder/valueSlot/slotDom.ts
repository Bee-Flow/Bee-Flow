import { describeSource } from '@shared/mapping/index.mjs';
import type { PickPart } from '@shared/mapping/index.mjs';
import { stepFamily } from '../flow/nodeDefs';
import { typeColorVar } from '../flow/nodeTypeColors';
import type { SlotPiece } from './composeValue';

/**
 * The DOM half of ComposeField: the field's pieces (typed text, value pills,
 * legacy `{{ }}` pills) as editable nodes, and those nodes read back as
 * pieces. Ported from mapping/refEditorDom.js, which works on `{{ }}` text
 * only; refEditorDom.js is removed once the whole-value fields (M4b) no
 * longer import it.
 *
 * A pill is one atomic node (`contenteditable="false"`): the caret steps
 * over it and Backspace takes all of it. It carries what it stands for as
 * data, never as its visible text:
 *
 *   a value   `data-part`  the compose part (JSON): its Source, take, as, join
 *   a legacy  `data-raw`   the exact `{{ … }}` substring, braces and spacing kept
 *
 * A value pill also carries `data-raw` (the placeholder of the path it
 * reads), so code that only knows `{{ }}` text reads something sensible.
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────
 *      serializeHost(buildFragment(pieces)) deep-equals pieces
 * for every list of pieces with no empty or adjacent texts. Everything the
 * editor does goes through these two functions; it is tested directly.
 *
 * Free of React (the editor owns its DOM: a re-render on every keystroke
 * would destroy the caret) and free of i18n: what a pill SAYS is the
 * caller's (PillSpec), this file only lays it out.
 */

export const PILL_ATTR = 'data-ref-pill';
export const PILL_SELECTOR = `[${PILL_ATTR}]`;
export const PART_ATTR = 'data-part';
// A <br> the browser needs to make a trailing newline visible, but that is
// NOT part of the value. Without it, Enter at the end moves the caret to a
// line that cannot be seen; with it counted, every Enter would double.
export const FILLER_ATTR = 'data-ref-filler';

/** How a pill looks. */
export type PillTone = 'value' | 'name' | 'formula' | 'stale';

/** What a pill says: worded by the caller, laid out here. */
export interface PillSpec {
    piece: Exclude<SlotPiece, string>;
    /** The value's name ("Product of all orderregels"). */
    name: string;
    tone: PillTone;
    /** The value is a list (all of it): shown as "≡ 12", or "≡" when the count is unknown. */
    list?: boolean;
    /** Values in the list on the sample, when known. */
    count?: number | null;
    /** The family colour (a CSS colour) of the step the value comes from. */
    tint?: string;
    /** The tooltip. */
    title?: string;
    /** The accessible name of the pill's list count ("12 values"). */
    countLabel?: string;
}

const PILL_CLASS = [
    'inline-flex items-center gap-1 align-baseline mx-0.5 rounded px-1.5 py-0.5',
    'text-[11px] border select-none whitespace-nowrap cursor-pointer',
].join(' ');
// A value wears the colour of the step FAMILY it comes from (the same colour
// as that card on the canvas); `--pill-tint` is set per pill.
const TONE_CLASS: Record<PillTone, string> = {
    value: 'border-[color-mix(in_srgb,var(--pill-tint)_45%,transparent)] bg-[color-mix(in_srgb,var(--pill-tint)_14%,transparent)] text-[var(--pill-tint)] hover:ring-1 hover:ring-[color-mix(in_srgb,var(--pill-tint)_60%,transparent)]',
    name: 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]',
    formula: 'border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-mono',
    // A value whose source is gone: amber, so it is found and fixed.
    stale: 'border-dashed border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] text-[var(--warning-ink)]',
};

/** The family colour of the step a value comes from; ink-grey when unknown. */
export function sourceTint(root: string | undefined, stepId: string | undefined, stepTypeById?: ReadonlyMap<string, string> | null): string {
    const family = root === 'trigger' || root === 'run' ? 'trigger'
        : root === 'loop' || root === 'item' ? 'loop'
        : stepFamily(stepId ? stepTypeById?.get?.(stepId) : undefined);
    return family ? typeColorVar(family) : 'var(--text-secondary)';
}

/** The `{{ }}` text a value pill also carries. */
function rawOfPart(part: PickPart): string {
    const path = describeSource(part.from);
    return path ? `{{${path}}}` : '';
}

/** One piece that is not text, as an atomic editor node. */
export function buildPill(spec: PillSpec, doc: Document = document): HTMLElement {
    const el = doc.createElement('span');
    el.setAttribute(PILL_ATTR, '');
    el.setAttribute('contenteditable', 'false');
    el.dataset.tone = spec.tone;
    if ('part' in spec.piece) {
        el.setAttribute(PART_ATTR, JSON.stringify(spec.piece.part));
        el.dataset.raw = rawOfPart(spec.piece.part);
    } else {
        el.dataset.raw = spec.piece.raw;
    }
    el.className = `${PILL_CLASS} ${TONE_CLASS[spec.tone] || TONE_CLASS.value}`;
    if (spec.tint) el.style.setProperty('--pill-tint', spec.tint);
    if (spec.title) el.title = spec.title;

    const nameEl = doc.createElement('span');
    nameEl.className = 'font-medium';
    nameEl.textContent = spec.name;
    el.appendChild(nameEl);

    if (spec.list) {
        const known = typeof spec.count === 'number' && Number.isFinite(spec.count);
        const countEl = doc.createElement('span');
        countEl.className = 'opacity-70';
        countEl.dataset.list = known ? String(spec.count) : '';
        if (spec.countLabel) countEl.setAttribute('aria-label', spec.countLabel);
        countEl.textContent = known ? `≡ ${spec.count}` : '≡';
        el.appendChild(countEl);
    }
    return el;
}

/** Text with newlines → text nodes separated by <br>. */
export function appendText(parent: Node, text: string, doc: Document = document): void {
    const parts = String(text ?? '').split('\n');
    parts.forEach((part, i) => {
        if (i > 0) parent.appendChild(doc.createElement('br'));
        if (part) parent.appendChild(doc.createTextNode(part));
    });
}

/** Pieces → the editor's child nodes; `pillFor` words each pill. */
export function buildFragment(
    pieces: SlotPiece[],
    pillFor: (piece: Exclude<SlotPiece, string>) => PillSpec,
    doc: Document = document,
): DocumentFragment {
    const frag = doc.createDocumentFragment();
    for (const piece of pieces) {
        if (typeof piece === 'string') appendText(frag, piece, doc);
        else frag.appendChild(buildPill(pillFor(piece), doc));
    }
    return frag;
}

/** The piece a pill element stands for, or null for an element that is not one. */
export function pieceOfPill(el: Element): Exclude<SlotPiece, string> | null {
    if (!el.hasAttribute(PILL_ATTR)) return null;
    const json = el.getAttribute(PART_ATTR);
    if (json) {
        try {
            const part = JSON.parse(json) as PickPart;
            if (part && typeof part === 'object') return { part };
        } catch { /* a damaged pill falls back to its raw text */ }
    }
    const raw = (el as HTMLElement).dataset.raw;
    return raw ? { raw } : null;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * The editor's nodes → its pieces, adjacent text merged.
 *
 * Tolerant of what a browser puts in a contenteditable on its own: a paste
 * can leave <div>/<p> wrappers and a stray <br>, and none of that may change
 * the author's text. Anything unrecognised is walked through, so an
 * unexpected wrapper costs its structure, never its content.
 */
export function serializeHost(host: Element | null): SlotPiece[] {
    if (!host) return [];
    const out: SlotPiece[] = [];
    let text = '';
    const flush = () => { if (text) out.push(text); text = ''; };

    const walk = (node: Node, topLevel: boolean) => {
        for (let i = 0; i < node.childNodes.length; i += 1) {
            const child = node.childNodes[i];
            if (child.nodeType === 3) { text += child.nodeValue || ''; continue; }
            if (child.nodeType !== 1) continue;
            const el = child as Element;
            if (el.hasAttribute(PILL_ATTR)) {
                const piece = pieceOfPill(el);
                if (piece) { flush(); out.push(piece); }
                continue;
            }
            if (el.tagName === 'BR') {
                if (!el.hasAttribute(FILLER_ATTR)) text += '\n';
                continue;
            }
            // A block wrapper starts a new line, except the very first one,
            // which is the existing line rather than a break from it.
            if (BLOCK_TAGS.has(el.tagName) && !(topLevel && i === 0)) text += '\n';
            walk(el, false);
        }
    };

    walk(host, true);
    flush();
    return out;
}

/**
 * Guarantee a caret position after a trailing newline or pill: a value
 * ending in `\n` (the new line has nothing to sit on) and one ending in a
 * pill (no text node to type into after it) both get an invisible node that
 * serialization skips.
 */
export function ensureTrailingFiller(host: Element | null, doc: Document = document): void {
    if (!host) return;
    const last = host.lastChild;
    if (last && last.nodeType === 1 && (last as Element).tagName === 'BR' && !(last as Element).hasAttribute(FILLER_ATTR)) {
        const filler = doc.createElement('br');
        filler.setAttribute(FILLER_ATTR, '');
        host.appendChild(filler);
        return;
    }
    if (last && last.nodeType === 1 && (last as Element).hasAttribute(PILL_ATTR)) {
        host.appendChild(doc.createTextNode(''));
    }
}

/** Replace the host's contents with `pieces`. */
export function renderInto(
    host: Element | null,
    pieces: SlotPiece[],
    pillFor: (piece: Exclude<SlotPiece, string>) => PillSpec,
    doc: Document = document,
): void {
    if (!host) return;
    host.textContent = '';
    host.appendChild(buildFragment(pieces, pillFor, doc));
    ensureTrailingFiller(host, doc);
}

/** Put the caret at the very end of the host. */
export function caretToEnd(host: Element | null, win: Window = window): void {
    const sel = win.getSelection?.();
    if (!sel || !host) return;
    const range = win.document.createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

export interface InsertOptions {
    /**
     * Where to insert. Given (even as null), the caller owns the caret: a
     * click on the {} button or in the source panel moves focus away, and a
     * refocus afterwards leaves the live selection at the START of the
     * field, so trusting it would drop every pick in front of the author's
     * text. No remembered caret means the end.
     */
    range?: Range | null;
    win?: Window;
    doc?: Document;
    /** Replace what the range covers (a pill being swapped). Otherwise nothing typed is ever removed. */
    replace?: boolean;
}

/**
 * Insert nodes at the caret (or at the end when the caret is elsewhere) and
 * leave the caret AFTER them, in a text node the author can type into. A
 * selection is never deleted: inserting a value puts it at the caret and
 * keeps every character the author typed.
 */
export function insertAtCaret(host: Element | null, nodes: Node[], opts: InsertOptions = {}): void {
    if (!host || !nodes.length) return;
    const { win = window, doc = document } = opts;
    const sel = win.getSelection?.();
    let range: Range | null = null;
    if ('range' in opts) {
        if (opts.range && host.contains(opts.range.commonAncestorContainer)) range = opts.range.cloneRange();
    } else if (sel && sel.rangeCount) {
        const candidate = sel.getRangeAt(0);
        if (host.contains(candidate.commonAncestorContainer)) range = candidate.cloneRange();
    }
    if (!range) {
        range = doc.createRange();
        range.selectNodeContents(host);
        range.collapse(false);
    }
    if (opts.replace) range.deleteContents();
    else range.collapse(false);

    const frag = doc.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    const lastInserted = frag.lastChild as Node;
    range.insertNode(frag);

    const after = doc.createTextNode('');
    lastInserted.parentNode?.insertBefore(after, lastInserted.nextSibling);
    ensureTrailingFiller(host, doc);

    if (sel) {
        const caret = doc.createRange();
        caret.setStart(after, 0);
        caret.collapse(true);
        sel.removeAllRanges();
        sel.addRange(caret);
    }
}

/**
 * The pill immediately before a collapsed caret, if there is one. Handling
 * Backspace ourselves makes "one press, the whole pill" the same in every
 * browser (Firefox has left an emptied pill behind).
 */
export function pillBeforeCaret(host: Element | null, win: Window = window): Element | null {
    const sel = win.getSelection?.();
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !host) return null;
    const { anchorNode, anchorOffset } = sel;
    if (!anchorNode || !host.contains(anchorNode)) return null;

    let prev: Node | null = null;
    if (anchorNode.nodeType === 3) {
        if (anchorOffset !== 0) return null;
        prev = anchorNode.previousSibling;
    } else {
        prev = anchorNode.childNodes[anchorOffset - 1] || null;
    }
    // Empty text nodes are our own caret parking spots: step over them.
    while (prev && prev.nodeType === 3 && prev.nodeValue === '') prev = prev.previousSibling;
    return prev && prev.nodeType === 1 && (prev as Element).hasAttribute(PILL_ATTR) ? prev as Element : null;
}

/** The plain text typed between the start of the caret's text node and a collapsed caret (autocomplete). */
export function textBeforeCaret(host: Element | null, win: Window = window): string {
    const sel = win.getSelection?.();
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !host) return '';
    const { anchorNode, anchorOffset } = sel;
    if (!anchorNode || (!host.contains(anchorNode) && anchorNode !== host)) return '';
    if (anchorNode.nodeType === 3) return String(anchorNode.nodeValue || '').slice(0, anchorOffset);
    return '';
}

/**
 * Delete `length` characters immediately before the caret: the partial the
 * author typed (`{{ste`) when they accept a suggestion, so the pill replaces
 * it rather than landing after it.
 */
export function deleteBeforeCaret(host: Element | null, length: number, { win = window, range: saved = null }: { win?: Window; range?: Range | null } = {}): void {
    if (length <= 0 || !host) return;
    const sel = win.getSelection?.();
    const ambient = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const range = saved && host.contains(saved.commonAncestorContainer) ? saved : ambient;
    if (!range || !sel) return;
    // A caret at the end of an element reports the ELEMENT as its
    // container, not the text it sits after: resolve to that text first.
    let node: Node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType !== 3) {
        const before = node.childNodes[offset - 1];
        if (!before || before.nodeType !== 3) return;
        node = before;
        offset = (node.nodeValue || '').length;
    }
    const value = node.nodeValue || '';
    const start = Math.max(0, offset - length);
    node.nodeValue = value.slice(0, start) + value.slice(offset);
    const caret = win.document.createRange();
    caret.setStart(node, start);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
}

type PointDoc = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

/**
 * The caret position under a POINT (a drop), as a collapsed range inside
 * `host`, or null when the point is outside it or the browser cannot say
 * (jsdom). A point on a pill lands right after it.
 */
export function rangeFromPoint(host: Element | null, x: number, y: number, doc: PointDoc = document): Range | null {
    if (!host || typeof x !== 'number' || typeof y !== 'number') return null;
    let range: Range | null = null;
    if (typeof doc.caretRangeFromPoint === 'function') {
        range = doc.caretRangeFromPoint(x, y);
    } else if (typeof doc.caretPositionFromPoint === 'function') {
        const pos = doc.caretPositionFromPoint(x, y);
        if (pos?.offsetNode) {
            range = doc.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
        }
    }
    if (!range || !host.contains(range.startContainer)) return null;
    const node = range.startContainer;
    const el = node.nodeType === 1 ? node as Element : node.parentElement;
    const pill = el?.closest?.(PILL_SELECTOR);
    if (pill && host.contains(pill)) {
        range = doc.createRange();
        range.setStartAfter(pill);
        range.collapse(true);
    }
    return range;
}

/** Swap one pill for `nodes`, caret after them. The pill is found again by position when the host was re-rendered. */
export function replacePill(host: Element | null, pill: Element | null, nodes: Node[], { win = window, doc = document, index = -1 }: { win?: Window; doc?: Document; index?: number } = {}): void {
    if (!host || !pill || !nodes.length) return;
    let target: Element | null = pill;
    if (!host.contains(target)) {
        const all = Array.from(host.querySelectorAll(PILL_SELECTOR));
        target = index >= 0 ? all[index] || null : null;
        if (!target) return;
    }
    const range = doc.createRange();
    range.selectNode(target);
    insertAtCaret(host, nodes, { range, win, doc, replace: true });
}

/** The position of a pill among the host's pills (to find it again after a re-render). */
export function pillIndex(host: Element | null, pill: Element | null): number {
    if (!host || !pill) return -1;
    return Array.from(host.querySelectorAll(PILL_SELECTOR)).indexOf(pill);
}
