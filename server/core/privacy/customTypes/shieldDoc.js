// @typecheck
'use strict';
/**
 * "Your own data" in the Privacy Shield document: what the GET shows and
 * what a PUT may change. The route (routes/orgPrivacyShield.js) owns the
 * request; this owns the rules, so the route stays a route.
 *
 * The switches of a type are its id in the existing lists:
 *   Hide from AI   → piiDetectionCategories
 *   Outside tools  → toolPiiPolicy.external.blockCategories
 *   Own server     → toolPiiPolicy.internal.blockCategories
 * so a PUT is: the type list, then those lists split into their built-in
 * part (handled as before) and their custom part (ids of this org's types
 * only), then the mirror written back as `customSensitiveTerms`.
 *
 * Licence (the TARGET org's): with `custom_data_types` the list is the
 * admin's. Without it, the stored types stand; the one change accepted is
 * removing migrated types, and anything else leaves them as they were with
 * `customDataTypes` in `clamped_fields`.
 */

const { isCustomTypeId } = require('./ids');
const { validateTypeList, canonicalContent, LIMITS } = require('./spec');
const { migrateLegacyTerms, buildLegacyMirror } = require('./migrate');
const { deriveCustomState, withMigratedIds } = require('./resolve');
const registry = require('./registry');

/**
 * The old custom-terms reader, unchanged: every invalid term reported at
 * once in `termErrors` (kept for one release), the valid ones sanitised.
 * @param {any[]} terms
 * @param {string} userId
 */
function sanitizeLegacyTerms(terms, userId) {
    const sanitizedTerms = [];
    const termErrors = [];
    for (const term of Array.isArray(terms) ? terms : []) {
        if (!term || typeof term !== 'object' || !term.pattern || !term.label) {
            termErrors.push({ id: term?.id || null, label: term?.label || '(missing)', error: 'Missing label or pattern' });
            continue;
        }
        // A type the matcher does not know was read as 'regex', so the
        // literal `a.b` also matched `axb`; a caseSensitive of "false" (a
        // string) matched case-SENSITIVELY. Both are reported per term like a
        // bad pattern. An absent type is a row from before literals existed.
        if (term.type !== undefined && term.type !== 'regex' && term.type !== 'literal') {
            termErrors.push({ id: term.id || null, label: String(term.label), error: 'type is regex or literal' });
            continue;
        }
        if (term.caseSensitive !== undefined && typeof term.caseSensitive !== 'boolean') {
            termErrors.push({ id: term.id || null, label: String(term.label), error: 'caseSensitive is true or false' });
            continue;
        }
        const type = term.type === 'literal' ? 'literal' : 'regex';
        if (type === 'regex') {
            try {
                void new RegExp(term.pattern, term.caseSensitive ? '' : 'i');
            } catch (err) {
                termErrors.push({ id: term.id || null, label: term.label, error: err.message });
                continue;
            }
        }
        sanitizedTerms.push({
            id: term.id || `term-${Date.now()}-${sanitizedTerms.length}`,
            label: String(term.label).slice(0, 120),
            pattern: String(term.pattern).slice(0, 500),
            caseSensitive: !!term.caseSensitive,
            type,
            createdAt: term.createdAt || new Date().toISOString(),
            createdBy: term.createdBy || userId,
        });
    }
    return { sanitizedTerms, termErrors };
}

const _termShape = (t) => JSON.stringify([t?.id ?? null, t?.label ?? null, t?.pattern ?? null, !!t?.caseSensitive, t?.type === 'literal' ? 'literal' : 'regex']);
function _sameTerms(a, b) {
    const x = (Array.isArray(a) ? a : []).map(_termShape);
    const y = (Array.isArray(b) ? b : []).map(_termShape);
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * What the GET adds to the (already cloned) response config.
 * @param {any} config  the response copy (mutated)
 * @param {{ orgId: string, stored: any, featureEnabled: boolean }} ctx
 * @returns {string[]} clamped fields to report
 */
function applyToGetResponse(config, { orgId, stored, featureEnabled }) {
    const state = deriveCustomState(stored, orgId);
    config.customDataTypes = JSON.parse(JSON.stringify(state.types));
    if (state.lazilyMigrated) config.piiDetectionCategories = withMigratedIds(config.piiDetectionCategories, state);
    return !featureEnabled && state.types.some(t => !t.legacy) ? ['customDataTypes'] : [];
}

/** Custom ids of `list` that are in `ids`, in order, without repeats. */
function _customPart(list, ids) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
        if (isCustomTypeId(c) && ids.has(c) && !out.includes(c)) out.push(c);
    }
    return out.slice(0, LIMITS.maxTypes);
}

