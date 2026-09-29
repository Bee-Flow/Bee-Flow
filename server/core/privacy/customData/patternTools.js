'use strict';
/**
 * Pattern helpers for the "Your own data" test bench: is a pattern safe to
 * save, does it match every example completely, what pattern do the examples
 * suggest, and how do we say that pattern in words.
 *
 * validatePattern runs the cheap local rules first (length, compiles, no
 * nested quantifier, no empty match) and then asks the ENGINE
 * (core/privacy/customTypes validateTypeSpec, which compiles under RE2): the
 * engine's matcher is what production runs, so its verdict is the one that
 * counts. The local rules only make the common refusals fast and readable.
 *
 * inferPatternFromExamples is deterministic, no model involved. It takes the
 * literal prefix and suffix every example shares, splits the rest on
 * separator characters, and describes each field by its character classes:
 *   KL-12345, KL-99812  →  KL-\d{5}
 *   KL-123,   KL-45678  →  KL-\d{3,5}
 * It returns a strict variant (class runs per field) and a loose one (one
 * class per field), each with and without \b. describePattern reads back
 * exactly that grammar and nothing else.
 */

const { hasNestedQuantifier } = require('../../text/safePattern');

const MAX_PATTERN_CHARS = 300;
const EMPTY_MATCH_PROBES = ['', ' ', 'a', 'A1 b-2', '-'];
const PROBE_TYPE_ID = 'cdt_0000000000';

function compile(source, caseSensitive, extraFlags = '') {
    try {
        return new RegExp(source, `${caseSensitive ? '' : 'i'}${extraFlags}`);
    } catch (_) {
        return null;
    }
}

/**
 * The local rules alone, synchronous: length, compiles, no nested
 * quantifier, no empty match.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function localPatternCheck(source, caseSensitive) {
    if (typeof source !== 'string' || !source.trim()) return { ok: false, reason: 'empty' };
    if (source.length > MAX_PATTERN_CHARS) return { ok: false, reason: 'too_long' };
    const re = compile(source, caseSensitive, 'g');
    if (!re) return { ok: false, reason: 'does_not_compile' };
    if (hasNestedQuantifier(source)) return { ok: false, reason: 'nested_quantifier' };
    for (const probe of EMPTY_MATCH_PROBES) {
        re.lastIndex = 0;
        for (const m of probe.matchAll(re)) {
            if (m[0].length === 0) return { ok: false, reason: 'matches_empty' };
        }
    }
    return { ok: true };
}

/**
 * The local rules, then the engine's own validation (RE2). Async because the
 * engine's validation may be.
 * @param {string} source
 * @param {boolean} caseSensitive
 * @param {{ engine?: { validateTypeSpec?: Function } }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function validatePattern(source, caseSensitive, { engine = null } = {}) {
    const local = localPatternCheck(source, caseSensitive);
    if (!local.ok) return local;
    if (engine && typeof engine.validateTypeSpec === 'function') {
        let verdict;
        try {
            verdict = await engine.validateTypeSpec({
                id: PROBE_TYPE_ID,
                name: 'Pattern check',
                description: '',
                method: 'pattern',
                tokenKey: 'pattern_check',
                pattern: { source, caseSensitive: !!caseSensitive, engine: 're2' },
                origin: 'created',
            }, { orgId: null, existingTypes: [] });
        } catch (_) {
            return { ok: false, reason: 'check_failed' };
        }
        if (!verdict || !verdict.ok) {
            const errors = Array.isArray(verdict?.errors) ? verdict.errors : [];
            const patternError = errors.find((e) => String(e?.field || '').startsWith('pattern'));
            // Errors about the probe's own name or tokenKey are not about the pattern.
            if (patternError || errors.length === 0) {
                return { ok: false, reason: String(patternError?.code || 'pattern_invalid') };
            }
        }
    }
    return { ok: true };
}

/** Does `source` match EVERY example completely (anchored ^(?:source)$)? Vacuously true for none. */
function fullMatchAll(source, examples, { caseSensitive = true } = {}) {
    if (typeof source !== 'string' || !source) return false;
    const re = compile(`^(?:${source})$`, caseSensitive);
    if (!re) return false;
    return (Array.isArray(examples) ? examples : []).every((e) => typeof e === 'string' && re.test(e));
}

// ── Inference ───────────────────────────────────────────────────────────────

