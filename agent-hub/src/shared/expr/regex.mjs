// @typecheck strict
/**
 * The regular-expression subset of the expression language (regexMatch,
 * regexReplace): the checks every pattern passes before it compiles, the
 * compile cache and the `$` expansion of a replacement. Pure: the engine that
 * actually runs a pattern is regexEngine.mjs (RE2 on the server, the native
 * engine in the browser and on the phone), so the subset here is the one both
 * engines read the same way.
 *
 * A pattern and its flags are STRING LITERALS in the formula, checked when the
 * formula parses (checkRegexCall), so a bad pattern is a parse error the
 * validator shows, never a surprise at run time, and no value from a row can
 * become a pattern.
 *
 * Refused: longer than MAX_REGEX_PATTERN_CHARS, look-around ((?= (?! (?<= (?<!),
 * back-references (\1, \k<name>), a quantified group that holds a quantifier
 * ((a+)+, the classic catastrophic-backtracking shape), a repeated group that
 * holds an alternative ((a|aa)+, overlapping branches) and flags other than
 * i, m and s. Polynomial shapes such as a*a*b are not
 * refused: only RE2 (the server) is linear on every pattern. `u` is always on, so \p{L} and code points work in both engines.
 */
import { createRegex } from './regexEngine.mjs';

/** The longest pattern a formula may hold. */
export const MAX_REGEX_PATTERN_CHARS = 500;

/** Compiled patterns kept per process. */
const CACHE_SIZE = 256;

/** The flags an author may set. */
const ALLOWED_FLAGS = new Set(['i', 'm', 's']);

/** The functions whose second argument is a pattern, and where their flags sit. */
export const REGEX_FUNCTIONS = /** @type {const} */ ({ regexMatch: 2, regexReplace: 3 });

/**
 * A quantifier applied to a group that itself contains a quantifier:
 * (a+)+, (\w*)+$, (a?)+. The backtracking engine is exponential on those.
 * A scanner, not a parser: escapes and character classes are skipped.
 * core/text/safePattern.js re-exports it for file_intake's patterns.
 * @param {string} source
 */
export function hasNestedQuantifier(source) {
    const s = String(source || '');
    /** @type {{ quant: boolean; }[]} */
    const stack = [];
    let current = { quant: false };
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '[') { i = classEnd(s, i); continue; }
        if (ch === '(') { stack.push(current); current = { quant: false }; continue; }
        if (ch === ')') {
            const closed = current;
            current = stack.pop() || { quant: false };
            const groupQuantified = isQuantifier(s[i + 1]);
            if (groupQuantified && closed.quant) return true;
            // The parent now contains a quantifier if this group carried or
            // received one: (…(a+)…)+ nests just as fatally one level up.
            if (closed.quant || groupQuantified) current.quant = true;
            continue;
        }
        if (isQuantifier(ch)) current.quant = true;
    }
    return false;
}

/**
 * A group repeated without bound (`*`, `+`, `{n,…}`) whose body holds an
 * alternative `|`, at any depth: (a|aa)+, (\w|\d)+x, ((a|b)c)*. The branches
 * may overlap, and the backtracking engine in the browser and on the phone is
 * exponential on that ((\w|\d)+x took 9 s on 26 digits). `?` is not a repeat.
 * Kept apart from hasNestedQuantifier, whose verdicts file_intake relies on.
 * @param {string} source
 */
export function hasRepeatedAlternation(source) {
    const s = String(source || '');
    /** @type {{ alt: boolean; }[]} */
    const stack = [];
    let current = { alt: false };
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '[') { i = classEnd(s, i); continue; }
        if (ch === '|') { current.alt = true; continue; }
        if (ch === '(') { stack.push(current); current = { alt: false }; continue; }
        if (ch === ')') {
            const closed = current;
            current = stack.pop() || { alt: false };
            const next = s[i + 1];
            if (closed.alt && (next === '*' || next === '+' || next === '{')) return true;
            if (closed.alt) current.alt = true;
        }
    }
    return false;
}

/** @param {string | undefined} ch */
function isQuantifier(ch) {
    return ch === '*' || ch === '+' || ch === '?' || ch === '{';
}

/**
 * The index of the `]` that closes the character class opened at `i`.
 * @param {string} s @param {number} i
 */
function classEnd(s, i) {
    let j = i + 1;
    while (j < s.length && s[j] !== ']') { if (s[j] === '\\') j += 1; j += 1; }
    return j;
}

/**
 * Look-around or a back-reference outside a character class: RE2 has neither,
 * so a pattern that uses one would work in the browser and fail on the server.
 * @param {string} s
 * @returns {string | null}
 */
function unsupportedSyntax(s) {
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (ch === '\\') {
            const problem = escapeProblem(s[i + 1], s[i + 2]);
            if (problem) return problem;
            i += 1;
        } else if (ch === '[') {
            i = classEnd(s, i);
        } else if (ch === '(' && s[i + 1] === '?' && isLookAround(s[i + 2], s[i + 3])) {
            return 'look-ahead and look-behind are not supported';
        }
    }
    return null;
}

/** @param {string | undefined} n @param {string | undefined} after */
function escapeProblem(n, after) {
    if (n !== undefined && n >= '1' && n <= '9') return 'back-references (\\1) are not supported';
    if (n === 'k' && after === '<') return 'back-references (\\k<name>) are not supported';
    return null;
}

/** @param {string | undefined} a @param {string | undefined} b */
function isLookAround(a, b) {
    return a === '=' || a === '!' || (a === '<' && (b === '=' || b === '!'));
}

/**
 * Why a pattern and its flags cannot be used, or null when they can.
 * @param {unknown} pattern
 * @param {unknown} flags
 * @returns {string | null}
 */
