/**
 * Value paths — the ONE grammar for addressing a value inside a step's
 * output, shared by the automation runtime (server/automation/bind.js), the
 * expression engine (engine.mjs), the builder (agent-hub, through the
 * generated mirror) and the phone (mobile vendor copy).
 *
 * Before this file there were four: bind.js (REF_RE + a tokenizer that split
 * on the first `]` and knew no escapes), the engine (ASCII identifiers,
 * JSON-ish string escapes), the builder's lax preview walker, and the AI
 * builder's canonicaliser (which rewrote `[0]` to `.0`). A key such as
 * `content-type`, `@odata.nextLink`, `Story Points` or `a"b` worked on one
 * side and not on the other, so a preview showed a value the run never got.
 *
 *   path      := head ( '.' name | '[' bracket ']' )*
 *   head      := name
 *   name      := one or more letters, digits, marks, `_`, `$`, `@` or `-`
 *                (unicode letters included; `.0` reads as key "0")
 *   bracket   := '*'                    every element (see walkTokens)
 *              | '-'? digits            index; negative counts from the end
 *              | '"' chars '"'          a key, JSON string escapes
 *              | "'" chars "'"          a key, the same escapes
 *              | key '=' literal        the FIRST element of a list whose
 *                                       `key` equals the literal: headers[name="Subject"].value
 *                                       (key: a name or a quoted key; literal:
 *                                       a quoted string, a number, true/false/null)
 *
 * This is a SUPERSET of the old REF_RE, so every saved path keeps its
 * meaning. The canonical writer (`formatKey` / `appendKey`) emits only the
 * old, narrow form: `.ident` for an ASCII identifier that is not a reserved
 * word of the expression language, `[n]` for an index, `["…"]` (JSON
 * escaped) for anything else. What it writes is therefore also a valid
 * expression and survives every `{{ }}` scanner below.
 *
 * Dependency-free and isomorphic: the server requires it (require(esm)),
 * agent-hub imports the mirror, mobile vendors it byte for byte.
 */

// ── Segments ─────────────────────────────────────────────────────────────

// What a key may look like WITHOUT brackets when we WRITE a path: an ASCII
// identifier the expression engine also reads as a plain name.
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(['true', 'false', 'null']);

// What a dotted segment may contain when we READ a path. Wider than what we
// write: unicode letters (`prénom`, `名前`), digits (`items.0`, the shape
// older AI-built paths have), `@` and `-` (`content-type`) all resolve.
const NAME_CHAR_RE = /[\p{L}\p{N}\p{M}_$@-]/u;

/** True for a key that can be written as `.key` (and read back by every parser). */
export function isIdentifierKey(key) {
    return typeof key === 'string' && IDENT_RE.test(key) && !RESERVED.has(key);
}

/** JSON-escape a key for use inside `["…"]`. */
function quoteKey(key) {
    return JSON.stringify(String(key));
}

/**
 * The canonical segment for ONE key: `.name`, `[3]` or `["odd key"]`.
 * A number (or an all-digits string) that is a safe integer becomes an index
 * segment: `[0]` resolves both an array element and an object key "0".
 * Larger digit keys (snowflake ids: `"1234567890123456789"`) stay quoted: as
 * a number they would be rounded and name a different key.
 */
export function formatKey(key) {
    if (typeof key === 'number' && Number.isSafeInteger(key)) return `[${key}]`;
    const k = String(key);
    if (/^(0|[1-9][0-9]*)$/.test(k) && Number.isSafeInteger(Number(k))) return `[${k}]`;
    return isIdentifierKey(k) ? `.${k}` : `[${quoteKey(k)}]`;
}

/**
 * Append one key to a path. An empty prefix yields a ROOT segment, so a bare
 * identifier stays bare (`name`, not `.name`) and anything else is bracketed
 * (`["content-type"]`), which is what the relative-path dialect wants.
 */
export function appendKey(prefix, key) {
    const seg = formatKey(key);
    if (prefix) return `${prefix}${seg}`;
    return seg.startsWith('.') ? seg.slice(1) : seg;
}

/** Append `[*]` (every element). */
export function appendWildcard(prefix) {
    return `${prefix || ''}[*]`;
}

