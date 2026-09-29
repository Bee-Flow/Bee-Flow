'use strict';
/**
 * A stand-in for core/privacy/customTypes with the pinned interface
 * (validateTypeSpec, compileTypes, matchNode, probeGuard, migrateLegacyTerms),
 * for the bench tests. Words and patterns are matched with plain RegExps;
 * probeGuard answers from a script the test supplies. Not a copy of the
 * engine: the bench only has to prove it USES the engine, not re-implement it.
 */

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function matcherFor(type) {
    if (type.method === 'words') {
        const w = type.words || {};
        const alt = (w.values || []).filter(Boolean).map(escapeRx).join('|');
        if (!alt) return null;
        const body = w.wholeWord ? `(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])` : `(?:${alt})`;
        return new RegExp(body, `gu${w.caseSensitive ? '' : 'i'}`);
    }
    if (type.method === 'pattern') return new RegExp(type.pattern.source, `g${type.pattern.caseSensitive ? '' : 'i'}`);
    return null;
}

function createFakeEngine({ probe = () => [], rejectPattern = (src) => src.includes('(?='), reservedTokenKeys = ['data'] } = {}) {
    const calls = { validate: [], compile: [], match: 0, probe: [] };
    return {
        calls,
        isCustomTypeId: (id) => /^cdt_[0-9a-f]{10}$/.test(String(id)),
        validateTypeSpec(type, opts) {
            calls.validate.push({ type, opts });
            const errors = [];
            if (!type.name) errors.push({ id: type.id, field: 'name', code: 'required', message: 'A type needs a name.' });
            if (reservedTokenKeys.includes(type.tokenKey)) errors.push({ id: type.id, field: 'tokenKey', code: 'reserved', message: 'That placeholder is reserved.' });
            if (type.method === 'pattern' && rejectPattern(type.pattern?.source || '')) {
                errors.push({ id: type.id, field: 'pattern.source', code: 're2_unsupported', message: 'Lookaround is not supported.' });
            }
            if (type.method === 'ai' && !(type.ai?.prompt?.length >= 2)) errors.push({ id: type.id, field: 'ai.prompt', code: 'too_short', message: 'Too short.' });
            const normalized = { ...type };
            for (const m of ['words', 'pattern', 'ai']) if (m !== type.method) delete normalized[m];
            return errors.length ? { ok: false, errors } : { ok: true, normalized, errors: [] };
        },
        compileTypes(types) {
            calls.compile.push(types.map((t) => t.id));
            return { entries: types.map((t) => ({ id: t.id, re: matcherFor(t) })), invalid: [] };
        },
        matchNode(text, compiled) {
            calls.match += 1;
            const spans = [];
            for (const e of compiled.entries) {
                if (!e.re) continue;
                e.re.lastIndex = 0;
                for (const m of text.matchAll(e.re)) spans.push({ start: m.index, end: m.index + m[0].length, typeId: e.id });
            }
            return { spans, partial: false, timedOut: [] };
        },
        async probeGuard(texts, labelSet, opts) {
            calls.probe.push({ texts, labelSet, opts });
            return { candidates: probe(texts, labelSet) };
        },
        migrateLegacyTerms: (orgId, terms) => terms.map((t, i) => ({
            id: `cdt_${String(i).padStart(10, '0')}`, method: 'words', words: { values: [t.term || t], caseSensitive: false, wholeWord: true }, legacy: true, tokenKey: 'customterm',
        })),
    };
}

/** Candidates for every occurrence of `word` in each text, under the label whose prompt matches. */
function scriptedProbe(rules) {
    return (texts, labelSet) => {
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
