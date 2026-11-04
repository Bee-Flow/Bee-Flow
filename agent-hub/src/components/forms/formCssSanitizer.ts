/**
 * The client half of the custom-CSS rules for a hosted form (the server's
 * sanitizeFormCss in server/core/forms/formStyle.mts is the other half).
 *
 * The CSS is served to anonymous visitors, so the renderer runs it through this
 * AGAIN, whatever the server sent: a stale server must never ship CSS that this
 * build would refuse. What is removed (and reported):
 *
 *   • `@import`, `@font-face`, `@charset`, `@namespace`; a nested block other
 *     than `@media`, `@supports` or `@container`;
 *   • any `url(…)` whose argument is not `data:image/…` or a same-origin path
 *     ('/x', never '//x' or '/\x'), and any string that names an outside address
 *     (image-set(), src() and custom properties take bare strings): an outside
 *     address would tell that site who opens the form;
 *   • `expression(`, `behavior:`, `-moz-binding`, `javascript:`, `position: fixed`;
 *   • the sequences `</` and `<!--`, and every comment;
 *   • a selector that reaches OUT of the form (`& ~ x`, `& + x`, `~ x`), and a
 *     `}` that would close the wrapper: the renderer nests everything inside
 *     `.bf-form-scope { … }`, and an extra brace would end that scope early.
 *
 * The scan reads strings, escapes and unquoted `url(…)` the way the browser's
 * tokenizer does, because a brace inside one of those is not a brace to the
 * browser: counting it would let a real closing brace through unseen.
 *
 * Everything else is kept verbatim. The removal unit is the declaration (up to
 * `;` or `}`), or the whole block for a refused prelude. The checks read a copy
 * in which CSS escapes of letters and '-' are decoded, so `@\69mport` or
 * `u\72l(` cannot slip past; the output keeps the author's own spelling.
 */

export const FORM_CSS_MAX = 20_000;

export interface SanitizedCss {
    css: string;
    /** What was taken out, one short label per kind, in the order first met. */
    removed: string[];
}

/** Nested at-rules that may carry a block inside the scope. */
const ALLOWED_BLOCK_AT_RULES = new Set(['media', 'supports', 'container']);

/** Statement at-rules that are always removed. */
const STATEMENT_AT_RULE = /^\s*@(import|charset|namespace|font-face)\b/i;

const DECLARATION_RULES: Array<[RegExp, string]> = [
    [/expression\s*\(/i, 'expression('],
    [/behaviou?r\s*:/i, 'behavior:'],
    [/-moz-binding/i, '-moz-binding'],
    [/(?:java|vb)script\s*:/i, 'javascript:'],
    [/position\s*:\s*fixed/i, 'position: fixed'],
];

/** Decode the escapes that could spell a keyword (letters and '-'); leave every other escape alone. */
export function decodeKeywordEscapes(css: string): string {
    return css.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f0-9a-fA-F])/g, (m: string, hex: string | undefined, ch: string | undefined) => {
        let c = ch ?? '';
        if (hex) {
            const cp = parseInt(hex, 16);
            if (!cp || cp > 0x10ffff) return m;
            c = String.fromCodePoint(cp);
        }
        return /^[A-Za-z-]$/.test(c) ? c : m;
    });
}

/** Any character below U+0020 (the URL parser drops tabs and newlines, so '/\t/x' is '//x'). */
const hasControl = (s: string): boolean => [...s].some(c => c.charCodeAt(0) < 0x20);
const withoutControl = (s: string): string => [...s].filter(c => c.charCodeAt(0) >= 0x20).join('');

/** A url() argument or a string used as an address: same-origin path or an inline image only. */
function isAllowedAddress(raw: string): boolean {
    const arg = raw.trim();
    if (/^data:image\//i.test(arg)) return true;
    return /^\/(?![/\\])[^\s\\"'()]*$/.test(arg) && !hasControl(arg);
}

/** A string literal that names an outside address (or could become one once the URL parser drops whitespace). */
function isOutsideAddressString(raw: string): boolean {
    const squeezed = withoutControl(raw.replace(/\\[0-9a-fA-F]{1,6}\s?|\\./g, '')).replace(/\s/g, '');
    if (/^[/\\]{2}/.test(squeezed)) return true;
    if (/^data:image\//i.test(squeezed)) return false;
    return /^(?:https?|ftp|wss?|file|blob|filesystem|data):/i.test(squeezed);
}

/** Why a segment (declaration or prelude, escapes decoded) must go, or null when it may stay. */
export function segmentProblem(segment: string): string | null {
    const decoded = decodeKeywordEscapes(segment);
    const at = STATEMENT_AT_RULE.exec(decoded);
    if (at) return `@${at[1].toLowerCase()}`;
    for (const [re, label] of DECLARATION_RULES) if (re.test(decoded)) return label;
    const urls = decoded.matchAll(/url\s*\(\s*(?:"([^"]*)"?|'([^']*)'?|([^)]*))/gi);
    for (const m of urls) {
        if (!isAllowedAddress(m[1] ?? m[2] ?? m[3] ?? '')) return 'outside address';
    }
    for (const m of decoded.matchAll(/"((?:[^"\\\n]|\\.)*)"?|'((?:[^'\\\n]|\\.)*)'?/g)) {
        if (isOutsideAddressString(m[1] ?? m[2] ?? '')) return 'outside address';
    }
    return null;
}

/** Why a block's prelude must go (the whole block goes with it), or null. */
function preludeProblem(prelude: string): string | null {
    const decoded = decodeKeywordEscapes(prelude).trim();
    const at = /^@([\w-]+)/.exec(decoded);
    if (at && !ALLOWED_BLOCK_AT_RULES.has(at[1].toLowerCase())) return `@${at[1].toLowerCase()}`;
    if (/^[~+]/.test(decoded) || /&\s*[~+]/.test(decoded)) return 'sibling selector';
    return segmentProblem(prelude);
}

/** Comments, `</` and `<!--`, and NULs out, until nothing new forms from what was left. */
function stripUnsafeSequences(css: string, removed: Set<string>): string {
    let s = css.split('\0').join('');
    for (;;) {
        const next = s.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').replace(/<\//g, '').replace(/<!--/g, '');
        if (next === s) return s;
        if (s.includes('</')) removed.add('</');
        if (s.includes('<!--')) removed.add('<!--');
        s = next;
    }
}

/** Where a string literal that opens at `start` ends (exclusive): its quote, a raw newline, or the end. */
function stringEnd(src: string, start: number): number {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) return i + 1;
        if (c === '\n' || c === '\r' || c === '\f') return i;
        i += 1;
    }
    return src.length;
}