/**
 * Append a match segment: the first element of the list whose `key` equals
 * `value` — `appendMatch('payload.headers', 'name', 'Subject')` gives
 * `payload.headers[name="Subject"]`. For lists of name/value pairs (mail
 * headers, tags, custom attributes), where the thing a person wants is "the
 * Subject header", not "header number 4".
 */
export function appendMatch(prefix, key, value) {
    const k = isIdentifierKey(String(key)) ? String(key) : quoteKey(key);
    const v = value === null || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(String(value));
    return `${prefix || ''}[${k}=${v}]`;
}

/** Tokens back to the canonical path string. */
export function formatPath(tokens) {
    let out = '';
    for (const t of tokens || []) {
        if (t.type === 'wild') out = appendWildcard(out);
        else if (t.type === 'match') out = appendMatch(out, t.key, t.value);
        else if (t.raw) out = `${out}[${t.raw}]`;
        else out = appendKey(out, t.key);
    }
    return out;
}

// ── Reading ──────────────────────────────────────────────────────────────

const ESCAPES = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * Read a quoted key starting at `src[i]` (the opening quote). Returns
 * `{ key, end }` with `end` just past the closing quote, or null.
 * JSON escapes plus `\'`; an unknown escape keeps the character after the
 * backslash (the expression engine's rule), so `\]` and `\}` are harmless.
 */
function readQuoted(src, i) {
    const q = src[i];
    let out = '';
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === q) return { key: out, end: j + 1 };
        if (c === '\\') {
            const n = src[j + 1];
            if (n === undefined) return null;
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored fixed count of one class, on a 4-character slice: linear
            if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) {
                out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
                j += 6;
                continue;
            }
            out += Object.prototype.hasOwnProperty.call(ESCAPES, n) ? ESCAPES[n] : n;
            j += 2;
            continue;
        }
        out += c;
        j++;
    }
    return null;
}

/**
 * The reading every saved path had before escapes: the text up to the next
 * quote of the same kind, verbatim, closed by `]`. Only returned when that
 * text holds a backslash, i.e. when it can differ from readQuoted.
 */
function readLegacyQuoted(src, i) {
    const q = src[i];
    const close = src.indexOf(q, i + 1);
    if (close < 0 || src[close + 1] !== ']') return null;
    const text = src.slice(i + 1, close);
    return text.includes('\\') ? { key: text, end: close + 1 } : null;
}

/** A literal after `=` in a match segment: "text", 'text', a number, true/false/null. */
function readLiteral(src, i) {
    if (src[i] === '"' || src[i] === "'") {
        const q = readQuoted(src, i);
        return q ? { value: q.key, end: q.end } : null;
    }
    const num = /^-?[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i));
    if (num) return { value: Number(num[0]), end: i + num[0].length };
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NAME_CHAR_RE is a single character class, tested on one character: linear
        if (src.startsWith(word, i) && !NAME_CHAR_RE.test(src[i + word.length] || '')) return { value, end: i + word.length };
    }
    return null;
}

/**
 * Read one path starting at `src[start]`. Returns `{ tokens, end }` for the
 * LONGEST valid path there (`end` is where it stops), or null when not even
 * a head name is there. Used by `parsePath` (which demands the whole string)
 * and by scanners that find paths inside larger text.
 */