/**
 * May a Community org make this change? Only removing migrated types: every
 * incoming type must be a stored one, unchanged, and every missing one a
 * migrated type.
 */
function _communityAccepts(storedTypes, incoming) {
    const byId = new Map(storedTypes.map(t => [t.id, t]));
    for (const t of incoming) {
        const s = byId.get(t.id);
        if (!s || canonicalContent(s) !== canonicalContent(t)) return false;
    }
    const kept = new Set(incoming.map(t => t.id));
    return storedTypes.every(t => kept.has(t.id) || t.legacy === true);
}

/**
 * Ids another organisation already has: the registry, plus every stored
 * shield row (two queries, only when the save introduces new ids). A copied
 * id would otherwise let one org's list select another org's type.
 * @param {string} orgId
 * @param {string[]} ids
 * @param {any} configStore
 */
async function _idsOwnedElsewhere(orgId, ids, configStore) {
    const taken = new Set();
    if (!ids.length) return taken;
    const wanted = new Set(ids);
    for (const id of ids) {
        const owner = registry.ownerOf(id);
        if (owner && owner !== orgId) taken.add(id);
    }
    if (configStore && typeof configStore.listKeysWithPrefix === 'function' && typeof configStore.getConfigsByKeys === 'function') {
        const prefix = 'org_privacy_shield_';
        const keys = (await configStore.listKeysWithPrefix(prefix)).filter(k => k !== `${prefix}${orgId}`);
        const rows = keys.length ? await configStore.getConfigsByKeys(keys) : {};
        for (const [key, row] of Object.entries(rows || {})) {
            for (const t of deriveCustomState(row, key.slice(prefix.length)).types) {
                if (wanted.has(t.id)) taken.add(t.id);
            }
        }
    }
    return taken;
}

/**
 * Everything a PUT decides about custom types.
 *
 * @param {{ orgId: string, body: any, storedRow: any, featureEnabled: boolean, userId: string|null, now?: string, configStore?: any }} ctx
 * @returns {Promise<{
 *   customDataTypes: any[], enforced: any[], mirror: any[],
 *   lists: { pii: string[], external: string[], internal: string[], webSearch: string[] },
 *   typeErrors: any[], termErrors: any[], clamped: string[], removedIds: string[], changed: boolean }>}
 */
