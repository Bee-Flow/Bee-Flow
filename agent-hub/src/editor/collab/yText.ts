/**
 * yText.ts — the inline side of the shared document: a textblock's content
 * as a list of tokens (one per UTF-16 code unit or inline atom, the editor's
 * own token model, so token offsets are editor offsets), read from and written
 * to a `Y.XmlText`, plus the stored-form signature used to compare content.
 *
 * Pure: no DOM, bundled for the server (serverEntry.ts).
 */
import * as Y from 'yjs';
import {
    type AstNode, type Attrs, INLINE_ATOMS, attrsKey, canonicalAttrs, canonicalFormat, formatToMarks, marksToFormat,
} from './ySchema';

/** Is an embed in a textblock's text part of the document (else it is skipped)? */
export function isVisibleEmbed(embed: unknown, inCode: boolean): embed is Y.XmlElement {
    if (!(embed instanceof Y.XmlElement)) return false;
    return inCode ? embed.nodeName === 'hardBreak' : INLINE_ATOMS.has(embed.nodeName);
}

/**
 * One token of a textblock: a UTF-16 code unit or an inline atom — the
 * engine's own token model, so token offsets are editor offsets.
 * `key` is the canonical format (text) or canonical attributes (atom).
 */
export interface Tok {
    ch: string | null;
    key: string;
    fmt: Attrs | null;
    atom: AstNode | null;
    /** Shared text only: the embedded element, raw attributes, and index in the Y text. */
    el?: Y.XmlElement;
    raw?: Attrs;
    yi?: number;
}

const inlineAtom = (type: string, attrs: unknown): AstNode => {
    const a = canonicalAttrs(type, attrs);
    return Object.keys(a).length ? { type, attrs: a } : { type };
};

/** Tokens of AST inline content as they are stored (canonical). */
export function astTokens(content: AstNode[] | undefined, inCode: boolean): Tok[] {
    const toks: Tok[] = [];
    for (const n of content || []) {
        if (!n) continue;
        if (n.type === 'text') {
            const fmt = marksToFormat(n.marks, inCode);
            const key = attrsKey(fmt);
            const str = typeof n.text === 'string' ? n.text : '';
            for (let i = 0; i < str.length; i++) toks.push({ ch: str[i], key, fmt, atom: null });
        } else if (inCode) {
            if (n.type === 'hardBreak') toks.push({ ch: '\n', key: '', fmt: {}, atom: null });
        } else if (INLINE_ATOMS.has(n.type)) {
            const atom = inlineAtom(n.type, n.attrs);
            toks.push({ ch: null, key: attrsKey(atom.attrs || {}), fmt: null, atom });
        }
    }
    return toks;
}

/** Visible tokens of a shared text, each with its index in the Y text. */
export function yTokens(ytext: Y.XmlText, inCode: boolean): { toks: Tok[]; length: number } {
    const toks: Tok[] = [];
    let yi = 0;
    for (const op of ytext.toDelta() as Array<{ insert: unknown; attributes?: Attrs }>) {
        const raw = op.attributes || {};
        if (typeof op.insert === 'string') {
            const fmt = canonicalFormat(raw, inCode);
            const key = attrsKey(fmt);
            for (let i = 0; i < op.insert.length; i++) toks.push({ ch: op.insert[i], key, fmt, atom: null, raw, yi: yi + i });
            yi += op.insert.length;
            continue;
        }
        if (isVisibleEmbed(op.insert, inCode)) {
            if (inCode) toks.push({ ch: '\n', key: '', fmt: {}, atom: null, raw, yi, el: op.insert });
            else {
                const atom = inlineAtom(op.insert.nodeName, op.insert.getAttributes());
                toks.push({ ch: null, key: attrsKey(atom.attrs || {}), fmt: null, atom, el: op.insert, raw, yi });
            }
        }
        yi += 1;
    }
    return { toks, length: yi };
}

/** Same character or same kind of atom (attributes may differ). */
export const sameContent = (a: Tok, b: Tok): boolean =>
    a.ch !== null ? a.ch === b.ch : b.ch === null && !!a.atom && !!b.atom && a.atom.type === b.atom.type;
/** Same content and same formatting / attributes. */
export const sameTok = (a: Tok, b: Tok): boolean => sameContent(a, b) && a.key === b.key;

