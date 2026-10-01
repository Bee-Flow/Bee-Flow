/**
 * Whitelisted helper functions for the shared expression language.
 *
 * SHARED across the automation runtime (server) and App Studio (client + server).
 * Every function here is:
 *   - PURE: output depends only on its argument VALUES.
 *   - NULL-SAFE: never throws on null/undefined; returns a benign fallback.
 *   - DETERMINISTIC: no ambient time, no locale, no randomness — so the SAME
 *     expression + scope evaluates identically in Node and in the browser
 *     (that identity is the whole reason the engine is shared). "Now"/"today"
 *     are SCOPE variables, never functions, precisely to keep this property.
 *
 * The parser rejects any call to a name not in FUNCTIONS at PARSE time, so
 * this map is the complete, auditable set of callable forms. Adding a function
 * here makes it available to both runtimes at once; the FE syntax-help mirror
 * (agent-hub .../mapping/exprFunctions.js) and its lockstep test track this set.
 */

import { parseDate, parseLocaleNumber } from './parse.mjs';

// ── Dates ──────────────────────────────────────────────────────────────────
// Dates are ISO strings, RFC 2822 text or unix timestamps written as text,
// read by parseDate (parse.mjs) to a UTC instant without Date.parse, so a
// value means the same thing in every JS engine. Everything below is UTC.
//
// Stored expressions must keep giving the results they gave before the
// lenient readers arrived, so this file only lets parse.mjs turn a value that
// used to give null into a date. Two of its readings would CHANGE a result
// that was already a date, and both stay out of here:
//   - a NUMBER is an epoch in milliseconds, as it always was (parseDate reads
//     one below 1e11 as seconds, which would move a 1966-1973 millisecond
//     epoch, a birth date say, to another year). Only the pick readers
//     (mapping/fit.mjs), which no stored expression goes through, take that
//     reading.
//   - formatDate renders the UTC day, as it always did; it does not shift a
//     day-only format into the zone the value was written in.
function toEpoch(iso) {
    const d = parseDate(iso, { numberAs: 'ms' });
    return d ? d.epoch : null;
}

const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 };

function pad(n, w = 2) { return String(Math.abs(n)).padStart(w, '0'); }

// ── Formatting for people (builder redesign, artboard 2c) ──────────────────
// "In text: choose a format — amount, percentage, plain" for a number, "choose
// a notation (2 september 2026 · 02-09-2026)" for a date, "choose what it says
// for yes and for no" for a yes/no, "a readable summary" for a group and "as a
// table" for a table. These are the calls the ValueBuilder writes behind its
// "· as € 1.500.000" pills, so they live HERE, in the whitelist both runtimes
// share — never in the UI.
//
// LOCALE IS AN ARGUMENT, NEVER THE ENVIRONMENT. The header's determinism rule
// forbids Intl: its output depends on the ICU build of the engine that runs
// it, so the same expression would render "1.500.000" on one server and
// "1,500,000" in a browser. The separators and month names are tables. A
// locale outside the table falls back to `nl` — the design language, and the
// default the builder writes when it does not pass one.
const NUMBER_LOCALES = {
    nl: { group: '.', decimal: ',', currencyBefore: true, currencySpace: true, percentSpace: false },
    en: { group: ',', decimal: '.', currencyBefore: true, currencySpace: false, percentSpace: false },
    de: { group: '.', decimal: ',', currencyBefore: false, currencySpace: true, percentSpace: true },
    fr: { group: ' ', decimal: ',', currencyBefore: false, currencySpace: true, percentSpace: true },
};
const MONTH_NAMES = {
    nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
const WEEKDAY_NAMES = {
    nl: ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'],
    en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    de: ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'],
    fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
};
const YES_WORDS = new Set(['true', 'yes', 'ja', 'y', 'j', '1', 'on', 'oui']);
const NO_WORDS = new Set(['false', 'no', 'nee', 'n', '0', 'off', 'non', '']);

function localeKey(locale) {
    const k = String(locale == null ? 'nl' : locale).trim().toLowerCase().split(/[-_]/)[0];
    return NUMBER_LOCALES[k] ? k : 'nl';
}

// Group the integer part in threes and swap the separators. Decimals are
// fixed by the caller so "1.5" never becomes "1,5" in one style and "1,50"
// in another.
function groupDigits(absFixed, loc) {
    const [int, frac] = absFixed.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, loc.group);
    return frac ? `${grouped}${loc.decimal}${frac}` : grouped;
}

// Decimals for a style: an amount shows cents only when it has them
// ("€ 1.500.000", "€ 12,50"), a percentage keeps up to one decimal, plain
// keeps up to two. `places` overrides all three.
function decimalsFor(n, style, places) {
    const p = toNum(places);
    if (p != null) return Math.max(0, Math.min(20, Math.trunc(p)));
    const cap = style === 'percent' ? 1 : 2;
    const fixed = n.toFixed(cap);
    if (/\.0+$/.test(fixed)) return 0;
    // An amount with cents always shows both ("€ 12,50", never "€ 12,5");
    // a percentage or plain number drops the trailing zero.
    if (style === 'amount' || style === 'currency') return 2;
    return fixed.replace(/0+$/, '').split('.')[1]?.length ?? 0;
}