export function readPath(src, start = 0) {
    if (typeof src !== 'string') return null;
    const tokens = [];
    let i = start;
    const readName = () => {
        let j = i;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NAME_CHAR_RE is a single character class, tested on one character: linear
        while (j < src.length && NAME_CHAR_RE.test(src[j])) j++;
        if (j === i) return null;
        const name = src.slice(i, j);
        i = j;
        return name;
    };
    const head = readName();
    if (head === null) return null;
    tokens.push({ type: 'prop', key: head });
    let end = i;
    while (i < src.length) {
        const c = src[i];
        if (c === '.') {
            i++;
            const name = readName();
            if (name === null) break;
            tokens.push({ type: 'prop', key: name });
            end = i;
            continue;
        }
        if (c === '[') {
            let j = i + 1;
            while (src[j] === ' ') j++;
            let tok = null;
            if (src[j] === '*') {
                tok = { type: 'wild' };
                j++;
            } else if (src[j] === '"' || src[j] === "'") {
                const q = readQuoted(src, j);
                const legacy = readLegacyQuoted(src, j);
                if (q && (!legacy || legacy.end === q.end)) {
                    tok = { type: 'prop', key: q.key };
                    // Same span, different key: a saved path from before
                    // escapes existed (`["domain\user"]`). Keep both readings
                    // and the spelling, so it still resolves and re-saves as is.
                    if (legacy && legacy.key !== q.key) { tok.alt = legacy.key; tok.raw = src.slice(j, q.end); }
                    j = q.end;
                } else if (legacy) {
                    // Only the old verbatim reading closes here (`["x\"]`).
                    tok = { type: 'prop', key: legacy.key, raw: src.slice(j, legacy.end) };
                    j = legacy.end;
                } else if (q) {
                    tok = { type: 'prop', key: q.key };
                    j = q.end;
                }
            } else {
                const m = /^-?[0-9]+(?![\p{L}_$@])/u.exec(src.slice(j));
                if (m) {
                    // Beyond the safe integer range the digits are a KEY (a
                    // snowflake id); parseInt would round them to another key.
                    const n = parseInt(m[0], 10);
                    tok = { type: 'prop', key: Number.isSafeInteger(n) ? n : m[0] };
                    j += m[0].length;
                }
                else {
                    let k = j;
                    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- NAME_CHAR_RE is a single character class, tested on one character: linear
                    while (k < src.length && NAME_CHAR_RE.test(src[k])) k++;
                    if (k > j) { tok = { type: 'prop', key: src.slice(j, k), bare: true }; j = k; }
                }
            }
            while (src[j] === ' ') j++;
            // `[key=literal]` — a match segment (see appendMatch).
            if (tok && tok.type === 'prop' && src[j] === '=' && src[j + 1] !== '=') {
                j++;
                while (src[j] === ' ') j++;
                const lit = readLiteral(src, j);
                tok = lit ? { type: 'match', key: String(tok.key), value: lit.value } : null;
                if (lit) j = lit.end;
                while (src[j] === ' ') j++;
            } else if (tok && tok.bare) {
                tok = null;      // `[name]` without `=` is not a path
            }
            if (!tok || src[j] !== ']') break;
            tokens.push(tok);
            i = j + 1;
            end = i;
            continue;
        }
        break;
    }
    return { tokens, end };
}

/**
 * Parse a whole path string into tokens, or null when it is not a path.
 * Surrounding whitespace is ignored. Tokens:
 *   { type: 'prop', key: string|number }  — a key or an index
 *   { type: 'wild' }                      — `[*]`
 *   { type: 'match', key, value }         — `[key="value"]`
 */