const isAlnum = (ch) => /[A-Za-z0-9]/.test(ch || '');
const classOf = (ch) => (/[0-9]/.test(ch) ? 'D' : /[A-Z]/.test(ch) ? 'U' : /[a-z]/.test(ch) ? 'L' : null);

/** Escape a literal for use outside a character class (never escapes '-'). */
const escapeLiteral = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Escape a character for use inside a character class. */
const escapeInClass = (ch) => (/[\]\\^-]/.test(ch) ? `\\${ch}` : ch);

function commonPrefixLen(values) {
    let i = 0;
    for (;;) {
        const ch = values[0][i];
        if (ch === undefined || values.some((v) => v[i] !== ch)) return i;
        i += 1;
    }
}

/**
 * The shared literal prefix, cut back so it never ends inside a character run
 * that continues differently in some example ("KL-1" of KL-12345/KL-19812
 * becomes "KL-": the 1 belongs to the number, not to the format).
 */
function literalPrefix(values) {
    let p = commonPrefixLen(values);
    if (p > 0) {
        const lastClass = classOf(values[0][p - 1]);
        if (lastClass && values.some((v) => classOf(v[p]) === lastClass)) {
            while (p > 0 && classOf(values[0][p - 1]) === lastClass) p -= 1;
        }
    }
    return values[0].slice(0, p);
}

function literalSuffix(values) {
    const rev = values.map((v) => v.split('').reverse().join(''));
    return literalPrefix(rev).split('').reverse().join('');
}

/** Split a middle part into alnum fields and the separators between them. */
function fields(middle) {
    const parts = [];
    const seps = [];
    let cur = '';
    for (const ch of middle) {
        if (isAlnum(ch)) { cur += ch; continue; }
        parts.push(cur);
        seps.push(ch);
        cur = '';
    }
    parts.push(cur);
    return { parts, seps };
}

/** Class runs of one field: "AB12" → [['U',2],['D',2]]. */
function runs(field) {
    const out = [];
    for (const ch of field) {
        const c = classOf(ch);
        const last = out[out.length - 1];
        if (last && last[0] === c) last[1] += 1;
        else out.push([c, 1]);
    }
    return out;
}

const CLASS_SRC = { D: '\\d', U: '[A-Z]', L: '[a-z]' };

function quant(min, max) {
    if (min === max) return min === 1 ? '' : `{${min}}`;
    return `{${min},${max}}`;
}

/** One class covering every character of a field across all examples. */
function unionClass(chars) {
    const hasD = chars.some((c) => classOf(c) === 'D');
    const hasU = chars.some((c) => classOf(c) === 'U');
    const hasL = chars.some((c) => classOf(c) === 'L');
    if (hasD && !hasU && !hasL) return '\\d';
    if (!hasD && hasU && !hasL) return '[A-Z]';
    if (!hasD && !hasU && hasL) return '[a-z]';
    if (!hasD) return '[A-Za-z]';
    return '[A-Za-z0-9]';
}

function strictField(values) {
    const all = values.map(runs);
    const shape = all[0].map((r) => r[0]).join('');
    if (!all.every((r) => r.map((x) => x[0]).join('') === shape)) return looseField(values);
    return all[0].map((r, i) => {
        const lens = all.map((x) => x[i][1]);
        return `${CLASS_SRC[r[0]]}${quant(Math.min(...lens), Math.max(...lens))}`;
    }).join('');
}

function looseField(values) {
    const lens = values.map((v) => v.length);
    const min = Math.min(...lens);
    const max = Math.max(...lens);
    if (max === 0) return '';
    const cls = unionClass(values.join('').split(''));
    // A field that is empty in some example becomes optional by its minimum.
    return `${cls}${quant(min, max)}`;
}

function withBoundaries(src, first, last) {
    return `${isAlnum(first) ? '\\b' : ''}${src}${isAlnum(last) ? '\\b' : ''}`;
}

/**
 * @param {string[]} examples  the real examples
 * @param {boolean} caseSensitive
 * @returns {string[]} distinct pattern sources, strict first; [] when there is nothing to infer
 */