// Words a person would write for the two states of a yes/no field, or the
// booleans and 0/1 a tool returns. Anything else is "not known" → null, so
// yesNoText can stay silent instead of guessing "no" for a missing value.
function toYesNo(v) {
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return null;
    if (typeof v === 'number') return v === 0 ? false : (isFinite(v) ? true : null);
    const s = String(v).trim().toLowerCase();
    if (YES_WORDS.has(s)) return true;
    if (NO_WORDS.has(s)) return false;
    return null;
}

// "customer_name" → "Customer name" — the key as a label, the same rule the
// builder's humanizeFieldTail applies on screen, so a summary reads like the
// picker did.
function labelFromKey(k) {
    const s = String(k).replace(/[_\-.]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}

// One cell of a table or one line of a summary: scalars as they are, a
// nested list as its items joined, a nested group as "k: v" pairs, never
// "[object Object]". Depth-capped so a self-referential structure cannot spin.
function cellText(v, depth = 0) {
    if (v == null) return '';
    if (typeof v !== 'object') return String(v);
    if (depth >= 2) return Array.isArray(v) ? `${v.length} items` : `${Object.keys(v).length} fields`;
    if (Array.isArray(v)) return v.map((x) => cellText(x, depth + 1)).join(', ');
    return Object.keys(v).map((k) => `${labelFromKey(k)}: ${cellText(v[k], depth + 1)}`).join(', ');
}

// A plain record: an object that is not a list.
function isRecord(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

// One item of join(): a record as readable "Key: value" pairs, anything else
// as it always was (String of the value, '' for null).
function joinItemText(x) {
    if (x == null) return '';
    return isRecord(x) ? cellText(x) : String(x);
}

// A number, or null. Number() reads first, so every value it could already
// read keeps its result ('1.234' stays 1.234); only text it rejected is read
// again the way a Dutch or euro source writes it ('12,5', '€ 1.554,25'), see
// parseLocaleNumber. Before that second reading, those values were null.
function toNum(x) {
    if (x == null || x === '') return null;
    const n = typeof x === 'number' ? x : Number(x);
    if (isFinite(n)) return n;
    return typeof x === 'string' ? parseLocaleNumber(x) : null;
}

// ── Totality gate for the maths helpers ────────────────────────────────────
// toNum() guards the INPUT; finite() guards the OUTPUT. Between them every
// numeric helper is TOTAL: a domain error (sqrt(-1) → NaN), a pole
// (ln(0) → -Infinity) or an overflow (exp(1000) → Infinity) collapses to
// `null` — the engine's single "no value" signal, which a stat renders as an
// empty cell — instead of painting the literal text "NaN"/"Infinity" into the
// UI or poisoning every arithmetic node downstream of it.
//
// NOTE this is deliberately NOT applied to the `/` operator: `1 / 0` has
// evaluated to Infinity since the engine's first commit and stored app
// definitions + automation conditions depend on that exact behaviour, so the
// operator is left byte-identical. The `^` operator is new, has no installed
// base, and therefore routes through pow() and gets the strict rule.
function finite(n) { return typeof n === 'number' && isFinite(n) ? n : null; }

// Lift a 1-argument Math function into the null-safe/total house style, so the
// fifteen single-argument maths helpers below cannot drift from each other.
const unary1 = (f) => (x) => { const n = toNum(x); return n == null ? null : finite(f(n)); };

// Text matching is CASE-INSENSITIVE. A no-code filter that reads "subject
// contains ISV" must also keep "Re: isv contract" — case was by far the most
// common reason a filter silently returned nothing, and no builder-facing
// operator ever offered a way to say "ignore case". Only the STRING
// comparison changes: `contains(list, x)` keeps its exact-equality fast path
// for non-strings, ordering/equality operators are untouched, and `lower()`
// stays available for explicit normalisation.
const ciEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const ci = (x) => String(x).toLowerCase();

// ── JSON path walker (for parseJson) ───────────────────────────────────────
// A miniature of the binding resolver's walkRelativePath (server
// automation/bind.js): dotted keys, [0] indices, ["quoted keys"], and a [*]
// wildcard that maps the remainder over an array and flattens one level.
// Prototype-chain members never resolve (own-property gate), so JSON text can
// never be used to reach `constructor`/`__proto__`. Misses return undefined —
// same contract as every path lookup in the engine.
function walkJsonSegments(value, segments, s) {
    let cur = value;
    for (let t = s; t < segments.length; t++) {
        const seg = segments[t];
        if (seg.wild) {
            if (!Array.isArray(cur)) return undefined;
            const out = [];
            for (const el of cur) {
                const m = walkJsonSegments(el, segments, t + 1);
                if (m === undefined) continue;
                if (Array.isArray(m)) out.push(...m);
                else out.push(m);
            }
            return out;
        }
        if (cur == null) return undefined;
        if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return undefined;
        cur = cur[seg.key];
    }
    return cur;
}

function walkJsonPath(value, path) {
    const segments = [];
    let i = 0;
    let buf = '';
    const flush = () => { if (buf.length) { segments.push({ key: buf }); buf = ''; } };
    while (i < path.length) {
        const c = path[i];
        if (c === '.') { flush(); i++; continue; }
        if (c === '[') {
            flush();
            const close = path.indexOf(']', i);
            if (close < 0) return undefined; // malformed → miss, never throw
            const raw = path.slice(i + 1, close);
            if (raw === '*') segments.push({ wild: true });
            else if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) segments.push({ key: raw.slice(1, -1) });
            else segments.push({ key: parseInt(raw, 10) });
            i = close + 1;
            continue;
        }
        buf += c;
        i++;
    }
    flush();
    return walkJsonSegments(value, segments, 0);
}

export const FUNCTIONS = {
    // ── Original 7 (kept byte-identical to server/automation/expr.js) ──────
    contains: (a, b) => {
        if (a == null) return false;
        if (Array.isArray(a)) return a.some((x) => x === b || (typeof x === 'string' && typeof b === 'string' && ci(x).includes(ci(b))));
        return ci(a).includes(b == null ? '' : ci(b));
    },
    startsWith: (a, b) => (a == null ? false : ci(a).startsWith(b == null ? '' : ci(b))),
    endsWith: (a, b) => (a == null ? false : ci(a).endsWith(b == null ? '' : ci(b))),
    lower: (a) => (a == null ? '' : String(a).toLowerCase()),
    upper: (a) => (a == null ? '' : String(a).toUpperCase()),
    len: (a) => {
        if (a == null) return 0;
        if (Array.isArray(a) || typeof a === 'string') return a.length;
        if (typeof a === 'object') return Object.keys(a).length;
        return 0;
    },
    isEmpty: (a) => {
        if (a == null) return true;
        if (Array.isArray(a) || typeof a === 'string') return a.length === 0;
        if (typeof a === 'object') return Object.keys(a).length === 0;
        return false;
    },

    // ── Numeric ────────────────────────────────────────────────────────────
    number: (x) => toNum(x),
    round: (x, places = 0) => {
        const n = toNum(x); if (n == null) return null;
        const p = toNum(places) || 0;
        const f = Math.pow(10, p);
        // finite() added with the maths surface: `round(x, 400)` used to
        // return NaN (10^400 is Infinity, so n*f/f is Infinity/Infinity) and
        // `round(1e308, 2)` used to return Infinity — both painted as literal
        // text in a stat. round() wraps nearly every scientific formula, so
        // the guarantee has to hold here too. Every result that was already a
        // real number is untouched.
        return finite(Math.round(n * f) / f);
    },
    floor: (x) => { const n = toNum(x); return n == null ? null : Math.floor(n); },
    ceil: (x) => { const n = toNum(x); return n == null ? null : Math.ceil(n); },
    abs: (x) => { const n = toNum(x); return n == null ? null : Math.abs(n); },
    min: (...xs) => { const ns = xs.map(toNum).filter((n) => n != null); return ns.length ? Math.min(...ns) : null; },
    max: (...xs) => { const ns = xs.map(toNum).filter((n) => n != null); return ns.length ? Math.max(...ns) : null; },
    clamp: (x, lo, hi) => {
        const n = toNum(x); if (n == null) return null;
        const l = toNum(lo); const h = toNum(hi);
        let r = n; if (l != null) r = Math.max(r, l); if (h != null) r = Math.min(r, h); return r;
    },
    sum: (arr) => (Array.isArray(arr) ? arr.reduce((s, x) => s + (toNum(x) || 0), 0) : 0),
    avg: (arr) => {
        if (!Array.isArray(arr)) return null;
        const ns = arr.map(toNum).filter((n) => n != null);
        return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : null;
    },

    // ── Maths (scientific) ─────────────────────────────────────────────────
    // A real calculator needs powers, roots, logs and trig; without them the
    // App Studio builder could only ever produce a four-function form. Every
    // helper here funnels through toNum() on the way in and finite() on the way
    // out, so none of them can throw, return NaN, or return Infinity.
    //
    // NOT PROVIDED, DELIBERATELY: `random()`. The whole contract of this shared
    // engine (see the file header) is that the same expression + scope
    // evaluates identically in Node and in the browser, and that a formula may
    // be recomputed at any time without changing its answer. A random source
    // breaks the golden corpus, breaks client/server parity, and would make a
    // stat flicker on every re-render. An app that needs entropy must take it
    // from an action's output, which is a value in scope like any other.
    //
    // ANGLES ARE RADIANS, as in JS/Python/spreadsheets. degrees()/radians()
    // convert; e.g. `sin(radians(30))` is 0.5.

    // Constants are ZERO-ARGUMENT FUNCTIONS — `PI()`, not `PI`. Bare
    // identifiers are scope paths in this grammar (`form.x`, `item.total`), so
    // a bare `PI` would have to be injected into every scope root by every
    // caller (automation runtime, App Studio preview, server validation) and
    // would still read as an "unknown formula root" to validate.js. As calls
    // they are whitelist entries like any other: nothing else changes, and
    // they are impossible to shadow with a scope key.
    PI: () => Math.PI,
    E: () => Math.E,

    pow: (x, y) => {
        const a = toNum(x); const b = toNum(y);
        // pow(0, -1) is a pole → null. pow(-8, 1/3) is NaN in IEEE-754 (a
        // fractional exponent on a negative base) → null; use cbrt(-8) for
        // the real cube root.
        return a == null || b == null ? null : finite(Math.pow(a, b));
    },
    sqrt: unary1(Math.sqrt),   // sqrt(-1) → null (no complex numbers here)
    cbrt: unary1(Math.cbrt),   // cbrt(-27) → -3, unlike pow(-27, 1/3)
    exp: unary1(Math.exp),     // exp(1000) overflows → null
    ln: unary1(Math.log),      // ln(0) → null (pole), ln(-1) → null (domain)
    log10: unary1(Math.log10),
    // log(x, base?) — base defaults to **10**, matching the LOG key on a
    // calculator and LOG() in every spreadsheet. Natural log is `ln`, which is
    // why the default can safely be 10 rather than e. Bases 10 and 2 use the
    // dedicated Math builtins so log(1000) is exactly 3 rather than
    // 2.9999999999999996 from a division of logs.
    log: (x, base) => {
        const n = toNum(x); if (n == null) return null;
        const b = base == null ? 10 : toNum(base);
        if (b == null || b <= 0 || b === 1) return null; // base 1 and non-positive bases are undefined
        if (b === 10) return finite(Math.log10(n));
        if (b === 2) return finite(Math.log2(n));
        return finite(Math.log(n) / Math.log(b));
    },

    sin: unary1(Math.sin),
    cos: unary1(Math.cos),
    tan: unary1(Math.tan),     // tan(radians(90)) is ~1.6e16, not Infinity — IEEE-754 has no exact π/2
    asin: unary1(Math.asin),   // asin(2) → null (domain is [-1, 1])
    acos: unary1(Math.acos),   // acos(2) → null
    atan: unary1(Math.atan),
    atan2: (y, x) => {
        const a = toNum(y); const b = toNum(x);
        return a == null || b == null ? null : finite(Math.atan2(a, b));
    },
    sinh: unary1(Math.sinh),   // sinh(1000) overflows → null
    cosh: unary1(Math.cosh),
    tanh: unary1(Math.tanh),
    degrees: (x) => { const n = toNum(x); return n == null ? null : finite(n * 180 / Math.PI); },
    radians: (x) => { const n = toNum(x); return n == null ? null : finite(n * Math.PI / 180); },

    // sign(-0) is -0 in JS, which deep-equals 0 loosely but NOT strictly and
    // renders as "0" anyway — collapse it so the function has three outputs.
    sign: (x) => { const n = toNum(x); if (n == null) return null; const s = Math.sign(n); return s === 0 ? 0 : s; },
    trunc: unary1(Math.trunc), // toward zero: trunc(-2.7) → -2, floor(-2.7) → -3

    // mod(a, b) — TRUE modulo: the result carries the sign of the DIVISOR, so
    // mod(-1, 12) is 11 (the clock-face answer people expect). The `%`
    // OPERATOR is a remainder and carries the sign of the DIVIDEND, so
    // `-1 % 12` is -1. Both stay: `%` is untouched for every stored expression,
    // mod() is the one to reach for when wrapping around a range.
    // mod(x, 0) is null (JS `x % 0` is NaN).
    mod: (a, b) => {
        const x = toNum(a); const y = toNum(b);
        if (x == null || y == null || y === 0) return null;
        const r = ((x % y) + y) % y;
        return r === 0 ? 0 : finite(r); // collapse -0 → 0, same reason as sign()
    },
    // hypot(a, b, …) — √(a²+b²+…), overflow-safe. Skips non-numeric arguments
    // exactly as min()/max() do; hypot() with nothing numeric is null.
    hypot: (...xs) => { const ns = xs.map(toNum).filter((n) => n != null); return ns.length ? finite(Math.hypot(...ns)) : null; },
    // factorial(n) — whole numbers in [0, 170] only. 170! ≈ 7.26e306 is the
    // largest factorial a double can hold (171! is Infinity), so the cap is
    // where the answer stops existing anyway — and it doubles as the LOOP
    // BOUND, which is the real guard: factorial(1000000000) returns null
    // instantly instead of spinning a billion iterations inside a render pass.
    factorial: (x) => {
        const n = toNum(x);
        if (n == null || !Number.isInteger(n) || n < 0 || n > 170) return null;
        let r = 1;
        for (let i = 2; i <= n; i++) r *= i;
        return finite(r);
    },

    // ── Null / logic ─────────────────────────────────────────────────────
    coalesce: (...xs) => { for (const x of xs) if (x != null) return x; return null; },
    default: (x, fb) => (x == null ? (fb == null ? null : fb) : x),
    ifNull: (x, fb) => (x == null ? (fb == null ? null : fb) : x),

    // ── String ────────────────────────────────────────────────────────────
    trim: (s) => (s == null ? '' : String(s).trim()),
    concat: (...xs) => xs.map((x) => (x == null ? '' : String(x))).join(''),
    replace: (s, find, repl) => (s == null ? '' : String(s).split(find == null ? '' : String(find)).join(repl == null ? '' : String(repl))),
    split: (s, sep) => (s == null ? [] : String(s).split(sep == null ? '' : String(sep))),
    // A list's items joined into one text. A record among them reads as
    // "Key: value" pairs (cellText), never "[object Object]"; a single value
    // where a list was expected is that value as text, as if it were a list
    // of one (a step that returns one e-mail address instead of a list of
    // them). Both used to give "[object Object]" and '' respectively.
    join: (arr, sep) => {
        if (arr == null) return '';
        if (!Array.isArray(arr)) return joinItemText(arr);
        return arr.map(joinItemText).join(sep == null ? '' : String(sep));
    },
    substring: (s, a, b) => {
        if (s == null) return '';
        const str = String(s); const start = toNum(a) || 0;
        return b == null ? str.substring(start) : str.substring(start, toNum(b) || 0);
    },
    padStart: (s, n, ch) => (s == null ? '' : String(s).padStart(toNum(n) || 0, ch == null ? ' ' : String(ch))),
    toStr: (x) => (isRecord(x) ? cellText(x) : (x == null ? '' : String(x))),
    // Sum the leading multipliers in a "2x M5 + 4x M8" style list — the shape
    // every parts/BOM app writes its per-item breakdowns in. Exists because a
    // language model asked to BOTH list the groups AND add them up will
    // sometimes disagree with itself, and the app has no way to notice; with
    // this the total is DERIVED from the list and the two cannot diverge.
    //
    // Counts a group only when the number is followed by an x/×/* multiplier
    // that is NOT itself followed by another number — so quantities ("4x M8",
    // "6 x ⌀11") count, while dimensions ("100 x 80") and thread pitches
    // ("M8x1.25") do not. Bare numbers ("963", "⌀6,4") never count.
    // Returns null — not 0 — when there is no group at all, so an empty
    // breakdown stays empty instead of claiming a confident zero.
    sumCounts: (s) => {
        if (s == null) return null;
        const m = String(s).match(/\d+(?:[.,]\d+)?\s*[xX×*](?!\s*[\d.,])/g);
        if (!m || !m.length) return null;
        let total = 0;
        for (const g of m) total += Number(g.replace(/[xX×*]\s*$/, '').replace(',', '.').trim());
        return finite(total);
    },

    // ── Array ─────────────────────────────────────────────────────────────
    // A single value where a list was expected is a list of one: its first
    // and its last item are the value itself (they used to be null).
    first: (arr) => (Array.isArray(arr) ? (arr.length ? arr[0] : null) : (arr === undefined ? null : arr)),
    last: (arr) => (Array.isArray(arr) ? (arr.length ? arr[arr.length - 1] : null) : (arr === undefined ? null : arr)),
    includes: (arr, x) => (Array.isArray(arr)
        ? arr.some((el) => el === x || (typeof el === 'string' && typeof x === 'string' && ciEq(el, x)))
        : false),
    count: (a) => {
        if (a == null) return 0;
        if (Array.isArray(a) || typeof a === 'string') return a.length;
        if (typeof a === 'object') return Object.keys(a).length;
        return 0;
    },
    // Positional navigation — at/index_of are the prev/next primitives: find
    // the index of the current selection in a source list, then read the
    // neighbour at index ± 1. Both are list-only (a string is not a list
    // here; first/last read a single value as a list of one, but an index
    // into one is not a question with a useful answer). index_of matches values exactly the way
    // includes() does — strict equality plus case-insensitive text — so
    // "is it in the list" and "where is it" can never disagree.
    at: (arr, i) => {
        if (!Array.isArray(arr)) return null;
        let n = toNum(i);
        if (n == null) return null;
        n = Math.trunc(n);
        if (n < 0) n += arr.length; // negative counts from the end, like JS .at()
        return n >= 0 && n < arr.length && arr[n] !== undefined ? arr[n] : null;
    },
    index_of: (arr, x) => {
        if (!Array.isArray(arr)) return -1;
        for (let i = 0; i < arr.length; i++) {
            const el = arr[i];
            if (el === x || (typeof el === 'string' && typeof x === 'string' && ciEq(el, x))) return i;
        }
        return -1;
    },
    // Own-property gate, like every path lookup in the engine — a key can
    // never reach constructor/__proto__ through the prototype chain, and a
    // non-object item contributes null rather than a boxed-string surprise.
    pluck: (arr, key) => {
        if (!Array.isArray(arr)) return [];
        const k = key == null ? '' : String(key);
        return arr.map((el) => (
            el != null && typeof el === 'object' && Object.prototype.hasOwnProperty.call(el, k) && el[k] !== undefined
                ? el[k]
                : null
        ));
    },
    // The row behind a selection. A screen keeps the selected row in a
    // variable (a COPY), and every write to the table leaves that copy stale:
    // the detail panel goes on saying "material missing" after the material
    // was filled in. `find(records.<table>, "id", vars.sel.id)` reads the live
    // row back out of the refreshed list, which is the only honest source.
    // Same matching as includes()/index_of(): strict, plus case-insensitive
    // text. Nothing found → null, never an error.
    find: (arr, key, x) => {
        if (!Array.isArray(arr)) return null;
        const k = key == null ? '' : String(key);
        for (const el of arr) {
            if (el == null || typeof el !== 'object' || !Object.prototype.hasOwnProperty.call(el, k)) continue;
            const v = el[k];
            if (v === x || (typeof v === 'string' && typeof x === 'string' && ciEq(v, x))) return el;
        }
        return null;
    },

    // ── JSON ──────────────────────────────────────────────────────────────
    // Parse JSON text and optionally pick a path out of it. This is the
    // expression-language successor of the parse_json step: deterministic,
    // free at run time, never throws (invalid JSON → null). The grammar has
    // no member access on a call result — `parseJson(x).user` cannot parse —
    // so the two-argument form IS the way to reach into the parsed value.
    // Already-parsed objects/arrays pass through, so the same expression
    // works whether an upstream tool returned text or structured data.
    parseJson: (text, path) => {
        if (text == null) return null;
        let v;
        if (typeof text === 'object') v = text;
        else {
            let s = String(text);
            if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
            s = s.trim();
            if (!s) return null;
            try { v = JSON.parse(s); } catch { return null; }
        }
        return (path == null || path === '' || path === '$') ? v : walkJsonPath(v, String(path));
    },

    // ── Date (operate on ISO strings; UTC + deterministic) ────────────────
    dateAdd: (iso, n, unit) => {
        const e = toEpoch(iso); if (e == null) return null;
        const amt = toNum(n) || 0; const ms = UNIT_MS[unit] || UNIT_MS.day;
        return new Date(e + amt * ms).toISOString();
    },
    dateDiff: (a, b, unit) => {
        const ea = toEpoch(a); const eb = toEpoch(b);
        if (ea == null || eb == null) return null;
        const ms = UNIT_MS[unit] || UNIT_MS.day;
        return Math.floor((ea - eb) / ms);
    },
    // formatDate(date, format, locale?) — the six numeric tokens as before,
    // plus MMMM/MMM (month name), dddd/ddd (weekday name) and D/M (no zero
    // pad), so "D MMMM YYYY" is "2 september 2026" and "DD-MM-YYYY" is
    // "02-09-2026" (artboard 2c). Names come from the locale TABLE above,
    // never from Intl; unknown locales read as nl.
    //
    // Rendered in UTC, as it always was, day-only formats included: a stored
    // routine that files by formatDate(x, "YYYY-MM-DD") keeps its folders.
    formatDate: (iso, fmt, locale) => {
        const e = toEpoch(iso); if (e == null) return '';
        const format = String(fmt == null ? 'YYYY-MM-DD' : fmt);
        const d = new Date(e);
        // Belt and braces beside parseDate's range check: the month/weekday
        // lookups below index a table, and an Invalid Date would index it on
        // NaN and throw `undefined.slice` — a throw, out of a file that
        // promises a fallback. Whatever else changes about parsing, this stays
        // total.
        if (!Number.isFinite(d.getTime())) return '';
        const loc = localeKey(locale);
        const months = MONTH_NAMES[loc];
        const days = WEEKDAY_NAMES[loc];
        const map = {
            YYYY: d.getUTCFullYear(),
            MMMM: months[d.getUTCMonth()], MMM: months[d.getUTCMonth()].slice(0, 3),
            MM: pad(d.getUTCMonth() + 1), M: d.getUTCMonth() + 1,
            dddd: days[d.getUTCDay()], ddd: days[d.getUTCDay()].slice(0, 2),
            DD: pad(d.getUTCDate()), D: d.getUTCDate(),
            HH: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), ss: pad(d.getUTCSeconds()),
        };
        return format.replace(/YYYY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|mm|ss/g, (t) => String(map[t]));
    },
    // formatNumber(value, style?, locale?, places?) — "amount" (€ 1.500.000),
    // "percent" (12,5%; the VALUE is the fraction, 0.125, as in a spreadsheet)
    // or "plain" (1.500.000). Thousands and decimals follow the locale table;
    // `places` pins the decimals, otherwise an amount shows cents only when
    // it has them. Not a number → '' (a text slot stays clean), never "NaN".
    formatNumber: (value, style, locale, places) => {
        const n = toNum(value); if (n == null) return '';
        const st = String(style == null ? 'plain' : style).trim().toLowerCase();
        const loc = NUMBER_LOCALES[localeKey(locale)];
        const scaled = st === 'percent' ? n * 100 : n;
        if (!isFinite(scaled)) return '';
        const decimals = decimalsFor(scaled, st, places);
        const body = groupDigits(Math.abs(scaled).toFixed(decimals), loc);
        const sign = scaled < 0 ? '-' : '';
        if (st === 'amount' || st === 'currency') {
            const sym = '€';
            return loc.currencyBefore
                ? `${sign}${sym}${loc.currencySpace ? ' ' : ''}${body}`
                : `${sign}${body}${loc.currencySpace ? ' ' : ''}${sym}`;
        }
        if (st === 'percent') return `${sign}${body}${loc.percentSpace ? ' ' : ''}%`;
        return `${sign}${body}`;
    },
    // yesNoText(value, yesText?, noText?) — the word for each state ("wel" /
    // "niet"). Booleans, 0/1, and the usual words in four languages count;
    // anything undecidable (null, "maybe") gives '' rather than a wrong "no".
    yesNoText: (value, yesText, noText) => {
        const b = toYesNo(value);
        if (b == null) return '';
        return b ? (yesText == null ? 'yes' : String(yesText)) : (noText == null ? 'no' : String(noText));
    },
    // groupSummary(group) — "Name: Alice\nAge: 3": one line per field, keys
    // as labels, nested values flattened by cellText. A list of groups gives
    // one block per item separated by a blank line; a scalar is itself.
    groupSummary: (value) => {
        if (value == null) return '';
        if (typeof value !== 'object') return String(value);
        const one = (obj) => (obj != null && typeof obj === 'object' && !Array.isArray(obj)
            ? Object.keys(obj).map((k) => `${labelFromKey(k)}: ${cellText(obj[k], 1)}`).join('\n')
            : cellText(obj));
        return Array.isArray(value) ? value.map(one).join('\n\n') : one(value);
    },
    // asTable(rows) — a Markdown table from a list of groups: the header is
    // every key in first-seen order, cells go through cellText, pipes are
    // escaped. A list of scalars is a one-column table; anything else is ''.
    // Markdown because every text destination the builder writes to (an AI
    // prompt, a notification, a generated document) renders it or at least
    // keeps the rows readable.
    asTable: (rows) => {
        if (!Array.isArray(rows) || !rows.length) return '';
        const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
        const objects = rows.filter((r) => r != null && typeof r === 'object' && !Array.isArray(r));
        if (!objects.length) {
            return ['| value |', '| --- |', ...rows.map((r) => `| ${esc(cellText(r))} |`)].join('\n');
        }
        const keys = [];
        for (const r of objects) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
        const head = `| ${keys.map((k) => esc(labelFromKey(k))).join(' | ')} |`;
        const rule = `| ${keys.map(() => '---').join(' | ')} |`;
        const body = objects.map((r) => `| ${keys.map((k) => esc(cellText(r[k]))).join(' | ')} |`);
        return [head, rule, ...body].join('\n');
    },
    year: (iso) => { const e = toEpoch(iso); return e == null ? null : new Date(e).getUTCFullYear(); },
    month: (iso) => { const e = toEpoch(iso); return e == null ? null : new Date(e).getUTCMonth() + 1; },
    day: (iso) => { const e = toEpoch(iso); return e == null ? null : new Date(e).getUTCDate(); },
    weekday: (iso) => { const e = toEpoch(iso); return e == null ? null : new Date(e).getUTCDay(); }, // 0=Sun
    isBefore: (a, b) => { const ea = toEpoch(a); const eb = toEpoch(b); return ea == null || eb == null ? false : ea < eb; },
    isAfter: (a, b) => { const ea = toEpoch(a); const eb = toEpoch(b); return ea == null || eb == null ? false : ea > eb; },
};

