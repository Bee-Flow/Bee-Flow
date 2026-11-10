/**
 * The custom CSS of a form (`form.style.customCss`, core/forms/formStyle.mts),
 * as it may be served. The client mirror is sanitizeFormCssClient in
 * agent-hub/src/components/forms/formCssSanitizer.ts (re-exported from
 * formStyleVars.ts): keep the two in lockstep, removal labels included.
 *
 * CUSTOM CSS. It is served to anonymous visitors, so it is sanitised, never
 * trusted. The renderer wraps it in native CSS nesting on the form's root
 * element, `.bf-form-scope { <css> }`, which scopes every selector without a
 * CSS parser; @media, @supports and @container work inside. sanitizeFormCss
 * makes that wrapper safe to close (balanced braces, brackets and strings, no
 * trailing backslash) and removes, reporting each in `removed`:
 *   every at-rule but @media, @supports and @container (@import,
 *     @font-face, @charset, @namespace, @keyframes, @layer, …), its block
 *     with it;
 *   a rule whose selector reaches out of the scope through nesting
 *     (`& ~ x`, `& + x`, a relative `~ x` / `+ x`): `sibling selector`;
 *   a declaration with url()/src() whose address is not `data:image/` or a
 *     same-origin path ('/x', never '//x' or '/\x'): an external address
 *     would hand the visitor's IP to a third party;
 *   a declaration with image-set()/image()/cross-fade()/src() that takes an
 *     address from var()/attr()/env(), or names an external address in a string;
 *   a declaration with expression(, behavior:, -moz-binding or javascript:;
 *   a `position` other than static/relative/absolute/sticky (position: fixed
 *     would let the form cover the page it sits on);
 *   the sequences `</` and `<!--` (so the CSS can never end its <style>);
 *   a `}` that closes more than it opened (it would end the scope).
 * An unquoted `url(…)` is read as one token, as the browser does: a brace or
 * quote inside it is not structure.
 * Comments are stripped first, so a comment between `u` and `rl(` hides
 * nothing, and CSS escapes are decoded for the checks (`\75 rl(`,
 * `@\69mport`). Everything else is kept verbatim. Input over 20 000
 * characters is refused as a whole.
 */

export const FORM_CSS_MAX_CHARS = 20_000;

export type SanitizedCss = { css: string; removed: string[] };

/**
 * Which addresses a stylesheet may name. A form uses FORM_CSS_POLICY; another
 * surface that reuses this sanitiser (sanitizeCssWith) passes its own.
 *   allowUrl(address)        may url()/src() load this address?
 *   refuseString(address)    must a string inside image-set()/image()/cross-fade()/src() go?
 * Both get the address lower-cased, escapes decoded.
 */
export type CssAddressPolicy = { allowUrl: (address: string) => boolean; refuseString: (address: string) => boolean };

/** The only at-rules that may stay; every other one goes, its block with it. */
const ALLOWED_AT_RULES = new Set(['media', 'supports', 'container']);
const POSITION_ALLOWED = new Set(['static', 'relative', 'absolute', 'sticky', '-webkit-sticky', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const SNIPPET_MAX = 80;
const MAX_PASSES = 8;

const isNewline = (c: string): boolean => c === '\n' || c === '\r' || c === '\f';
const isHex = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);

const URL_IDENT_WINDOW = 40;
const URL_IDENT_AT_END = /((?:[a-zA-Z0-9_-]|\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\n\r\f0-9a-fA-F])+)$/;

/**
 * Is the identifier that starts at `at` only the tail of a longer token? After `#` it is a
 * hash, after `@` an at-keyword, and a character outside ASCII is part of the name itself:
 * the browser then reads `(` as an ordinary bracket, with strings inside, not as url(.
 */
function continuesAName(before: string, at: number): boolean {
    if (at === 0) return false;
    const prev = before[at - 1];
    return prev === '#' || prev === '@' || prev.charCodeAt(0) >= 0x80;
}

/**
 * The text as the browser's tokenizer sees it: one kind of newline (so a backslash before
 * CR LF continues a string, as it does there) and no NUL.
 */
function preprocess(css: string): string {
    return css.split('\r\n').join('\n').split('\r').join('\n').split('\f').join('\n').split('\0').join('\ufffd');
}

