// @typecheck strict
'use strict';
/**
 * Patterns an author or an admin wrote, run on text that users and outside
 * senders control: a guardrail rule over a chat message, a mail trigger's
 * subject filter, a redaction in an automation. A pattern with nested
 * quantifiers makes V8's backtracking engine take exponential time on crafted
 * text, and all of these run on the server's one event loop.
 *
 * So every such pattern compiles here, under RE2 (linear time, cannot
 * backtrack) whenever RE2 accepts it. RE2 has no lookaround and no
 * backreferences; a pattern that needs them falls back to the native engine
 * only when safePattern.js finds no nested quantifier, and then never on the
 * event loop: the privacy worker (customTypes/legacyRunner.js) runs it with a
 * time budget and cools a pattern down that overran it. A caller gets
 * `null` where the answer could not be decided and chooses its own safe side.
 *
 * compileUserPattern is also the save-time check: a pattern it refuses is
 * refused where it is written (the automation validator, the guardrail
 * configuration, the rule generator), with the reason.
 *
 * The native fallback's budget is USER_PATTERN_BUDGET_MS (default 250);
 * 0 runs the fallback on the event loop without one.
 */

const crypto = require('crypto');
const RE2 = require('re2');
const log = require('../../telemetry/log');
const { bestEffort, fallback } = require('../../utils/bestEffort');
const { hasNestedQuantifier } = require('./safePattern');

const DEFAULT_BUDGET_MS = 250;
const MAX_CACHED = 500;

/**
 * @typedef {{ ok: true, engine: 're2', re: RE2, global: RE2 | null, source: string, flags: string }} CompiledRe2
 * @typedef {{ ok: true, engine: 'native', id: string, source: string, flags: string }} CompiledNative
 * @typedef {{ ok: false, reason: 'empty' | 'nested_quantifier' | 'does_not_compile', message: string }} Refused
 * @typedef {CompiledRe2 | CompiledNative | Refused} CompiledUserPattern
 */

/** @type {Map<string, CompiledUserPattern>} */
const cache = new Map();

function budgetMs() {
    const raw = process.env.USER_PATTERN_BUDGET_MS;
    if (raw === undefined || raw === '') return DEFAULT_BUDGET_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_BUDGET_MS;
}

/**
 * The inline flag groups some admins write at the front, (?i) and (?-x),
 * which V8 does not know; case folding is a flag here.
 * @param {string} pattern
 */
function stripInlineFlags(pattern) {
    return pattern.replace(/^\(\?i\)/, '').replace(/^\(\?-[a-z]+\)/, '');
}

/**
 * @param {string} source
 * @param {string} flags
 * @returns {CompiledUserPattern}
 */
function compileUncached(source, flags) {
    try {
        return { ok: true, engine: 're2', re: new RE2(source, flags), global: null, source, flags };
    } catch (err) {
        // RE2 has no lookaround or backreference: the native engine, guarded, is next.
        bestEffort('userPattern:re2-refused', err); // RE2 has no lookaround or backreference: the native engine, guarded, is next
    }
    if (hasNestedQuantifier(source)) {
        return { ok: false, reason: 'nested_quantifier', message: 'A repeated group that itself repeats, such as (a+)+, can stall on crafted text. Rewrite the pattern without the nesting.' };
    }
    try {
        void new RegExp(source, flags);
    } catch (err) {
        return fallback('userPattern:does-not-compile', err, { ok: false, reason: 'does_not_compile', message: `Not a valid pattern: ${/** @type {Error} */ (err).message}` });
    }
    const id = crypto.createHash('sha256').update(`${flags}:${source}`).digest('hex').slice(0, 24);
    return { ok: true, engine: 'native', id, source, flags };
}

/**
 * Compile once per pattern and flag set; the result is cached (bounded).
 * @param {unknown} pattern
 * @param {{ caseInsensitive?: boolean }} [opts]
 * @returns {CompiledUserPattern}
 */