async function planPut({ orgId, body, storedRow, featureEnabled, userId, now = new Date().toISOString(), configStore = null }) {
    const state = deriveCustomState(storedRow, orgId);
    const storedTypes = state.types;
    const storedIds = new Set(storedTypes.map(t => t.id));
    let typeErrors = [];
    const clamped = [];

    let termErrors = [];
    let sanitizedTerms = null;
    if (Array.isArray(body.customSensitiveTerms)) {
        ({ sanitizedTerms, termErrors } = sanitizeLegacyTerms(body.customSensitiveTerms, userId || ''));
    }

    // ── the incoming list (null = unchanged) ──────────────────────────
    let incoming = null;
    let legacyAdded = [];
    const typesSent = body.customDataTypes !== undefined;
    if (typesSent) {
        const v = validateTypeList(body.customDataTypes, { orgId, storedTypes, userId, now });
        incoming = v.types;
        typeErrors.push(...v.errors);
    } else if (sanitizedTerms && !_sameTerms(sanitizedTerms, storedRow?.customSensitiveTerms)) {
        // An older client edited the old list. Its entries that mirror a
        // created type are that type; the rest become migrated types, the
        // stored version kept where the id already exists.
        const createdIds = new Set(storedTypes.filter(t => !t.legacy).map(t => t.id));
        // A mirror entry of an EDITED migrated type (several words) carries
        // the type id too; it is that type, not a new term.
        storedTypes.filter(t => t.legacy).forEach(t => createdIds.add(t.id));
        const mirrorOf = (id) => String(id || '').replace(/_\d+$/, '');
        const legacyTerms = sanitizedTerms.filter(t => !createdIds.has(t.id) && !createdIds.has(mirrorOf(t.id)));
        const migrated = migrateLegacyTerms(orgId, legacyTerms).map(t => storedTypes.find(s => s.id === t.id) || t);
        legacyAdded = migrated.filter(t => !storedIds.has(t.id)).map(t => t.id);
        const v = validateTypeList([...storedTypes.filter(t => !t.legacy), ...migrated], {
            orgId, storedTypes: [...storedTypes, ...migrated.filter(t => !storedIds.has(t.id))], userId, now,
        });
        incoming = v.types;
        typeErrors.push(...v.errors);
    }

    // ── licence ───────────────────────────────────────────────────────
    let finalTypes = storedTypes;
    if (incoming !== null) {
        if (featureEnabled) {
            finalTypes = incoming;
        } else if (_communityAccepts(storedTypes, incoming)) {
            const kept = new Set(incoming.map(t => t.id));
            finalTypes = storedTypes.filter(t => kept.has(t.id));
            typeErrors = [];
        } else {
            finalTypes = storedTypes;
            typeErrors = [];
            legacyAdded = [];
            clamped.push('customDataTypes');
        }
    }

    // ── an id another org owns is refused ─────────────────────────────
    const newIds = finalTypes.filter(t => !storedIds.has(t.id) && !t.legacy).map(t => t.id);
    const taken = await _idsOwnedElsewhere(orgId, newIds, configStore);
    if (taken.size) {
        finalTypes = finalTypes.filter(t => !taken.has(t.id));
        for (const id of taken) typeErrors.push({ id, field: 'id', code: 'id_taken', message: 'This data type id is already in use. Create the type again to get a new id.' });
    }

    // ── the switches ──────────────────────────────────────────────────
    const finalIds = new Set(finalTypes.map(t => t.id));
    const storedPolicy = storedRow?.toolPiiPolicy || {};
    const fromBody = typesSent && featureEnabled;
    const piiSource = fromBody ? body.piiDetectionCategories : [...withMigratedIds(storedRow?.piiDetectionCategories, state), ...legacyAdded];
    const extSource = fromBody ? body.toolPiiPolicy?.external?.blockCategories : storedPolicy.external?.blockCategories;
    const intSource = fromBody ? body.toolPiiPolicy?.internal?.blockCategories : storedPolicy.internal?.blockCategories;
    const webSource = fromBody ? body.webSearchGuardPiiCategories : storedRow?.webSearchGuardPiiCategories;
    if (fromBody) {
        const unknown = new Set();
        for (const list of [body.piiDetectionCategories, extSource, intSource, webSource]) {
            for (const c of Array.isArray(list) ? list : []) if (isCustomTypeId(c) && !finalIds.has(c)) unknown.add(c);
        }
        for (const id of unknown) {
            typeErrors.push({ id, field: 'piiDetectionCategories', code: 'unknown_type', message: 'A switch refers to a data type this organisation does not have; it was left off.' });
        }
    } else if (typesSent && !featureEnabled) {
        // Community: the switches of stored types are not the admin's to flip.
        const bodyIds = new Set([body.piiDetectionCategories, body.toolPiiPolicy?.external?.blockCategories, body.toolPiiPolicy?.internal?.blockCategories]
            .flatMap(l => (Array.isArray(l) ? l.filter(isCustomTypeId) : [])));
        const storedSwitchIds = new Set([piiSource, extSource, intSource].flatMap(l => _customPart(l, finalIds)));
        const differs = [...bodyIds].some(id => finalIds.has(id) && !storedSwitchIds.has(id))
            || [...storedSwitchIds].some(id => !bodyIds.has(id));
        if (differs && !clamped.includes('customDataTypes')) clamped.push('customDataTypes');
    }

    const enforced = finalTypes.filter(t => t.status !== 'invalid' && (featureEnabled || t.legacy));
    return {
        customDataTypes: finalTypes,
        enforced,
        mirror: buildLegacyMirror(enforced),
        lists: {
            pii: _customPart(piiSource, finalIds),
            external: _customPart(extSource, finalIds),
            internal: _customPart(intSource, finalIds),
            webSearch: _customPart(webSource, finalIds),
        },
        typeErrors,
        termErrors,
        clamped,
        removedIds: [...storedIds].filter(id => !finalIds.has(id)),
        changed: incoming !== null,
    };
}

module.exports = { planPut, applyToGetResponse, sanitizeLegacyTerms };
