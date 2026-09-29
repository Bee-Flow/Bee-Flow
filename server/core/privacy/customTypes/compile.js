// @typecheck
'use strict';
/**
 * Compile a set of "Your own data" types into matchers.
 *
 *   words    → one Aho-Corasick automaton per case rule (ahoCorasick.js)
 *   pattern  → RE2 (linear time) or, for a migrated V8-only pattern, a job
 *              for the worker in legacyRunner.js
 *   ai       → nothing to compile here: the guard runs it (custom_labels)
 *
 * Never throws. A type with `status: 'invalid'` is not enforced and a type
 * whose matcher cannot be built is skipped; both are listed in `invalid`
 * with a reason, so a caller can tell "switched off" from "broken".
 */

const RE2 = require('re2');
const { AhoCorasick, foldString } = require('./ahoCorasick');

const KIND = 'compiled-custom-types';

/**
 * @param {string} source
 * @param {boolean} caseSensitive
 * @returns {{ re?: any, error?: string }}
 */
function re2Compile(source, caseSensitive) {
    try {
        return { re: new RE2(String(source), caseSensitive ? 'gu' : 'giu') };
    } catch (err) {
        return { error: String(err?.message || err).slice(0, 200) };
    }
}

/**
 * @param {string} source
 * @param {boolean} caseSensitive
 * @returns {{ ok: boolean, error?: string }}
 */
function v8Compile(source, caseSensitive) {
    try {
        // Compiled here only to validate; it runs in the worker.
        void new RegExp(String(source), caseSensitive ? 'g' : 'gi');
        return { ok: true };
    } catch (err) {
        return { ok: false, error: String(err?.message || err).slice(0, 200) };
    }
}

const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;
/** Is this ONE code point (a string of one or two code units) a letter, digit or mark? */
const isWordChar = (ch) => !!ch && WORD_CHAR.test(ch);

/** The code point that ends at `end` (exclusive), as a string. */
function codePointBefore(s, end) {
    if (end <= 0) return '';
    const c = s.charCodeAt(end - 1);
    if (c >= 0xDC00 && c <= 0xDFFF && end >= 2) {
        const hi = s.charCodeAt(end - 2);
        if (hi >= 0xD800 && hi <= 0xDBFF) return s.slice(end - 2, end);
    }
    return s.charAt(end - 1);
}

/** The code point that starts at `start`, as a string. */
function codePointAt(s, start) {
    if (start >= s.length) return '';
    const cp = s.codePointAt(start);
    return cp === undefined ? '' : String.fromCodePoint(cp);
}

/**
 * @param {Array<any>} types
 */
function compileTypes(types) {
    const list = Array.isArray(types) ? types : [];
    /** @type {Map<string, any>} */
    const byId = new Map();
    /** @type {Map<string, number>} */
    const order = new Map();
    const cs = new AhoCorasick();
    const ci = new AhoCorasick();
    const patterns = [];
    const legacy = [];
    const ai = [];
    const invalid = [];

    list.forEach((type, index) => {
        const id = type && type.id;
        if (!id || byId.has(id)) return;
        if (type.status === 'invalid') { invalid.push({ id, reason: 'status_invalid' }); return; }
        byId.set(id, type);
        order.set(id, index);
        try {
            if (type.method === 'words') {
                const w = type.words || {};
                const values = Array.isArray(w.values) ? w.values.filter(v => typeof v === 'string' && v.length > 0) : [];
                if (!values.length) { invalid.push({ id, reason: 'compile_failed' }); byId.delete(id); return; }
                const caseSensitive = w.caseSensitive === true;
                const wholeWord = w.wholeWord === true;
                for (const value of values) {
                    const payload = {
                        id,
                        len: value.length,
                        wholeWord,
                        // `\b` semantics: only an edge that IS a word character
                        // needs a non-word neighbour.
                        edgeStart: isWordChar(codePointAt(value, 0)),
                        edgeEnd: isWordChar(codePointBefore(value, value.length)),
                    };
                    if (caseSensitive) cs.add(value, payload);
                    else ci.add(foldString(value), payload);
                }
            } else if (type.method === 'pattern') {
                const p = type.pattern || {};
                const caseSensitive = p.caseSensitive === true;
                if (p.engine === 'v8-legacy') {
                    const v8 = v8Compile(p.source, caseSensitive);
                    if (!v8.ok) { invalid.push({ id, reason: 'compile_failed' }); byId.delete(id); return; }
                    legacy.push({ id, source: String(p.source), caseSensitive });
                } else {
                    const { re, error } = re2Compile(p.source, caseSensitive);
                    if (error || !re) { invalid.push({ id, reason: 'compile_failed' }); byId.delete(id); return; }
                    patterns.push({ id, re });
                }
            } else if (type.method === 'ai') {
                const a = type.ai || {};
                ai.push({ id, prompt: String(a.prompt || ''), floor: Number(a.floor) });
            } else {
                invalid.push({ id, reason: 'compile_failed' });
                byId.delete(id);
            }
        } catch (_) {
            invalid.push({ id, reason: 'compile_failed' });
            byId.delete(id);
        }
    });

    return {
        kind: KIND,
        types: byId,
        order,
        words: { cs: cs.size ? cs.build() : null, ci: ci.size ? ci.build() : null },
        patterns,
        legacy,
        ai,
        invalid,
    };
}

function isCompiled(x) {
    return !!x && typeof x === 'object' && x.kind === KIND;
}

module.exports = { compileTypes, isCompiled, re2Compile, v8Compile, isWordChar, codePointAt, codePointBefore };
