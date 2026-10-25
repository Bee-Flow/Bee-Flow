import { type LabelLookup } from './refTokens';
import { PILL_ATTR, buildFragment } from './refEditorDom.helpers';
export { PILL_ATTR, PILL_TINT_CLASS, pillTint, buildPill, buildFragment, appendText } from './refEditorDom.helpers';

/**
 * The DOM half of the reference editor: turn a stored field value into editable
 * nodes, and read those nodes back into the stored value.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * The runtime resolver needs an id path — `steps.act_f9aaff0e.output.results[*]
 * .output`. An author should never have to look at one. RefChips already showed
 * the friendly name, but only while the field was BLURRED: the moment you
 * clicked in to write your prompt, the raw ids came back. So the raw path was
 * always on screen exactly when someone was working.
 *
 * The fix is to stop treating a reference as text. In the editor it is one
 * atomic node — `contenteditable="false"`, so the caret steps over it and
 * Backspace takes the whole thing — carrying the raw path in `data-raw` and
 * showing only "gmail read ▸ Output".
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────
 *      serializeHost(buildFragment(v)) === v
 * for every value, including ones with no references at all. Everything the
 * editor does goes through these two functions, so a bug here is a bug that
 * silently rewrites someone's saved automation. It is tested directly.
 *
 * Kept free of React so it can be tested as data-in / data-out, and so the
 * editor can own its DOM (a React re-render on every keystroke would destroy
 * the caret).
 */

export const PILL_SELECTOR = `[${PILL_ATTR}]`;
// A <br> the browser needs to make a trailing newline visible, but that is NOT
// part of the value. Without it, pressing Enter at the end moves the caret to a
// line that cannot be seen; with it counted, every Enter would double.
export const FILLER_ATTR = 'data-ref-filler';

/**
 * The editor's nodes → the stored value.
 *
 * Deliberately tolerant of what a browser puts in a contenteditable on its own:
 * a paste can leave <div>/<p> wrappers and a stray <br>, and none of that may
 * change the author's text. Anything unrecognised is walked through, so an
 * unexpected wrapper costs its structure, never its content.
 */