/** AST inline content from tokens, merging equal-format runs. */
export function tokensToInline(toks: Tok[]): AstNode[] {
    const out: AstNode[] = [];
    let buf = '';
    let bufKey: string | null = null;
    let bufFmt: Attrs | null = null;
    const flush = () => {
        if (!buf) return;
        const marks = bufFmt ? formatToMarks(bufFmt) : [];
        out.push(marks.length ? { type: 'text', text: buf, marks } : { type: 'text', text: buf });
        buf = '';
    };
    for (const t of toks) {
        if (t.ch === null) { flush(); bufKey = null; if (t.atom) out.push(t.atom); continue; }
        if (buf && t.key !== bufKey) flush();
        buf += t.ch;
        bufKey = t.key;
        bufFmt = t.fmt;
    }
    flush();
    return out;
}

/* ── stored-form signature ──────────────────────────────────────────── */

// AST nodes are immutable, so a content array's signature never changes.
const SIGNATURES = [new WeakMap<object, string[]>(), new WeakMap<object, string[]>()];
const FORMAT_KEYS_OF = new WeakMap<object, string>();

function formatKeyOf(marks: AstNode['marks']): string {
    if (!marks || !marks.length) return '';
    let key = FORMAT_KEYS_OF.get(marks);
    if (key === undefined) {
        key = attrsKey(marksToFormat(marks, false));
        FORMAT_KEYS_OF.set(marks, key);
    }
    return key;
}

/**
 * Stored form of inline content as a list of runs: `<format>\u0001<text>`
 * (equal-format neighbours merged) and `\u0002<atom type>\u0001<attrs>`.
 * Format keys are JSON, so they never contain the separator.
 */
export function inlineSignature(content: AstNode[] | undefined, inCode: boolean): string[] {
    const list = content || [];
    const memo = SIGNATURES[inCode ? 1 : 0];
    const hit = memo.get(list);
    if (hit) return hit;
    const out: string[] = [];
    let run = '';
    let runKey: string | null = null;
    const push = () => { if (runKey !== null && run) out.push(`${runKey}\u0001${run}`); run = ''; runKey = null; };
    for (const n of list) {
        const part = signaturePart(n, inCode);
        if (!part) continue;
        if (part.atom) { push(); out.push(part.atom); continue; }
        if (runKey !== null && part.key !== runKey) push();
        run += part.str;
        runKey = part.key;
    }
    push();
    memo.set(list, out);
    return out;
}

/** What one inline node contributes: text under a format key, an atom entry, or nothing. */
function signaturePart(n: AstNode | undefined, inCode: boolean): { key: string; str: string; atom?: string } | null {
    if (!n) return null;
    if (n.type === 'text') {
        const str = typeof n.text === 'string' ? n.text : '';
        return str ? { key: inCode ? '' : formatKeyOf(n.marks), str } : null;
    }
    if (inCode) return n.type === 'hardBreak' ? { key: '', str: '\n' } : null;
    if (!INLINE_ATOMS.has(n.type)) return null;
    return { key: '', str: '', atom: `\u0002${n.type}\u0001${attrsKey(canonicalAttrs(n.type, n.attrs))}` };
}

/* ── writing ──────────────────────────────────────────────────────────── */

/** Insert tokens into a shared text at `at`: runs of equal formatting as one insert, atoms as embeds. */
export function insertTokens(ytext: Y.XmlText, at: number, toks: Tok[]): void {
    let i = 0;
    let pos = at;
    while (i < toks.length) {
        const t = toks[i];
        if (t.ch === null) {
            if (t.atom) { ytext.insertEmbed(pos, newAtomElement(t.atom), {}); pos += 1; }
            i += 1;
            continue;
        }
        let j = i;
        let str = '';
        while (j < toks.length && toks[j].ch !== null && toks[j].key === t.key) str += toks[j++].ch;
        // A fresh object every time: Yjs completes the attribute object it is given.
        ytext.insert(pos, str, { ...(t.fmt || {}) });
        pos += str.length;
        i = j;
    }
}

/** Fill an EMPTY shared text with AST inline content. */
export function fillText(ytext: Y.XmlText, content: AstNode[] | undefined, inCode: boolean): void {
    insertTokens(ytext, 0, astTokens(content, inCode));
}

/** A new element for an inline atom (attributes canonical). */
export function newAtomElement(atom: AstNode): Y.XmlElement {
    const el = new Y.XmlElement(atom.type);
    const attrs = canonicalAttrs(atom.type, atom.attrs);
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k] as string);
    return el;
}