// Rich metadata for the inspector's syntax-help panel. Kept next to the
// implementations so a new function is documented where it's defined.
export const EXPR_FUNCTIONS = [
    { name: 'contains', signature: 'contains(text, part)', description: 'True when text (or a list) contains part. Ignores upper/lower case.' },
    { name: 'startsWith', signature: 'startsWith(text, part)', description: 'True when text starts with part. Ignores upper/lower case.' },
    { name: 'endsWith', signature: 'endsWith(text, part)', description: 'True when text ends with part. Ignores upper/lower case.' },
    { name: 'lower', signature: 'lower(text)', description: 'Lowercase the text.' },
    { name: 'upper', signature: 'upper(text)', description: 'Uppercase the text.' },
    { name: 'len', signature: 'len(value)', description: 'Length of text, a list, or an object.' },
    { name: 'isEmpty', signature: 'isEmpty(value)', description: 'True for missing values, empty text, lists or objects.' },
    { name: 'number', signature: 'number(value)', description: 'Convert to a number (or null if not numeric). Reads "12,5" and "€ 1.554,25" too.' },
    { name: 'round', signature: 'round(value, places?)', description: 'Round to the given decimal places (default 0).' },
    { name: 'floor', signature: 'floor(value)', description: 'Round down to a whole number.' },
    { name: 'ceil', signature: 'ceil(value)', description: 'Round up to a whole number.' },
    { name: 'abs', signature: 'abs(value)', description: 'Absolute value.' },
    { name: 'min', signature: 'min(a, b, …)', description: 'Smallest of the given numbers.' },
    { name: 'max', signature: 'max(a, b, …)', description: 'Largest of the given numbers.' },
    { name: 'clamp', signature: 'clamp(value, lo, hi)', description: 'Constrain value between lo and hi.' },
    { name: 'sum', signature: 'sum(list)', description: 'Sum of a list of numbers.' },
    { name: 'avg', signature: 'avg(list)', description: 'Average of a list of numbers.' },
    { name: 'PI', signature: 'PI()', description: 'The constant π (3.14159…). Written with brackets, like a function.' },
    { name: 'E', signature: 'E()', description: "Euler's number e (2.71828…). Written with brackets, like a function." },
    { name: 'pow', signature: 'pow(base, exponent)', description: 'base raised to exponent. Same as the ^ operator.' },
    { name: 'sqrt', signature: 'sqrt(value)', description: 'Square root. Negative input gives nothing.' },
    { name: 'cbrt', signature: 'cbrt(value)', description: 'Cube root. Works for negative numbers too.' },
    { name: 'exp', signature: 'exp(value)', description: 'e raised to the power of value.' },
    { name: 'ln', signature: 'ln(value)', description: 'Natural logarithm (base e). Zero or negative gives nothing.' },
    { name: 'log10', signature: 'log10(value)', description: 'Logarithm base 10.' },
    { name: 'log', signature: 'log(value, base?)', description: 'Logarithm, base 10 by default. Use ln() for natural log.' },
    { name: 'sin', signature: 'sin(radians)', description: 'Sine of an angle in radians — sin(radians(30)) is 0.5.' },
    { name: 'cos', signature: 'cos(radians)', description: 'Cosine of an angle in radians.' },
    { name: 'tan', signature: 'tan(radians)', description: 'Tangent of an angle in radians.' },
    { name: 'asin', signature: 'asin(value)', description: 'Inverse sine, in radians. Outside −1…1 gives nothing.' },
    { name: 'acos', signature: 'acos(value)', description: 'Inverse cosine, in radians. Outside −1…1 gives nothing.' },
    { name: 'atan', signature: 'atan(value)', description: 'Inverse tangent, in radians.' },
    { name: 'atan2', signature: 'atan2(y, x)', description: 'Angle in radians from the x-axis to the point (x, y).' },
    { name: 'sinh', signature: 'sinh(value)', description: 'Hyperbolic sine.' },
    { name: 'cosh', signature: 'cosh(value)', description: 'Hyperbolic cosine.' },
    { name: 'tanh', signature: 'tanh(value)', description: 'Hyperbolic tangent.' },
    { name: 'degrees', signature: 'degrees(radians)', description: 'Convert radians to degrees.' },
    { name: 'radians', signature: 'radians(degrees)', description: 'Convert degrees to radians.' },
    { name: 'sign', signature: 'sign(value)', description: '−1, 0 or 1 depending on the sign of value.' },
    { name: 'trunc', signature: 'trunc(value)', description: 'Drop the decimals, towards zero — trunc(−2.7) is −2.' },
    { name: 'mod', signature: 'mod(a, b)', description: 'Modulo that wraps around — mod(−1, 12) is 11, unlike −1 % 12.' },
    { name: 'hypot', signature: 'hypot(a, b, …)', description: 'Square root of the sum of squares — hypot(3, 4) is 5.' },
    { name: 'factorial', signature: 'factorial(n)', description: 'n! for whole numbers 0–170. Anything else gives nothing.' },
    { name: 'coalesce', signature: 'coalesce(a, b, …)', description: 'First value that is not empty.' },
    { name: 'default', signature: 'default(value, fallback)', description: 'value, or fallback when value is empty.' },
    { name: 'ifNull', signature: 'ifNull(value, fallback)', description: 'value, or fallback when value is empty.' },
    { name: 'trim', signature: 'trim(text)', description: 'Remove surrounding whitespace.' },
    { name: 'concat', signature: 'concat(a, b, …)', description: 'Join values into one string.' },
    { name: 'replace', signature: 'replace(text, find, with)', description: 'Replace every occurrence of find.' },
    { name: 'split', signature: 'split(text, sep)', description: 'Split text into a list on sep.' },
    { name: 'join', signature: 'join(list, sep)', description: 'Join a list into text with sep. A record reads as "Key: value"; a single value is itself.' },
    { name: 'substring', signature: 'substring(text, start, end?)', description: 'Slice of text between start and end.' },
    { name: 'padStart', signature: 'padStart(text, length, char?)', description: 'Pad the start of text to a length.' },
    { name: 'toStr', signature: 'toStr(value)', description: 'Convert any value to text.' },
    { name: 'sumCounts', signature: 'sumCounts(text)', description: 'Add up the quantities in a breakdown like "2x M5 + 4x M8" (gives 6). Dimensions such as "100 x 80" are ignored. Nothing to count gives nothing.' },
    { name: 'first', signature: 'first(list)', description: 'First item of a list (a single value is itself).' },
    { name: 'last', signature: 'last(list)', description: 'Last item of a list (a single value is itself).' },
    { name: 'includes', signature: 'includes(list, value)', description: 'True when the list contains value (text ignores case).' },
    { name: 'count', signature: 'count(value)', description: 'Number of items in a list/text/object.' },
    { name: 'at', signature: 'at(list, index)', description: 'Item at a 0-based index (negative counts from the end). Outside the list gives nothing.' },
    { name: 'index_of', signature: 'index_of(list, value)', description: 'First 0-based index of value in the list (text ignores case), or -1.' },
    { name: 'pluck', signature: 'pluck(list, key)', description: 'One value per item: the value under key — pluck(rows, "id") gives the ids.' },
    { name: 'find', signature: 'find(list, key, value)', description: 'The first item whose key equals value, or null — find(records.orders, "id", vars.selected.id) reads the live row behind a selection.' },
    { name: 'parseJson', signature: 'parseJson(text, path?)', description: 'Parse JSON text and optionally pick a path from it (a.b, items[0].x, items[*].x). Invalid JSON gives null.' },
    { name: 'dateAdd', signature: 'dateAdd(date, n, unit)', description: 'Add n units (day/hour/…) to an ISO date.' },
    { name: 'dateDiff', signature: 'dateDiff(a, b, unit)', description: 'Whole units between two ISO dates (a − b).' },
    { name: 'formatDate', signature: 'formatDate(date, "D MMMM YYYY", locale?)', description: 'Format a date (ISO, an e-mail date, or a unix timestamp): YYYY/MM/DD/HH/mm/ss, plus D and M without a zero, MMMM/MMM for the month name and dddd/ddd for the weekday — "D MMMM YYYY" is "2 september 2026". Locale nl/en/de/fr picks the names.' },
    { name: 'formatNumber', signature: 'formatNumber(value, "amount" | "percent" | "plain", locale?, places?)', description: 'Write a number for people: "amount" gives € 1.500.000, "percent" turns 0.125 into 12,5%, "plain" gives 1.500.000. Locale nl/en/de/fr picks the separators; places pins the decimals.' },
    { name: 'yesNoText', signature: 'yesNoText(value, yesText?, noText?)', description: 'The word for a yes/no value — yesNoText(item.paid, "wel", "niet"). Unknown values give nothing.' },
    { name: 'groupSummary', signature: 'groupSummary(group)', description: 'A readable summary of a group: one "Label: value" line per field.' },
    { name: 'asTable', signature: 'asTable(rows)', description: 'A Markdown table from a list of rows — one column per field, in the order they first appear.' },
    { name: 'year', signature: 'year(date)', description: 'Year of an ISO date (UTC).' },
    { name: 'month', signature: 'month(date)', description: 'Month 1–12 of an ISO date (UTC).' },
    { name: 'day', signature: 'day(date)', description: 'Day of month of an ISO date (UTC).' },
    { name: 'weekday', signature: 'weekday(date)', description: 'Day of week 0–6 (Sun=0) of an ISO date (UTC).' },
    { name: 'isBefore', signature: 'isBefore(a, b)', description: 'True when ISO date a is before b.' },
    { name: 'isAfter', signature: 'isAfter(a, b)', description: 'True when ISO date a is after b.' },
];

export const EXPR_FUNCTION_NAMES = Object.keys(FUNCTIONS);