export function serializeHost(host: Element | null | undefined): string {
    if (!host) return '';
    let out = '';

    const walk = (node: Node, topLevel: boolean): void => {
        for (let i = 0; i < node.childNodes.length; i += 1) {
            const child = node.childNodes[i];
            if (child.nodeType === 3) { out += child.nodeValue; continue; }
            if (child.nodeType !== 1) continue;
            if ((child as HTMLElement).hasAttribute?.(PILL_ATTR)) { out += (child as HTMLElement).dataset.raw ?? ''; continue; }
            if ((child as HTMLElement).tagName === 'BR') {
                if (!(child as HTMLElement).hasAttribute?.(FILLER_ATTR)) out += '\n';
                continue;
            }
            // A block wrapper starts a new line — except the very first one,
            // which is the existing line rather than a break from it.
            if (BLOCK_TAGS.has((child as HTMLElement).tagName) && !(topLevel && i === 0)) out += '\n';
            walk(child, false);
        }
    };

    walk(host, true);
    return out;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Replace the host's contents with `value`, then park the caret at the end.
 * Used on mount, when the value changes from outside (undo, an AI patch), and
 * on blur — which is what turns a `{{…}}` someone typed or pasted by hand into
 * a pill.
 */
export function renderInto(host: HTMLElement | null | undefined, value: unknown, { mode, stepLabelById, stepTypeById = null, doc = document }: { mode?: string; stepLabelById?: LabelLookup | null; stepTypeById?: { get?(id: string | undefined): string | undefined } | null; doc?: Document } = {}): void {
    if (!host) return;
    host.textContent = '';
    host.appendChild(buildFragment(value, { mode, stepLabelById, stepTypeById, doc }));
    ensureTrailingFiller(host, doc);
}

/**
 * Guarantee a caret position after a trailing newline or pill.
 *
 * Two cases a contenteditable cannot represent on its own: a value ending in
 * `\n` (the new line has nothing to sit on) and one ending in a pill (there is
 * no text node to put the caret in, so the author cannot type after their own
 * reference — which is most of the time, since the reference usually comes
 * last). Both get an invisible node that serialization skips.
 */
export function ensureTrailingFiller(host: Node | null | undefined, doc: Document = document): void {
    if (!host) return;
    const last = host.lastChild as Element | null;
    if (last && last.nodeType === 1 && last.tagName === 'BR' && !last.hasAttribute(FILLER_ATTR)) {
        const filler = doc.createElement('br');
        filler.setAttribute(FILLER_ATTR, '');
        host.appendChild(filler);
        return;
    }
    if (last && last.nodeType === 1 && last.hasAttribute?.(PILL_ATTR)) {
        host.appendChild(doc.createTextNode(''));
    }
}

/** Put the caret at the very end of the host. */
export function caretToEnd(host: Node | null | undefined, win: Window = window): void {
    const sel = win.getSelection?.();
    if (!sel || !host) return;
    const range = (win.document || document).createRange();
    range.selectNodeContents(host);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
}

/** A pill reads as a word for spacing purposes. */
const WORD = /[\p{L}\p{N}]/u;
const SPACE_BEFORE = /[\p{L}\p{N},;:!?]/u;
const PILL_CHAR = 'x';

/** The character a node shows at its start (dir 1) or end (dir -1); a pill counts as a word character. */
function edgeChar(node: Node, dir: number): string | null {
    if (node.nodeType === 3) {
        const t = node.nodeValue || '';
        return t ? (dir < 0 ? t[t.length - 1] : t[0]) : null;
    }
    if (node.nodeType !== 1) return null;
    if ((node as Element).hasAttribute?.(PILL_ATTR)) return PILL_CHAR;
    if ((node as Element).hasAttribute?.(FILLER_ATTR)) return null;
    if (node.nodeName === 'BR') return '\n';
    const kids = node.childNodes;
    for (let i = dir < 0 ? kids.length - 1 : 0; i >= 0 && i < kids.length; i += dir < 0 ? -1 : 1) {
        const ch = edgeChar(kids[i], dir);
        if (ch) return ch;
    }
    return null;
}

/** The visible character right before (dir -1) or after (dir 1) a collapsed range, or null at the edge of the host. */
function neighbourChar(range: Range, host: Node, dir: number): string | null {
    const c = dir < 0 ? range.startContainer : range.endContainer;
    const o = dir < 0 ? range.startOffset : range.endOffset;
    let node: ChildNode | null;
    let parent: Node | null;
    if (c.nodeType === 3) {
        const t = c.nodeValue || '';
        const part = dir < 0 ? t.slice(0, o) : t.slice(o);
        if (part) return dir < 0 ? part[part.length - 1] : part[0];
        node = dir < 0 ? c.previousSibling : c.nextSibling;
        parent = c.parentNode;
    } else {
        node = dir < 0 ? c.childNodes[o - 1] : c.childNodes[o];
        parent = c;
    }
    for (;;) {
        while (node) {
            const ch = edgeChar(node, dir);
            if (ch) return ch;
            node = dir < 0 ? node.previousSibling : node.nextSibling;
        }
        if (!parent || parent === host) return null;
        node = dir < 0 ? (parent as ChildNode).previousSibling : (parent as ChildNode).nextSibling;
        parent = (parent as ChildNode).parentNode;
    }
}

/**
 * Insert nodes at the caret (or at the end when the caret is elsewhere) and
 * leave the caret AFTER them, in a text node the author can type into.
 *
 * `spaced` keeps a reference from fusing with its neighbours: a word (a
 * letter, a digit or another pill) or a `, ; : ! ?` right before it gets a
 * single space in front, a word right after it a space behind. Dropping three
 * fields in a row used to render "Hello world42true". Anything else stays put
 * ("/{{id}}", "({{x}})", "{{x}}."), and a data slot (a URL, a JSON body)
 * passes `spaced: false`.
 */
export function insertAtCaret(host: Element | null | undefined, nodes: Node[], opts: { win?: Window; doc?: Document; range?: Range | null; spaced?: boolean } = {}): void {
    if (!host || !nodes.length) return;
    const { win = window, doc = document } = opts;
    const sel = win.getSelection?.();
    let range = null;
    if ('range' in opts) {
        // The caller owns the caret. Clicking the {} button moves focus to the
        // picker, and a programmatic refocus afterwards leaves the selection at
        // the START of the field — so trusting the live selection here would
        // drop every picked reference in front of the author's text. No
        // remembered caret means the end, which is where "add this" belongs.
        if (opts.range && host.contains(opts.range.commonAncestorContainer)) range = opts.range;
    } else if (sel && sel.rangeCount) {
        const candidate = sel.getRangeAt(0);
        if (host.contains(candidate.commonAncestorContainer)) range = candidate;
    }
    if (!range) {
        range = doc.createRange();
        range.selectNodeContents(host);
        range.collapse(false);
    }
    range.deleteContents();

    let padAfter = false;
    if (opts.spaced) {
        const before = neighbourChar(range, host, -1);
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- WORD / SPACE_BEFORE are constant single-character classes tested on ONE character: linear
        const next = neighbourChar(range, host, 1);
        if (before && SPACE_BEFORE.test(before)) nodes = [doc.createTextNode(' '), ...nodes];
        padAfter = Boolean(next && WORD.test(next));
    }

    const frag = doc.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    const lastInserted = frag.lastChild as ChildNode;
    range.insertNode(frag);

    const after = doc.createTextNode(padAfter ? ' ' : '');
    (lastInserted.parentNode as ParentNode).insertBefore(after, lastInserted.nextSibling);
    ensureTrailingFiller(host, doc);

    if (sel) {
        const caret = doc.createRange();
        caret.setStart(after, (after.nodeValue as string).length);
        caret.collapse(true);
        sel.removeAllRanges();
        sel.addRange(caret);
    }
}

/**
 * The pill immediately before a collapsed caret, if there is one.
 *
 * Browsers mostly delete a `contenteditable="false"` node atomically, but not
 * consistently — Firefox has historically left the element and cleared its
 * contents, which would turn a reference into an empty pill that serializes to
 * a raw path nobody can see. Handling Backspace ourselves makes it the same
 * everywhere: one press, the whole reference.
 */
export function pillBeforeCaret(host: Element | null | undefined, win: Window = window): HTMLElement | null {
    const sel = win.getSelection?.();
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !host) return null;
    const { anchorNode, anchorOffset } = sel as { anchorNode: Node; anchorOffset: number };
    if (!host.contains(anchorNode)) return null;

    let prev: ChildNode | null = null;
    if (anchorNode.nodeType === 3) {
        if (anchorOffset !== 0) return null;
        prev = anchorNode.previousSibling;
    } else if (anchorNode === host || host.contains(anchorNode)) {
        prev = anchorNode.childNodes[anchorOffset - 1] || null;
    }
    // Empty text nodes are our own caret parking spots — step over them.
    while (prev && prev.nodeType === 3 && prev.nodeValue === '') prev = prev.previousSibling;
    return (prev && prev.nodeType === 1 && (prev as Element).hasAttribute?.(PILL_ATTR)) ? (prev as HTMLElement) : null;
}