export function parsePath(path) {
    if (typeof path !== 'string') return null;
    const p = path.trim();
    if (!p) return null;
    const r = readPath(p, 0);
    if (r && r.end === p.length) return r.tokens;
    // A path copied out of a JSON string keeps its escapes (`h[name=\"S\"]`):
    // read it once more with them undone.
    if (p.includes('\\"')) {
        const u = p.replace(/\\"/g, '"');
        const r2 = readPath(u, 0);
        if (r2 && r2.end === u.length) return r2.tokens;
    }
    return null;
}

/** True when `path` is a complete, valid path. */
export function isValidPath(path) {
    return parsePath(path) !== null;
}

/** Rewrite any accepted path into its canonical spelling (null when invalid). */
export function canonicalPath(path) {
    const t = parsePath(path);
    return t ? formatPath(t) : null;
}

// What a token reads as in a list of keys: the key, '*', or for a match
// segment the value it picks (`[name="Subject"]` reads as "Subject").
function keyOfToken(x) {
    if (x.type === 'wild') return '*';
    if (x.type === 'match') return x.value === null ? 'null' : x.value;
    return x.key;
}

/** The keys of a path as plain values (`['steps', 'a', 'output', 'items', '*', 0]`); null when invalid. */
export function pathKeys(path) {
    const t = parsePath(path);
    return t ? t.map(keyOfToken) : null;
}

/** Split into parent path + last segment: `a.b["c d"]` → { parent: 'a.b', last: 'c d' }. */
export function splitLast(path) {
    const t = parsePath(path);
    if (!t || !t.length) return null;
    const last = t[t.length - 1];
    return { parent: formatPath(t.slice(0, -1)), last: keyOfToken(last), lastToken: last };
}

// ── JSON text ────────────────────────────────────────────────────────────

const JSON_TEXT_MAX_CHARS = 8 * 1024 * 1024;
const EXTRACT_MAX_CHARS = 1024 * 1024;
const EXTRACT_SCAN_BUDGET = 2_000_000;
const EXTRACT_MAX_PARSES = 32;

// Parsed JSON text is cached PER RUN (keyed on the root's `steps` object, or
// the root itself when it has none: one preview sample):
// a template that reads `body.a` and `body.b` parses `body` once, and the
// cache dies with the root. Never module-wide: the parsed object is handed
// out by reference, so a cache shared across runs would let one run's
// mutation reach another run that happens to carry the same text.
const ROOT_CACHES = new WeakMap();
const ROOT_CACHE_MAX = 16;
const MIN_CACHED_CHARS = 256;

/** The JSON-text cache for one root (null for a non-object). For walkers outside this file. */
export function jsonCacheFor(root) {
    return cacheFor(root);
}

function cacheFor(root) {
    if (root === null || typeof root !== 'object') return null;
    // A run state is copied for every binding (`{...runState, secrets: {}}`)
    // and every item scope (`{...runState, loop}`); all copies share the run's
    // `steps` object, so that is the key: one parse per body per run.
    const steps = hasOwn(root, 'steps') ? root.steps : undefined;
    const key = steps !== null && typeof steps === 'object' ? steps : root;
    let c = ROOT_CACHES.get(key);
    if (!c) { c = new Map(); ROOT_CACHES.set(key, c); }
    return c;
}

/** `[A-Za-z0-9_-]`: a character of a fence's language tag (```json). */
function isFenceTagChar(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
        || code === 95 || code === 45;
}

/**
 * The inside of a ``` fence that wraps ALL of `s` (already trimmed), or null.
 * The same reading as /^```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?```\s*$/,
 * written out by hand: that regex backtracked quadratically on a fence that
 * never closes ("```" + a few MB of letters or spaces), and this text can be
 * any HTTP body or AI answer of up to JSON_TEXT_MAX_CHARS. One pass, no regex.
 */
function fenceBody(s) {
    if (s.length < 6 || !s.startsWith('```') || !s.endsWith('```')) return null;
    let start = 3;
    while (isFenceTagChar(s.charCodeAt(start))) start++;
    while (s[start] === ' ' || s[start] === '\t') start++;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    let end = s.length - 3;
    if (end > start && s[end - 1] === '\n') end--;
    if (end > start && s[end - 1] === '\r') end--;
    return s.slice(start, end);
}

/**
 * A string that IS a JSON object or array (optionally inside a ```json
 * fence, as language models answer, or encoded twice) → the parsed value;
 * anything else → undefined. Deliberately strict about where the JSON
 * starts: prose that merely contains braces is not JSON text. `cache` (a Map,
 * optional) remembers results for one root; see cacheFor.
 */
export function parseJsonText(value, cache = null) {
    if (typeof value !== 'string' || value.length < 2 || value.length > JSON_TEXT_MAX_CHARS) return undefined;
    const cacheable = cache && value.length >= MIN_CACHED_CHARS;
    if (cacheable && cache.has(value)) return cache.get(value);
    let s = value.trim();
    const fence = fenceBody(s);
    if (fence !== null) s = fence.trim();
    let out;
    for (let depth = 0; depth < 2 && out === undefined; depth++) {
        const first = s[0];
        if (first === '{' || first === '[') {
            try {
                const v = JSON.parse(s);
                if (v !== null && typeof v === 'object') out = v;
            } catch { /* not JSON */ }
            break;
        }
        // Double-encoded: "\"{\\\"a\\\":1}\"" — one more round.
        if (first === '"') {
            try {
                const inner = JSON.parse(s);
                if (typeof inner !== 'string') break;
                s = inner.trim();
                continue;
            } catch { break; }
        }
        break;
    }
    if (cacheable) {
        if (cache.size >= ROOT_CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(value, out);
    }
    return out;
}

/**
 * Find JSON inside free text the way a person would: the whole text, a
 * fenced block anywhere, or ONE block in prose ("Here is the JSON: {…}").
 * For the parse step and parseJson(), which read what a model wrote; the
 * path walker stays strict (parseJsonText).
 *
 * The prose scan must not turn an error into data: a parse that finds
 * nothing fails the step (its on_error branch runs) and parseJson() gives
 * null, which is what a condition guarding on it relies on. So:
 *   - markup (text starting with `<`, an HTML error page) is not prose;
 *   - the scan stops at the FIRST block that closes and parses, and takes
 *     it only when it looks like an answer: a non-empty record, or a
 *     non-empty list of records or lists (`[429]`, `{}`, `[1, 2]` in an
 *     error text are not);
 *   - an opener that looks like JSON (`{"…`, `[{…`) and never closes is a
 *     cut-off answer: nothing, never a block nested inside it (the
 *     customer's id is not the order's id);
 *   - a block that closes but is not JSON (`{name}`) is stepped over whole.
 */
export function extractJsonText(text) {
    if (typeof text !== 'string') return undefined;
    const whole = parseJsonText(text);
    if (whole !== undefined) return whole;
    const fenced = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/.exec(text);
    if (fenced) {
        const v = parseJsonText(fenced[1]);
        if (v !== undefined) return v;
    }
    // Bounded: no fallback above EXTRACT_MAX_CHARS, one character budget
    // shared by all openers (an opener that does not close and does not look
    // like JSON is rescanned from the next character, which is quadratic on
    // text full of `{`, e.g. a hostile mail or webhook body), and a cap on
    // parse attempts. The first opener of a legitimate answer always gets its
    // full scan (the budget is larger than the cap).
    if (text.length > EXTRACT_MAX_CHARS) return undefined;
    if (text.trimStart().startsWith('<')) return undefined;
    let budget = EXTRACT_SCAN_BUDGET;
    let parses = 0;
    for (let i = 0; i < text.length; i++) {
        const open = text[i];
        if (open !== '{' && open !== '[') continue;
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let inStr = false;
        let end = -1;
        for (let j = i; j < text.length; j++) {
            if (--budget <= 0) return undefined;
            const c = text[j];
            if (inStr) {
                if (c === '\\') j++;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === open) depth++;
            else if (c === close && --depth === 0) { end = j; break; }
        }
        if (end < 0) {
            if (looksLikeJsonStart(text, i)) return undefined;
            continue;
        }
        if (++parses > EXTRACT_MAX_PARSES) return undefined;
        let v;
        try { v = JSON.parse(text.slice(i, end + 1)); } catch { v = undefined; }
        if (v !== null && typeof v === 'object') return looksLikeAnswer(v) ? v : undefined;
        i = end;
    }
    return undefined;
}

/** `{"…` / `{}` or `[` + a JSON value: how an answer (or a cut-off one) starts, unlike `{name}`. */
function looksLikeJsonStart(text, i) {
    let j = i + 1;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a single character class, tested on one character: linear
    while (j < text.length && /\s/.test(text[j])) j++;
    const c = text[j];
    if (c === undefined) return true;
    if (text[i] === '{') return c === '"' || c === '}';
    if (/[[{"\]0-9-]/.test(c)) return true;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an alternation of three literals, no repeat, on a 6-character slice: linear
    return /^(?:true|false|null)(?![A-Za-z0-9_])/.test(text.slice(j, j + 6));
}

/** A block found in prose that reads as an answer: a non-empty record, or a non-empty list of records/lists. */
function looksLikeAnswer(v) {
    if (Array.isArray(v)) return v.length > 0 && v.every(el => el !== null && typeof el === 'object');
    return Object.keys(v).length > 0;
}

// ── Walking ──────────────────────────────────────────────────────────────

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * One step: `cur[key]`, own properties only (never the prototype chain, so
 * `constructor` / `__proto__` resolve to undefined). Two conveniences, both
 * of which only turn an `undefined` into a value:
 *   - a negative index counts from the end of a list (`[-1]` = last);
 *   - a string that is JSON text is read as the object/list it encodes, so
 *     `body.data.items[0]` works on an HTTP body or an AI answer that came
 *     back as text. `.length` of a string stays the string's length.
 */
export function stepInto(cur, key, cache = null) {
    if (cur == null) return undefined;
    if (typeof cur === 'string' && key !== 'length') {
        const parsed = parseJsonText(cur, cache);
        if (parsed !== undefined) cur = parsed;
    }
    if (typeof key === 'number' && key < 0 && Array.isArray(cur)) {
        const i = cur.length + key;
        return i >= 0 ? cur[i] : undefined;
    }
    if (!hasOwn(cur, key)) return undefined;
    return cur[key];
}

/**
 * A match segment: the first element of the list whose own `key` equals
 * `value` — strictly, or case-insensitively for text, or a number against
 * its digits ("5" matches 5). Not a list, or no such element → undefined.
 */
export function stepMatch(cur, key, value, cache = null) {
    const list = listOf(cur, cache);
    if (!list) return undefined;
    // Case-insensitive by lowercasing (the engine's own rule in functions.mjs),
    // not a locale collator: the same answer in every browser and on the
    // server, and cheap on a 10k-row list.
    const lowered = typeof value === 'string' ? value.toLowerCase() : null;
    for (const raw of list) {
        // A JSON-text element reads as the record it encodes, as stepInto and
        // `[*]` already do (queue messages, Redis lists). A list is never a
        // record, also not one encoded as text.
        const el = typeof raw === 'string' ? parseJsonText(raw, cache) : raw;
        if (el == null || typeof el !== 'object' || Array.isArray(el) || !hasOwn(el, key)) continue;
        const v = el[key];
        if (v === value) return el;
        if (lowered !== null && typeof v === 'string' && v.toLowerCase() === lowered) return el;
        if ((typeof v === 'number' && typeof value === 'string') || (typeof v === 'string' && typeof value === 'number')) {
            if (String(v) === String(value)) return el;
        }
    }
    return undefined;
}

/** The list a `[*]` iterates: an array, or JSON text that encodes one. */
function listOf(cur, cache = null) {
    if (Array.isArray(cur)) return cur;
    if (typeof cur === 'string') {
        const parsed = parseJsonText(cur, cache);
        if (Array.isArray(parsed)) return parsed;
    }
    return null;
}

/**
 * Resolve tokens against a value.
 *
 * `[*]` maps the REST of the path over every element and flattens what the
 * rest produced by one level, skipping elements where it is undefined:
 * `results[*].output.attachments` (each message yielding a list) collapses
 * into one flat list of attachments — what a downstream "for each" needs.
 * A TRAILING `[*]` is the list itself, element for element: `rows[*]` on a
 * table of rows keeps the rows (it used to melt them into one list of cells).
 * Explicit nulls are kept, so columns of the same list stay aligned.
 */
export function walkTokens(tokens, root) {
    return walkWith(tokens, root, cacheFor(root));
}

function walkWith(tokens, root, cache) {
    let cur = root;
    for (let t = 0; t < tokens.length; t++) {
        const tok = tokens[t];
        if (tok.type === 'wild') {
            const list = listOf(cur, cache);
            if (!list) return undefined;
            const rest = tokens.slice(t + 1);
            if (!rest.length) return list.filter(el => el !== undefined);
            const out = [];
            for (const el of list) {
                const m = walkWith(rest, el, cache);
                if (m === undefined) continue;
                if (Array.isArray(m)) out.push(...m);
                else out.push(m);
            }
            return out;
        }
        const prev = cur;
        cur = tok.type === 'match' ? stepMatch(cur, tok.key, tok.value, cache) : stepInto(cur, tok.key, cache);
        if (cur === undefined && tok.alt !== undefined) cur = stepInto(prev, tok.alt, cache);
        if (cur === undefined) return undefined;
    }
    return cur;
}

/** Resolve a path string against a value; undefined when invalid or absent. */
export function getPath(root, path) {
    const t = parsePath(path);
    return t ? walkTokens(t, root) : undefined;
}

/**
 * The LIST a path names, read the way the run reads a step's list (a Loop's,
 * a per-item step's or a Condition's source; the server's bind.walkList): an
 * array, or JSON text that encodes one. Null for anything else, so an editor
 * that previews a list shows exactly the rows the run will get.
 */
export function getList(root, path) {
    const v = getPath(root, path);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        const parsed = parseJsonText(v, cacheFor(root));
        if (Array.isArray(parsed)) return parsed;
    }
    return null;
}

/**
 * Resolve a path RELATIVE to a value (the parse_json step, map-json-fields,
 * a column of a list item): `''`/`'$'`/nullish is the value itself, `[0].x`
 * and `[*].sku` start at a root list, `$.a` and `$[0]` are accepted too.
 */
export function getRelativePath(value, path) {
    if (path == null) return value;
    let p = String(path).trim();
    if (p === '' || p === '$') return value;
    if (p.startsWith('$.')) p = p.slice(2);
    else if (p.startsWith('$[')) p = p.slice(1);
    const t = parsePath(p.startsWith('[') ? `$${p}` : `$.${p}`);
    return t ? walkTokens(t, { $: value }) : undefined;
}

// ── Templates ────────────────────────────────────────────────────────────

/**
 * Split a template into text and `{{ … }}` placeholders. Quote-aware: a `}}`
 * inside a quoted key (`{{ x["a}}b"] }}`) does not end the placeholder. An
 * unterminated quote falls back to the first `}}` (the old regex's reading),
 * and `{{}}` / an unclosed `{{` stay text.
 *
 * Returns [{ type: 'text', value }, { type: 'ref', raw, inner, start, end }].
 * `inner` is trimmed; `raw` is the whole `{{…}}`.
 */
export function scanTemplate(text) {
    const parts = [];
    if (typeof text !== 'string' || !text) return parts;
    let i = 0;
    let textStart = 0;
    while (i < text.length) {
        const open = text.indexOf('{{', i);
        if (open < 0) break;
        // `{{{ x }}}` (the Handlebars "raw" spelling people type) reads as
        // `{{ x }}`; it used to leave a stray `}` behind.
        const triple = text[open + 2] === '{';
        let j = open + (triple ? 3 : 2);
        let close = -1;
        let quote = null;
        while (j < text.length) {
            const c = text[j];
            if (quote) {
                if (c === '\\') { j += 2; continue; }
                if (c === quote) quote = null;
                j++;
                continue;
            }
            // A backslash outside quotes escapes the next character: a
            // placeholder typed inside a JSON string often carries `\"`
            // (`"{{ h[name=\"S\"] }}"`); skipping the pair keeps it one
            // placeholder instead of shipping it as literal text.
            if (c === '\\') { j += 2; continue; }
            if (c === '"' || c === "'") { quote = c; j++; continue; }
            if (c === '}' && text[j + 1] === '}') { close = j; break; }
            j++;
        }
        if (close < 0 && quote) close = text.indexOf('}}', open + 2);
        if (close < 0) break;
        const tripleClose = triple && text[close + 2] === '}';
        const inner = text.slice(open + (tripleClose ? 3 : 2), close).trim();
        if (!inner || inner.includes('{{')) {
            // `{{}}` stays text; for `{{ a {{ b }}` the LAST opener wins, as
            // with the old non-greedy regex.
            i = inner ? text.lastIndexOf('{{', close) : close + 2;
            if (!inner) continue;
            continue;
        }
        const end = close + (tripleClose ? 3 : 2);
        if (open > textStart) parts.push({ type: 'text', value: text.slice(textStart, open) });
        parts.push({ type: 'ref', raw: text.slice(open, end), inner, start: open, end });
        i = end;
        textStart = i;
    }
    if (textStart < text.length) parts.push({ type: 'text', value: text.slice(textStart) });
    return parts;
}

/**
 * Replace every `{{ … }}` placeholder via `fn(inner, raw)`; the return value
 * (a string) takes the placeholder's place. Same reading as scanTemplate.
 */
export function replaceTemplate(text, fn) {
    if (typeof text !== 'string') return text;
    return scanTemplate(text).map(p => (p.type === 'text' ? p.value : fn(p.inner, p.raw))).join('');
}
