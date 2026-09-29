// @typecheck
'use strict';
/**
 * The old "Always hide these" list (`customSensitiveTerms`) as types, and
 * back again.
 *
 *   migrateLegacyTerms   term → type, deterministic id (ids.legacyTypeId), so
 *                        the lazy migration on every read and the one written
 *                        on save agree. Semantics are the old scanner's
 *                        (core/dlp/customTerms.js _compile), the parity
 *                        reference: a literal matches anywhere (no whole-word
 *                        rule), its own case rule, exact characters; a term
 *                        without label or pattern was skipped and still is.
 *   buildLegacyMirror    the enforced words/pattern types written back as
 *                        `customSensitiveTerms` for one release, so a rollback
 *                        to a server without types still hides them.
 */

const { legacyTypeId } = require('./ids');
const { re2Compile, v8Compile } = require('./compile');
const { LEGACY_TOKEN_KEY, LIMITS } = require('./spec');

const LEGACY_EPOCH = '1970-01-01T00:00:00.000Z';

/**
 * @param {string} orgId
 * @param {any[]} customSensitiveTerms
 * @returns {any[]} types, in the terms' order
 */
function migrateLegacyTerms(orgId, customSensitiveTerms) {
    if (!orgId || !Array.isArray(customSensitiveTerms)) return [];
    const out = [];
    const seen = new Set();
    for (const term of customSensitiveTerms) {
        const bare = typeof term === 'string';
        if (!bare && (!term || typeof term !== 'object')) continue;
        const label = bare ? term : term.label;
        const pattern = bare ? term : term.pattern;
        if (!label || !pattern) continue;
        const id = legacyTypeId(orgId, term);
        if (seen.has(id)) continue;
        seen.add(id);
        const caseSensitive = !bare && term.caseSensitive === true;
        const createdAt = (!bare && typeof term.createdAt === 'string' && term.createdAt) || LEGACY_EPOCH;
        const base = {
            id,
            name: String(label).trim().slice(0, LIMITS.nameMax) || 'Always hidden',
            description: '',
            tokenKey: LEGACY_TOKEN_KEY,
            origin: 'migrated',
            legacy: true,
            createdAt,
            createdBy: (!bare && typeof term.createdBy === 'string' && term.createdBy) || null,
            updatedAt: createdAt,
            // Server-owned, like `legacy`: the term this type came from, so
            // the mirror written back for a rollback keeps the term's own id.
            ...(!bare && typeof term.id === 'string' && term.id ? { legacyTermId: term.id.slice(0, 200) } : {}),
        };
        const literal = bare || term.type === 'literal';
        if (literal) {
            const value = String(pattern);
            const t = {
                ...base,
                method: 'words',
                words: { values: [value.slice(0, LIMITS.legacyWordMax)], caseSensitive, wholeWord: false },
            };
            out.push(t);
            continue;
        }
        const source = String(pattern).slice(0, LIMITS.legacyPatternMax);
        const re2 = re2Compile(source, caseSensitive);
        let engine = 're2';
        let error = null;
        if (re2.error) {
            engine = 'v8-legacy';
            const v8 = v8Compile(source, caseSensitive);
            if (!v8.ok) error = v8.error || 'invalid';
        }
        out.push({
            ...base,
            method: 'pattern',
            pattern: { source, caseSensitive, engine, ...(error ? { error } : {}) },
            // The old scanner skipped a pattern that did not compile; it stays
            // visible to the admin, red, and still not enforced.
            ...(error ? { status: 'invalid' } : {}),
        });
    }
    return out;
}

/**
 * @param {any[]} types  the types that are ENFORCED (not invalid, licence-clamped)
 * @returns {any[]} customSensitiveTerms entries
 */
function buildLegacyMirror(types) {
    const terms = [];
    for (const t of Array.isArray(types) ? types : []) {
        if (!t || t.status === 'invalid') continue;
        const common = {
            label: String(t.name || '').slice(0, 120),
            createdAt: t.createdAt || LEGACY_EPOCH,
            createdBy: t.createdBy || null,
        };
        if (t.method === 'words') {
            const values = Array.isArray(t.words?.values) ? t.words.values : [];
            values.forEach((v, i) => terms.push({
                id: values.length === 1 ? (t.legacyTermId || t.id) : `${t.id}_${i}`,
                ...common,
                pattern: String(v).slice(0, 500),
                caseSensitive: t.words?.caseSensitive === true,
                type: 'literal',
            }));
        } else if (t.method === 'pattern') {
            const source = String(t.pattern?.source || '');
            // The old server compiles with V8; an RE2-only construct would be
            // skipped there anyway, so it is not written.
            if (!source || !v8Compile(source, t.pattern?.caseSensitive === true).ok) continue;
            terms.push({
                id: t.legacyTermId || t.id,
                ...common,
                pattern: source.slice(0, 500),
                caseSensitive: t.pattern?.caseSensitive === true,
                type: 'regex',
            });
        }
    }
    return terms;
}

module.exports = { migrateLegacyTerms, buildLegacyMirror, LEGACY_EPOCH };