/**
 * The plain text between the start of the host and a collapsed caret. Feeds the
 * `{{`-and-partial-path autocomplete, which has to look at what was TYPED —
 * pills contribute nothing, since a completed reference is never a prefix of
 * the next one.
 */
export function textBeforeCaret(host: Element | null | undefined, win: Window = window): string {
    const sel = win.getSelection?.();
    if (!sel || !sel.isCollapsed || !sel.rangeCount || !host) return '';
    const { anchorNode, anchorOffset } = sel as { anchorNode: Node; anchorOffset: number };
    if (!host.contains(anchorNode) && anchorNode !== host) return '';
    if (anchorNode.nodeType === 3) return String(anchorNode.nodeValue || '').slice(0, anchorOffset);
    return '';
}

/**
 * Delete `length` characters immediately before the caret. Used to swallow the
 * partial the author typed (`{{ste`) when they accept a suggestion, so the
 * pill replaces it rather than landing after it.
 */
export function deleteBeforeCaret(host: Element | null | undefined, length: number, { win = window, range: saved = null }: { win?: Window; range?: Range | null } = {}): void {
    if (length <= 0) return;
    const sel = win.getSelection?.();
    const ambient = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
    const range = (saved && host?.contains(saved.commonAncestorContainer)) ? saved : ambient;
    if (!range || !sel) return;
    // A caret at the end of an element (which is where `collapse(false)` and a
    // fresh focus both leave it) reports the ELEMENT as its container, not the
    // text it visually sits after — so resolve to that text node first.
    let node = range.startContainer;
    let offset = range.startOffset;
    if (node.nodeType !== 3) {
        const before = node.childNodes[offset - 1];
        if (!before || before.nodeType !== 3) return;
        node = before;
        offset = (node.nodeValue as string).length;
    }
    const start = Math.max(0, offset - length);
    node.nodeValue = (node.nodeValue as string).slice(0, start) + (node.nodeValue as string).slice(offset);
    const caret = (win.document || document).createRange();
    caret.setStart(node, start);
    caret.collapse(true);
    sel.removeAllRanges();
    sel.addRange(caret);
}

/**
 * The caret position under a POINT (a drop), as a collapsed range inside
 * `host` — or null when the point is outside it, or the browser has no way
 * to say (jsdom). A point on a pill lands right after that pill: a pill is
 * atomic, nothing goes inside it.
 */
export function rangeFromPoint(host: Element | null | undefined, x: number, y: number, { doc = document }: { doc?: Document } = {}): Range | null {
    if (!host || typeof x !== 'number' || typeof y !== 'number') return null;
    let range = null;
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
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const pill = el?.closest?.(PILL_SELECTOR);
    if (pill && host.contains(pill)) {
        range = doc.createRange();
        range.setStartAfter(pill);
        range.collapse(true);
    }
    return range;
}

/** Swap one pill for `nodes` (another reference), caret after it. */
export function replacePill(host: Element | null | undefined, pill: HTMLElement | null | undefined, nodes: Node[], { win = window, doc = document }: { win?: Window; doc?: Document } = {}): void {
    if (!host || !pill || !nodes.length) return;
    let target: HTMLElement | null = pill;
    if (!host.contains(target)) {
        // The host was re-rendered in between (a label changed, a blur turned
        // typed text into pills): the same reference, by its raw text.
        const raw = pill.dataset?.raw;
        target = raw == null ? null : (Array.from(host.querySelectorAll(PILL_SELECTOR)) as HTMLElement[]).find((el: HTMLElement) => el.dataset.raw === raw) || null;
        if (!target) return;
    }
    const range = doc.createRange();
    range.selectNode(target);
    insertAtCaret(host, nodes, { range, win, doc });
}

/** The path a pill stands for — its raw text without the braces. */
export function pathOfRaw(raw: unknown): string {
    return String(raw || '').replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').trim();
}