export function regexProblem(pattern, flags) {
    if (typeof pattern !== 'string') return 'the pattern must be a text';
    if (pattern === '') return 'the pattern is empty';
    if (pattern.length > MAX_REGEX_PATTERN_CHARS) return `the pattern is longer than ${MAX_REGEX_PATTERN_CHARS} characters`;
    if (flags != null && typeof flags !== 'string') return 'the flags must be a text';
    for (const f of String(flags ?? '')) {
        if (!ALLOWED_FLAGS.has(f)) return `unknown flag "${f}"; use i, m or s`;
    }
    const syntax = unsupportedSyntax(pattern);
    if (syntax) return syntax;
    if (hasNestedQuantifier(pattern)) return 'a repeated group may not hold a repeat itself, like (a+)+';
    if (hasRepeatedAlternation(pattern)) return 'a repeated group may not hold an alternative, like (a|b)+; write a character class such as [ab]+';
    try {
        createRegex(pattern, normalizeFlags(flags));
    } catch {
        return 'the pattern is not a valid regular expression';
    }
    return null;
}

/**
 * The flags as the engine gets them: deduplicated, sorted, `u` always on.
 * @param {unknown} flags
 */
function normalizeFlags(flags) {
    const set = new Set(String(flags ?? ''));
    return `${[...set].filter((f) => ALLOWED_FLAGS.has(f)).sort().join('')}u`;
}

/**
 * Parse-time check of a regexMatch / regexReplace call: the pattern (and the
 * flags when given) must be text literals that regexProblem accepts.
 * Returns the args untouched, or throws the caller's error type.
 * @template T
 * @param {{ v: string, i: number }} tk the function-name token
 * @param {T} args
 * @param {new (message: string, index: number) => Error} ErrorType
 * @returns {T}
 */
export function checkRegexCall(tk, args, ErrorType) {
    if (!Object.prototype.hasOwnProperty.call(REGEX_FUNCTIONS, tk.v)) return args;
    const list = /** @type {Array<{ kind: string, v?: unknown }>} */ (/** @type {unknown} */ (args));
    const flagsAt = REGEX_FUNCTIONS[/** @type {keyof typeof REGEX_FUNCTIONS} */ (tk.v)];
    const pattern = list[1];
    if (!pattern || pattern.kind !== 'str') {
        throw new ErrorType(`${tk.v}(): the pattern must be written as a text in quotes`, tk.i);
    }
    const flags = list[flagsAt];
    if (flags && flags.kind !== 'str') {
        throw new ErrorType(`${tk.v}(): the flags must be written as a text in quotes`, tk.i);
    }
    if (list.length > flagsAt + 1) throw new ErrorType(`${tk.v}() takes at most ${flagsAt + 1} arguments`, tk.i);
    // The pattern is read from the source text of the literal, not from its
    // unescaped value: `\d`, `\s` and `\b` mean what they mean in a regex. A
    // doubled backslash is one backslash, so `"\\d+"` (the JSON way of writing
    // it) and `"\d+"` are the same pattern, and an escaped quote is a quote
    // (`\"` is not a valid escape under the u flag).
    const raw = typeof (/** @type {any} */ (pattern)).raw === 'string' ? /** @type {any} */ (pattern).raw : String(pattern.v);
    const source = raw.replace(/\\([\s\S])/g, (/** @type {string} */ m, /** @type {string} */ c) => (c === '\\' || c === '"' || c === "'" ? c : m));
    const problem = regexProblem(source, flags ? flags.v : undefined);
    if (problem) throw new ErrorType(`${tk.v}(): ${problem}`, tk.i);
    list[1] = /** @type {any} */ ({ ...pattern, v: source });
    return args;
}

/** @type {Map<string, { plain: any, global: any }>} */
const cache = new Map();

/**
 * The compiled pattern (re-checked, cached). Throws when regexProblem refuses it.
 * @param {unknown} pattern
 * @param {unknown} flags
 * @returns {{ plain: any, global: any }}
 */
export function compiledRegex(pattern, flags) {
    const f = normalizeFlags(flags);
    const key = `${f}/${String(pattern)}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const problem = regexProblem(pattern, flags);
    if (problem) throw new Error(problem);
    const entry = { plain: createRegex(String(pattern), f), global: createRegex(String(pattern), `${f}g`) };
    if (cache.size >= CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, entry);
    return entry;
}

/**
 * A replacement with its `$` forms expanded: `$$` is a dollar, `$&` the match,
 * `$1`..`$99` a group (a group past the pattern's count stays as written, an
 * unmatched group is empty). Written out here instead of left to the engine,
 * so RE2 and the native engine cannot expand differently.
 * @param {string} repl
 * @param {string} match
 * @param {Array<string | undefined>} groups
 */
export function expandReplacement(repl, match, groups) {
    if (!repl.includes('$')) return repl;
    let out = '';
    for (let i = 0; i < repl.length; i += 1) {
        const ch = repl[i];
        if (ch !== '$' || i + 1 >= repl.length) { out += ch; continue; }
        const n = repl[i + 1];
        if (n === '$') { out += '$'; i += 1; continue; }
        if (n === '&') { out += match; i += 1; continue; }
        if (/[0-9]/.test(n)) {
            const two = repl.slice(i + 1, i + 3);
            if (/^[0-9]{2}$/.test(two) && Number(two) >= 1 && Number(two) <= groups.length) {
                out += groups[Number(two) - 1] ?? '';
                i += 2;
                continue;
            }
            const one = Number(n);
            if (one >= 1 && one <= groups.length) {
                out += groups[one - 1] ?? '';
                i += 1;
                continue;
            }
        }
        out += ch;
    }
    return out;
}
