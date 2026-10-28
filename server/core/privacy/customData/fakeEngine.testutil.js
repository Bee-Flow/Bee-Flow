// @typecheck noImplicitAny
'use strict';
/**
 * A stand-in for core/privacy/customTypes with the pinned interface
 * (validateTypeSpec, compileTypes, matchNode, probeGuard, migrateLegacyTerms),
 * for the bench tests. Words and patterns are matched with plain RegExps;
 * probeGuard answers from a script the test supplies. Not a copy of the
 * engine: the bench only has to prove it USES the engine, not re-implement it.
 */

const escapeRx = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * @typedef {import('../customTypes/spec').CustomDataType} CustomDataType
 * @typedef {{ entries: Array<{ id: string, re: RegExp | null }>, invalid: string[] }} FakeCompiled
 */

/**
 * @param {CustomDataType} type
 */
function matcherFor(type) {
    if (type.method === 'words') {
        const w = type.words || /** @type {Partial<CustomDataType['words']>} */ ({});
        const alt = (w.values || []).filter(Boolean).map(escapeRx).join('|');
        if (!alt) return null;
        const body = w.wholeWord ? `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])` : `(?:${alt})`;
        return new RegExp(body, `gu${w.caseSensitive ? '' : 'i'}`);
    }
    if (type.method === 'pattern') return new RegExp(type.pattern.source, `g${type.pattern.caseSensitive ? '' : 'i'}`);
    return null;
}

/**
 * @param {{ probe?: (texts: string[], labelSet: unknown) => object[], rejectPattern?: (src: string) => boolean, reservedTokenKeys?: string[] }} [opts]
 */
/**
 * @param {{ probe?: (texts: any, labelSet: any) => any[], rejectPattern?: (src: string) => boolean, reservedTokenKeys?: string[] }} [opts]
 */
function createFakeEngine({ probe = () => [], rejectPattern = (src) => src.includes('(?='), reservedTokenKeys = ['data'] } = {}) {
    /** @type {{ validate: Array<{ type: CustomDataType, opts: unknown }>, compile: string[][], match: number, probe: Array<{ texts: string[], labelSet: Record<string, string>, opts: unknown }> }} */
    const calls = { validate: [], compile: [], match: 0, probe: [] };
    return {
        calls,
        isCustomTypeId: (/** @type {unknown} */ id) => /^cdt_[0-9a-f]{10}$/.test(String(id)),
        /**
         * @param {CustomDataType} type
         * @param {unknown} opts
         */
        validateTypeSpec(type, opts) {
            calls.validate.push({ type, opts });
            /** @type {import('../customTypes/spec').CustomTypeError[]} */
            const errors = [];
            if (!type.name) errors.push({ id: type.id, field: 'name', code: 'required', message: 'A type needs a name.' });
            if (reservedTokenKeys.includes(type.tokenKey)) errors.push({ id: type.id, field: 'tokenKey', code: 'reserved', message: 'That placeholder is reserved.' });
            if (type.method === 'pattern' && rejectPattern(type.pattern?.source || '')) {
                errors.push({ id: type.id, field: 'pattern.source', code: 're2_unsupported', message: 'Lookaround is not supported.' });
            }
            if (type.method === 'ai' && !(type.ai?.prompt?.length >= 2)) errors.push({ id: type.id, field: 'ai.prompt', code: 'too_short', message: 'Too short.' });
            const normalized = { ...type };
            for (const m of /** @type {Array<'words' | 'pattern' | 'ai'>} */ (['words', 'pattern', 'ai'])) if (m !== type.method) delete normalized[m];
            return errors.length ? { ok: false, errors } : { ok: true, normalized, errors: /** @type {import('../customTypes/spec').CustomTypeError[]} */ ([]) };
        },
        /**
         * @param {CustomDataType[]} types
         * @returns {FakeCompiled}
         */
        compileTypes(types) {
            calls.compile.push(types.map((t) => t.id));
            return { entries: types.map((t) => ({ id: t.id, re: matcherFor(t) })), invalid: [] };
        },
        /**
         * @param {string} text
         * @param {FakeCompiled} compiled
         */
        matchNode(text, compiled) {
            calls.match += 1;
            /** @type {{ start: number; end: number; typeId: string; }[]} */
            const spans = [];
            for (const e of compiled.entries) {
                if (!e.re) continue;
                e.re.lastIndex = 0;
                for (const m of text.matchAll(e.re)) spans.push({ start: m.index, end: m.index + m[0].length, typeId: e.id });
            }
            return { spans, partial: false, timedOut: /** @type {string[]} */ ([]) };
        },
        /**
         * @param {string[]} texts
         * @param {Record<string, string>} labelSet
         * @param {unknown} [opts]
         */
        async probeGuard(texts, labelSet, opts) {
            calls.probe.push({ texts, labelSet, opts });
            return { candidates: probe(texts, labelSet) };
        },
        migrateLegacyTerms: (/** @type {string} */ orgId, /** @type {Array<{ term?: string }>} */ terms) => terms.map((t, i) => ({
            id: `cdt_${String(i).padStart(10, '0')}`, method: 'words', words: { values: [t.term || t], caseSensitive: false, wholeWord: true }, legacy: true, tokenKey: 'customterm',
        })),
    };
}

/**
 * Candidates for every occurrence of `word` in each text, under the label whose prompt matches.
 * @param {Array<{ prompt: string, word: string, score: number }>} rules
 */
function scriptedProbe(rules) {
    return (/** @type {string[]} */ texts, /** @type {Record<string, string>} */ labelSet) => {
        /** @type {Array<{ text_idx: number, label: string, start: number, end: number, score: number }>} */
        const out = [];
        texts.forEach((text, textIdx) => {
            for (const [id, prompt] of Object.entries(labelSet)) {
                for (const r of rules) {
                    if (r.prompt !== prompt) continue;
                    let from = 0;
                    for (;;) {
                        const at = text.indexOf(r.word, from);
                        if (at === -1) break;
                        out.push({ text_idx: textIdx, label: id, start: at, end: at + r.word.length, score: r.score });
                        from = at + r.word.length;
                    }
                }
            }
        });
        return out;
    };
}

module.exports = { createFakeEngine, scriptedProbe };