/**
 * Where an UNQUOTED `url(` whose '(' is at `paren` ends (exclusive), or null
 * when `before` does not end in the identifier url (escapes decoded) or the
 * argument is quoted. The browser reads `url(/x)` as ONE token up to its `)`:
 * a brace, quote or comment inside is not one, so the scan must not count it.
 * `closed` is false when the input ends first (a lone backslash at the very
 * end is left out: it would escape the `)` that closes the token).
 */
function unquotedUrl(css: string, paren: number, before: string): { end: number; closed: boolean } | null {
    // Only the end of `before` is read: `url` spelled with escapes is at most 24 characters, and a
    // longer name is not `url`. Reading all of it for every bracket would cost its length squared.
    const tail = before.length > URL_IDENT_WINDOW ? before.slice(-URL_IDENT_WINDOW) : before;
    const ident = URL_IDENT_AT_END.exec(tail);
    if (!ident || decodeForCheck(ident[1]).decoded.toLowerCase() !== 'url') return null;
    if (continuesAName(tail, ident.index)) return null;
    let i = paren + 1;
    while (i < css.length && /[ \t\n\r\f]/.test(css[i])) i += 1;
    if (css[i] === '"' || css[i] === "'") return null;
    for (; i < css.length; i++) {
        if (css[i] === '\\') {
            if (i + 1 >= css.length) return { end: i, closed: false };
            i += 1;
            continue;
        }
        if (css[i] === ')') return { end: i + 1, closed: true };
    }
    return { end: css.length, closed: false };
}

/** Remove `</` and `<!--` until none is left (removing one can form another). */
function removeSequences(css: string, removed: Set<string>): string {
    let out = css;
    for (;;) {
        const next = out.replace(/<!--/g, () => { removed.add('<!--'); return ''; })
            .replace(/<\//g, () => { removed.add('</'); return ''; });
        if (next === out) return out;
        out = next;
    }
}

/** Strip comments outside strings; an unterminated comment runs to the end. */
function stripComments(css: string): string {
    let out = '';
    let quote = '';
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (quote) {
            out += c;
            if (c === '\\' && i + 1 < css.length) { out += css[++i]; continue; }
            if (c === quote || isNewline(c)) quote = '';
            continue;
        }
        if (c === '\\' && i + 1 < css.length) { out += c + css[++i]; continue; }
        if (c === '"' || c === "'") { quote = c; out += c; continue; }
        const url = c === '(' ? unquotedUrl(css, i, out) : null;
        if (url) { out += css.slice(i, url.end); i = url.end - 1; continue; }
        if (c === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2);
            if (end === -1) break;
            i = end + 1;
            continue;
        }
        out += c;
    }
    return out;
}

/**
 * Decode CSS escapes for the checks (`\75` → `u`, `\@` → `@`), and collect the
 * decoded content of every string token. Never used as output.
 */
function decodeForCheck(text: string): { decoded: string; strings: string[] } {
    let decoded = '';
    const strings: string[] = [];
    let quote = '';
    let current = '';
    const emit = (s: string): void => { decoded += s; if (quote) current += s; };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') {
            const next = text[i + 1];
            if (next === undefined) break;
            if (isNewline(next)) { i += next === '\r' && text[i + 2] === '\n' ? 2 : 1; continue; }
            if (isHex(next)) {
                let hex = '';
                let j = i + 1;
                while (j < text.length && hex.length < 6 && isHex(text[j])) hex += text[j++];
                if (text[j] === '\r' && text[j + 1] === '\n') j += 2;
                else if (text[j] === ' ' || text[j] === '\t' || isNewline(text[j] ?? '')) j += 1;
                const cp = parseInt(hex, 16);
                emit(cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp));
                i = j - 1;
                continue;
            }
            emit(next);
            i += 1;
            continue;
        }
        if (quote) {
            if (c === quote || isNewline(c)) { strings.push(current); current = ''; quote = ''; decoded += c; continue; }
            emit(c);
            continue;
        }
        if (c === '"' || c === "'") { quote = c; current = ''; decoded += c; continue; }
        decoded += c;
    }
    if (quote) strings.push(current);
    return { decoded, strings };
}