/** Every escape decoded: to tell whether an identifier spells `url`. */
function decodeAllEscapes(ident: string): string {
    return ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (m: string, hex: string | undefined, ch: string | undefined) => {
        if (!hex) return ch ?? '';
        const cp = parseInt(hex, 16);
        return cp && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
}

/**
 * Where an unquoted `url(` that opens at `paren` (the index of its '(') ends
 * (exclusive), or -1 when `before` does not end in the identifier `url` or the
 * argument is quoted (then it is an ordinary function with a string inside).
 */
function unquotedUrlEnd(src: string, paren: number, before: string): number {
    const ident = /(?:^|[^\w\\-])((?:[\w-]|\\[0-9a-fA-F]{1,6}\s?|\\[^\r\n\f])+)$/.exec(before);
    if (!ident || decodeAllEscapes(ident[1]).toLowerCase() !== 'url') return -1;
    let i = paren + 1;
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === '"' || src[i] === "'") return -1;
    while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === ')') return i + 1;
        i += 1;
    }
    return src.length;
}

/** The scan state: what is kept, how deep we are, and whether a refused block is being skipped. */
class Scanner {
    out = '';
    seg = '';
    depth = 0;
    /** The depth a refused block opened at; -1 when nothing is being skipped. */
    skipFrom = -1;
    readonly removed: Set<string>;
    constructor(removed: Set<string>) { this.removed = removed; }

    private keepDeclaration(): string {
        const seg = this.seg;
        this.seg = '';
        if (!seg.trim()) return seg;
        const problem = segmentProblem(seg);
        if (!problem) return seg;
        this.removed.add(problem);
        return '';
    }

    open(): void {
        const prelude = this.seg;
        this.seg = '';
        if (this.skipFrom < 0) {
            const problem = preludeProblem(prelude);
            if (problem) { this.removed.add(problem); this.skipFrom = this.depth; } else this.out += `${prelude}{`;
        }
        this.depth += 1;
    }

    semicolon(): void {
        if (this.skipFrom >= 0) { this.seg = ''; return; }
        const kept = this.keepDeclaration();
        if (kept.trim()) this.out += `${kept};`;
    }

    close(): void {
        if (this.depth === 0) {
            // A brace that would close the wrapper: the rest would run outside the form.
            this.removed.add('unbalanced }');
            const kept = this.keepDeclaration();
            if (kept.trim()) this.out += `${kept};`;
            return;
        }
        this.depth -= 1;
        if (this.skipFrom >= 0) {
            this.seg = '';
            if (this.depth === this.skipFrom) this.skipFrom = -1;
            return;
        }
        this.out += `${this.keepDeclaration()}}`;
    }

    finish(): string {
        let open = this.depth;
        if (this.skipFrom >= 0) open = this.skipFrom;
        else this.out += this.keepDeclaration();
        if (open > 0) {
            this.removed.add('unbalanced }');
            this.out += '}'.repeat(open);
        }
        return this.out;
    }
}

/** How many characters from `i` form one opaque token (escape, string, unquoted url), or 0 for a plain one. */
function opaqueLength(src: string, i: number, seg: string): number {
    const c = src[i];
    if (c === '\\') return i + 1 < src.length && !/[\r\n\f]/.test(src[i + 1]) ? 2 : 0;
    if (c === '"' || c === "'") return stringEnd(src, i) - i;
    if (c === '(') {
        const end = unquotedUrlEnd(src, i, seg);
        return end < 0 ? 0 : end - i;
    }
    return 0;
}

/** The client mirror of sanitizeFormCss: `{ css, removed }`, never throws. */
export function sanitizeFormCssClient(input: unknown): SanitizedCss {
    if (typeof input !== 'string' || !input.trim()) return { css: '', removed: [] };
    if (input.length > FORM_CSS_MAX) return { css: '', removed: [`over ${FORM_CSS_MAX} characters`] };
    const removed = new Set<string>();
    const src = stripUnsafeSequences(input, removed);
    const scan = new Scanner(removed);
    let i = 0;
    while (i < src.length) {
        const opaque = opaqueLength(src, i, scan.seg);
        if (opaque > 0) {
            scan.seg += src.slice(i, i + opaque);
            i += opaque;
            continue;
        }
        const c = src[i];
        if (c === '{') scan.open();
        else if (c === ';') scan.semicolon();
        else if (c === '}') scan.close();
        else scan.seg += c;
        i += 1;
    }
    return { css: scan.finish().trim(), removed: [...removed] };
}