function compileUserPattern(pattern, { caseInsensitive = true } = {}) {
    if (typeof pattern !== 'string' || !pattern.trim()) {
        return { ok: false, reason: 'empty', message: 'The pattern is empty.' };
    }
    const flags = caseInsensitive ? 'i' : '';
    const key = `${flags}:${pattern}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const compiled = compileUncached(stripInlineFlags(pattern), flags);
    if (cache.size >= MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, compiled);
    return compiled;
}

/**
 * The spans a native-engine pattern matches, found off the event loop within
 * the budget; null when it could not be decided (budget overrun, failure).
 * @param {CompiledNative} compiled
 * @param {string} text
 * @returns {{ start: number, end: number }[] | null}
 */
function nativeSpans(compiled, text) {
    const budget = budgetMs();
    if (budget === 0) {
        const re = new RegExp(compiled.source, `${compiled.flags}g`);
        /** @type {{ start: number, end: number }[]} */
        const spans = [];
        for (const m of text.matchAll(re)) {
            if (m[0].length > 0) spans.push({ start: m.index, end: m.index + m[0].length });
        }
        return spans;
    }
    const { runLegacySync } = require('../privacy/customTypes/legacyRunner');
    const caseSensitive = !compiled.flags.includes('i');
    const { results, timedOut, failed } = runLegacySync([{ id: compiled.id, source: compiled.source, caseSensitive }], text, budget);
    if (timedOut.length || failed.length) {
        log.warn(`[UserPattern] a pattern could not be decided within ${budget} ms; its caller takes the safe side`);
        return null;
    }
    return results.get(compiled.id) || [];
}

/**
 * Does the pattern match anywhere in `text`? null when undecidable.
 * @param {CompiledUserPattern} compiled
 * @param {string} text
 * @returns {boolean | null}
 */
function testUserPattern(compiled, text) {
    if (!compiled.ok) return null;
    if (compiled.engine === 're2') return compiled.re.test(text);
    const spans = nativeSpans(compiled, text);
    return spans ? spans.length > 0 : null;
}

/**
 * Every match of the pattern in `text` (non-empty ones), at most `limit`;
 * null when undecidable.
 * @param {CompiledUserPattern} compiled
 * @param {string} text
 * @param {number} [limit]
 * @returns {{ match: string, index: number }[] | null}
 */
function findUserPatternMatches(compiled, text, limit = 20) {
    if (!compiled.ok) return null;
    if (compiled.engine === 'native') {
        const spans = nativeSpans(compiled, text);
        return spans ? spans.slice(0, limit).map((s) => ({ match: text.slice(s.start, s.end), index: s.start })) : null;
    }
    const re = globalRe2(compiled);
    re.lastIndex = 0;
    /** @type {{ match: string, index: number }[]} */
    const out = [];
    let m;
    while (out.length < limit && (m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex = m.index + 1; continue; }
        out.push({ match: m[0], index: m.index });
    }
    return out;
}

/** @param {CompiledRe2} compiled */
function globalRe2(compiled) {
    if (!compiled.global) compiled.global = new RE2(compiled.source, `${compiled.flags}g`);
    return compiled.global;
}

/**
 * `text` with every match replaced by `replacement` (a plain string, as
 * String#replace reads it); null when undecidable.
 * @param {CompiledUserPattern} compiled
 * @param {string} text
 * @param {string} replacement
 * @returns {string | null}
 */
function replaceUserPattern(compiled, text, replacement) {
    if (!compiled.ok) return null;
    if (compiled.engine === 're2') return text.replace(globalRe2(compiled), replacement);
    const spans = nativeSpans(compiled, text);
    if (!spans) return null;
    let out = '';
    let last = 0;
    for (const s of spans) {
        out += text.slice(last, s.start) + replacement;
        last = s.end;
    }
    return out + text.slice(last);
}

/** Test seam. */
function _resetUserPatternCache() { cache.clear(); }

module.exports = { compileUserPattern, testUserPattern, findUserPatternMatches, replaceUserPattern, stripInlineFlags, _resetUserPatternCache, DEFAULT_BUDGET_MS };
