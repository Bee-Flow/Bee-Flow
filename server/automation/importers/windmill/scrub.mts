/**
 * Hard-coded secrets out of imported Windmill sources, before a source ends
 * up in a note step, the AI checklist, a code step or the report (PLAN B2
 * scrub.mts, B8). Every hit becomes `«secret removed»` and is counted, so the
 * report can say how many were taken out without saying what they were.
 *
 * Three passes:
 *   1. the secret SHAPES the product already masks in run logs
 *      (stores/automationStore/runLogRedaction.js: PEM keys, Bearer/Basic
 *      values, sk-/ghp_/xox* tokens, AWS keys, JWTs), over the whole text;
 *   2. a quoted literal assigned to a sensitive name (`token = "…"`,
 *      `password: '…'`, `apiKey = \`…\``), whatever it looks like;
 *   3. a quoted literal that looks like a generated token: long, no spaces or
 *      path characters, high character entropy.
 *
 * The literal scanner is a small hand-written lexer (quotes and escapes, not a
 * regular expression over the uploaded text). It is deliberately
 * language-agnostic: JavaScript, TypeScript, Python and shell all quote the
 * same way for the purpose of finding a string.
 *
 * The structural scrub of a finished definition (approver seats, connection
 * ids) is core/packaging/scrub.js; convert.mts runs that one on the result.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { SECRET_PATTERNS } = nodeRequire('../../../stores/automationStore/runLogRedaction') as {
    SECRET_PATTERNS: Array<{ re: RegExp }>;
};

export const SECRET_REMOVED = '«secret removed»';

const SENSITIVE_NAMES = ['token', 'secret', 'password', 'passwd', 'apikey', 'api_key', 'api-key', 'authorization', 'private_key', 'privatekey', 'client_secret', 'access_key'];
const MIN_TOKEN_LENGTH = 24;
const MIN_TOKEN_ENTROPY = 3.8;

export interface ScrubResult {
    text: string;
    removed: number;
}

/** Remove what looks like a secret from a source text. */
export function scrubSource(source: string): ScrubResult {
    let removed = 0;
    let text = source;
    for (const p of SECRET_PATTERNS) {
        const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : `${p.re.flags}g`);
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the fixed secret shapes of runLogRedaction, the same ones the run log masks
        text = text.replace(re, () => { removed += 1; return SECRET_REMOVED; });
    }
    const pieces: string[] = [];
    let last = 0;
    for (const lit of literals(text)) {
        if (!shouldRemove(text, lit)) continue;
        pieces.push(text.slice(last, lit.start), SECRET_REMOVED);
        last = lit.end;
        removed += 1;
    }
    pieces.push(text.slice(last));
    return { text: pieces.join(''), removed };
}

/** Scrub every string inside a JSON-shaped value (a static input, a mock value). */
export function scrubValue(value: unknown, counter: { removed: number }, depth = 0): unknown {
    if (depth > 32) return null;
    if (typeof value === 'string') {
        if (looksLikeToken(value)) { counter.removed += 1; return SECRET_REMOVED; }
        const r = scrubSource(value);
        counter.removed += r.removed;
        return r.text;
    }
    if (Array.isArray(value)) return value.map((v) => scrubValue(v, counter, depth + 1));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            if (isSensitiveName(k) && typeof v === 'string' && v.length >= 4 && v !== SECRET_REMOVED) {
                counter.removed += 1;
                out[k] = SECRET_REMOVED;
            } else out[k] = scrubValue(v, counter, depth + 1);
        }
        return out;
    }
    return value;
}

interface Literal { start: number; end: number; body: string }

/** Every quoted literal (start/end include the quotes). */
function literals(text: string): Literal[] {
    const out: Literal[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === '\'' || ch === '`') {
            const end = closingQuote(text, i);
            if (end === -1) { i += 1; continue; }
            out.push({ start: i, end: end + 1, body: text.slice(i + 1, end) });
            i = end + 1;
        } else i += 1;
    }
    return out;
}

function closingQuote(text: string, open: number): number {
    const q = text[open];
    for (let i = open + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === q) return i;
        if (ch === '\n' && q !== '`') return -1;
    }
    return -1;
}

function shouldRemove(text: string, lit: Literal): boolean {
    if (lit.body === SECRET_REMOVED || lit.body.length < 4) return false;
    if (lit.body.includes('${')) return false;
    if (assignedToSensitiveName(text, lit.start)) return true;
    return looksLikeToken(lit.body);
}

/** True when the text right before a literal is `<sensitive name> =` or `<sensitive name>:`. */
function assignedToSensitiveName(text: string, at: number): boolean {
    let i = skipBack(text, at - 1, ' \t');
    if (i < 0 || (text[i] !== '=' && text[i] !== ':')) return false;
    if (text[i] === '=' && i > 0 && (text[i - 1] === '=' || text[i - 1] === '!')) return false;
    i = skipBack(text, i - 1, ' \t"\'');
    let start = i;
    while (start >= 0 && isNameChar(text[start])) start -= 1;
    return isSensitiveName(text.slice(start + 1, i + 1));
}

function skipBack(text: string, from: number, chars: string): number {
    let i = from;
    while (i >= 0 && chars.includes(text[i])) i -= 1;
    return i;
}

function isNameChar(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-' || ch === '.';
}

export function isSensitiveName(name: string): boolean {
    const lower = name.toLowerCase();
    if (!lower) return false;
    if (lower.endsWith('id') || lower.endsWith('name') || lower.endsWith('type') || lower.endsWith('url')) return false;
    return SENSITIVE_NAMES.some((s) => lower.endsWith(s) || lower === s);
}

/** A long, space-free, high-entropy string: the shape of a generated key. */
export function looksLikeToken(s: string): boolean {
    if (s.length < MIN_TOKEN_LENGTH || s.length > 4096) return false;
    for (const ch of s) if (' /.:\n@{,'.includes(ch)) return false;
    return hasLetterAndDigit(s) && entropy(s) >= MIN_TOKEN_ENTROPY;
}

function hasLetterAndDigit(s: string): boolean {
    let letters = false;
    let digits = false;
    for (const ch of s) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) letters = true;
        else if (ch >= '0' && ch <= '9') digits = true;
    }
    return letters && digits;
}

function entropy(s: string): number {
    const counts = new Map<string, number>();
    for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let h = 0;
    for (const c of counts.values()) {
        const p = c / s.length;
        h -= p * Math.log2(p);
    }
    return h;
}