function inferPatternFromExamples(examples, caseSensitive) {
    let values = [...new Set((Array.isArray(examples) ? examples : [])
        .filter((e) => typeof e === 'string').map((e) => e.trim()).filter(Boolean))];
    if (!caseSensitive) {
        // Case-insensitive: fold to one case so "KL-1" and "kl-2" share a prefix.
        values = [...new Set(values.map((v) => v.toUpperCase()))];
    }
    if (values.length === 0) return [];
    if (values.some((v) => /[^\x20-\x7e]/.test(v))) return [];
    const prefix = literalPrefix(values);
    const restAfterPrefix = values.map((v) => v.slice(prefix.length));
    const suffix = restAfterPrefix.every((r) => r.length > 0) ? literalSuffix(restAfterPrefix) : '';
    const middles = restAfterPrefix.map((r) => r.slice(0, r.length - suffix.length));

    const split = middles.map(fields);
    const sepKey = split[0].seps.join('\u0000');
    const aligned = split.every((s) => s.seps.join('\u0000') === sepKey);
    const pre = escapeLiteral(prefix);
    const post = escapeLiteral(suffix);

    const variants = [];
    if (aligned) {
        const build = (fieldFn) => {
            let src = '';
            split[0].parts.forEach((_, i) => {
                src += fieldFn(split.map((s) => s.parts[i]));
                if (i < split[0].seps.length) src += escapeLiteral(split[0].seps[i]);
            });
            return `${pre}${src}${post}`;
        };
        variants.push(build(strictField), build(looseField));
    } else {
        const lens = middles.map((m) => m.length);
        const sepChars = [...new Set(middles.join('').split('').filter((c) => !isAlnum(c)))];
        const cls = `[A-Za-z0-9${sepChars.map(escapeInClass).join('')}]`;
        variants.push(`${pre}${cls}${quant(Math.min(...lens), Math.max(...lens))}${post}`);
    }
    const out = [];
    for (const v of variants) {
        if (!v) continue;
        const first = values[0][0];
        const last = values[0][values[0].length - 1];
        for (const src of [v, withBoundaries(v, first, last)]) {
            if (!out.includes(src) && fullMatchAll(src, values, { caseSensitive })) out.push(src);
        }
    }
    return out;
}

// ── In words ────────────────────────────────────────────────────────────────

const CLASS_WORDS = {
    '\\d': ['digit', 'digits'],
    '[A-Z]': ['capital letter', 'capital letters'],
    '[a-z]': ['lowercase letter', 'lowercase letters'],
    '[A-Za-z]': ['letter', 'letters'],
    '[A-Za-z0-9]': ['letter or digit', 'letters or digits'],
};

/**
 * "KL-\d{5}" → "KL- followed by 5 digits". Only the grammar the inference
 * writes (literals, \b, the classes above and {n} / {n,m} counts); anything
 * else returns null rather than a wrong sentence.
 */
function describePattern(source) {
    if (typeof source !== 'string' || !source) return null;
    const parts = [];
    let literal = '';
    const flush = () => { if (literal) { parts.push(literal); literal = ''; } };
    let i = 0;
    while (i < source.length) {
        if (source.startsWith('\\b', i)) { i += 2; continue; }
        const cls = Object.keys(CLASS_WORDS).find((c) => source.startsWith(c, i));
        if (cls) {
            i += cls.length;
            let min = 1;
            let max = 1;
            const q = /^\{(\d+)(?:,(\d+))?\}/.exec(source.slice(i));
            if (q) {
                min = Number(q[1]);
                max = q[2] === undefined ? min : Number(q[2]);
                i += q[0].length;
            } else if (/^[*+?{]/.test(source.slice(i))) {
                return null;
            }
            flush();
            const [one, many] = CLASS_WORDS[cls];
            const count = min === max ? String(min) : `${min} to ${max}`;
            parts.push(`${count} ${min === max && min === 1 ? one : many}`);
            continue;
        }
        const ch = source[i];
        if (ch === '\\') {
            const next = source[i + 1];
            if (next === undefined || /[A-Za-z0-9]/.test(next)) return null;
            literal += next;
            i += 2;
            continue;
        }
        if (/[.*+?^${}()|[\]]/.test(ch)) return null;
        literal += ch;
        i += 1;
    }
    flush();
    return parts.length ? parts.join(' followed by ') : null;
}

module.exports = {
    MAX_PATTERN_CHARS,
    localPatternCheck,
    validatePattern,
    fullMatchAll,
    inferPatternFromExamples,
    describePattern,
};