/** The address a url()/src() argument or a string names, as a browser would read it. */
function addressOf(raw: string): string {
    let s = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
    const q = s[0];
    if (q === '"' || q === "'") {
        const end = s.indexOf(q, 1);
        s = (end === -1 ? s.slice(1) : s.slice(1, end)).replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
    }
    return s;
}

/** url()/src(): only an image as data, or a path on this server. */
function isAllowedUrl(address: string): boolean {
    const a = address.toLowerCase();
    if (a.startsWith('data:image/')) return true;
    return a.startsWith('/') && a[1] !== '/' && a[1] !== '\\';
}

/** A string in image-set() and friends: anything that names another host or a scheme. */
function looksExternal(address: string): boolean {
    const a = address.toLowerCase();
    if (a.startsWith('data:image/')) return false;
    return a.startsWith('//') || a.startsWith('/\\') || a.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/.test(a);
}

const snippet = (s: string): string => (s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX)}…` : s);

function urlFindings(decoded: string, policy: CssAddressPolicy): string | null {
    const re = /(?:^|[^a-z0-9_-])(url|src)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(decoded)) !== null) {
        const start = m.index + m[0].length;
        const close = decoded.indexOf(')', start);
        const arg = decoded.slice(start, close === -1 ? decoded.length : close);
        if (!policy.allowUrl(addressOf(arg))) return 'outside address';
    }
    return null;
}

function imageFunctionFindings(decoded: string, strings: string[], policy: CssAddressPolicy): string | null {
    const fn = /(?:^|[^a-z0-9_-])(-webkit-image-set|image-set|image|-webkit-cross-fade|cross-fade|src)\(/.exec(decoded);
    if (!fn) return null;
    if (/(?:^|[^a-z0-9_-])(var|attr|env)\(/.test(decoded)) return 'address from var()';
    return strings.map(addressOf).some(policy.refuseString) ? 'outside address' : null;
}

function positionFinding(decoded: string): string | null {
    const m = /^\s*position\s*:([\s\S]*)$/.exec(decoded);
    if (!m) return null;
    const value = m[1].replace(/!\s*important\s*$/, '').trim();
    return POSITION_ALLOWED.has(value) ? null : `position: ${snippet(value)}`;
}

/**
 * A rule prelude that reaches OUT of the scope through native nesting:
 * `& ~ x`, `& + x`, or a relative `~ x` / `+ x` (which nesting reads as
 * `& ~ x`), anywhere in its selector list.
 */
function siblingFinding(prelude: string): string | null {
    const decoded = decodeForCheck(prelude).decoded;
    if (/^\s*@/.test(decoded)) return null;
    return /(?:^|,)\s*[~+]/.test(decoded) || /&\s*[~+]/.test(decoded) ? 'sibling selector' : null;
}

/** Why a piece (a declaration, a rule prelude or an at-rule) must go, or null. */
function findingOf(text: string, policy: CssAddressPolicy): string | null {
    const { decoded: raw, strings } = decodeForCheck(text);
    const decoded = raw.toLowerCase();
    const at = /^\s*@([a-z0-9_-]+)/.exec(decoded);
    if (at && !ALLOWED_AT_RULES.has(at[1])) return `@${at[1]}`;
    if (/expression\s*\(/.test(decoded)) return 'expression(';
    if (/^\s*behavior\s*:/.test(decoded)) return 'behavior:';
    if (decoded.includes('-moz-binding')) return '-moz-binding';
    if (/(?:java|vb)script:/.test(decoded.replace(/[\t\n\r]/g, ''))) return 'javascript:';
    return urlFindings(decoded, policy)
        ?? imageFunctionFindings(decoded, strings.map((s) => s.toLowerCase()), policy)
        ?? positionFinding(decoded);
}

type Piece = { text: string; delim: '{' | '}' | ';' | ''; bracesInBrackets: boolean };

/**
 * Split comment-free CSS at the `{`, `}` and `;` that are outside strings and
 * brackets. Escapes are kept whole; an unterminated string or bracket at the
 * end is closed, a trailing lone backslash dropped.
 */
function splitPieces(css: string): Piece[] {
    const pieces: Piece[] = [];
    let text = '';
    let quote = '';
    let brackets = 0;
    let bracesInBrackets = false;
    for (let i = 0; i < css.length; i++) {
        const c = css[i];
        if (c === '\\') {
            const next = css[i + 1];
            if (next === undefined) break; // a trailing backslash would escape the wrapper's brace
            if (quote || !isNewline(next)) { text += c + next; i += 1; continue; }
            text += c;
            continue;
        }
        if (quote) {
            text += c;
            if (c === quote || isNewline(c)) quote = '';
            continue;
        }
        if (c === '"' || c === "'") { quote = c; text += c; continue; }
        const url = c === '(' ? unquotedUrl(css, i, text) : null;
        if (url) { text += css.slice(i, url.end) + (url.closed ? '' : ')'); i = url.end - 1; continue; }
        if (c === '(' || c === '[') { brackets += 1; text += c; continue; }
        if ((c === ')' || c === ']') && brackets > 0) { brackets -= 1; text += c; continue; }
        if (c === '{' || c === '}' || c === ';') {
            if (brackets > 0) { if (c !== ';') bracesInBrackets = true; text += c; continue; }
            pieces.push({ text, delim: c, bracesInBrackets });
            text = '';
            bracesInBrackets = false;
            continue;
        }
        text += c;
    }
    if (quote) text += quote;
    if (brackets > 0) text += ')'.repeat(brackets);
    pieces.push({ text, delim: '', bracesInBrackets });
    return pieces;
}

/** One pass: drop the pieces that must go, keep the rest verbatim, balance the braces. */
function sanitizePass(input: string, removed: Set<string>, policy: CssAddressPolicy): string {
    const css = stripComments(removeSequences(input, removed));
    let out = '';
    let depth = 0;
    let dropTo: number | null = null;
    for (const piece of splitPieces(css)) {
        if (dropTo !== null) {
            if (piece.delim === '{') depth += 1;
            else if (piece.delim === '}') { depth -= 1; if (depth === dropTo) dropTo = null; }
            continue;
        }
        const finding = piece.bracesInBrackets ? 'braces inside brackets'
            : (piece.delim === '{' ? siblingFinding(piece.text) : null) ?? findingOf(piece.text, policy);
        if (finding) removed.add(finding);
        switch (piece.delim) {
            case '{':
                if (finding) { dropTo = depth; } else { out += `${piece.text}{`; }
                depth += 1;
                break;
            case '}':
                if (!finding) out += piece.text;
                if (depth === 0) { removed.add('unbalanced }'); out += ' '; break; }
                out += '}';
                depth -= 1;
                break;
            case ';':
                if (!finding) out += `${piece.text};`;
                break;
            default:
                if (!finding) out += piece.text;
        }
    }
    if (dropTo !== null) depth = dropTo;
    return out + '}'.repeat(depth);
}

/**
 * The custom CSS as it may be served: see the module comment for what goes.
 * `removed` names each kind of removal once, in a short neutral form the
 * editor can show as is (`@import`, `outside address`, `sibling selector`,
 * `position: fixed`, `</`, `unbalanced }`, `over 20000 characters`). The
 * labels the client mirror also uses are the same words.
 */
export function sanitizeFormCss(input: unknown): SanitizedCss {
    return sanitizeCssWith(input, FORM_CSS_POLICY);
}

/** What a form may name: an image as data, or a path on this server. */
export const FORM_CSS_POLICY: CssAddressPolicy = Object.freeze({ allowUrl: isAllowedUrl, refuseString: looksExternal });

/** sanitizeFormCss with the address rules of `policy`; everything else is the same. */
export function sanitizeCssWith(input: unknown, policy: CssAddressPolicy): SanitizedCss {
    if (typeof input !== 'string' || !input) return { css: '', removed: [] };
    if (input.length > FORM_CSS_MAX_CHARS) return { css: '', removed: [`over ${FORM_CSS_MAX_CHARS} characters`] };
    const removed = new Set<string>();
    let css = preprocess(input);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const next = sanitizePass(css, removed, policy);
        if (next === css) return { css, removed: [...removed] };
        css = next;
    }
    // Still changing after every pass: something is built to defeat the
    // rules. Serve nothing rather than the last attempt.
    removed.add('unstable');
    return { css: '', removed: [...removed] };
}
