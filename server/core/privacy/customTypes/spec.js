// @typecheck
'use strict';
/**
 * The stored shape of a "Your own data" type, and the one validator for it.
 *
 * Contract (see the feature contract, "Stored type"): exactly one method
 * block, caps on every list, a placeholder key (`tokenKey`) that cannot be
 * mistaken for a built-in category, and a pattern that RE2 accepts.
 *
 * Two kinds of error, handled differently:
 *   - STRUCTURAL (no usable id, name or method; a client claiming `legacy`):
 *     the type cannot be kept at all, `normalized` is null.
 *   - CONTENT (a pattern that does not compile, an empty word list, a
 *     placeholder that collides): the type is kept with `status: 'invalid'`,
 *     shown red to the admin and NOT enforced. Their work is not thrown away,
 *     and the shield never runs a matcher it could not validate.
 *
 * `legacy`, `origin` and `createdBy` are the server's to say: they are taken
 * from the stored version of the type, never from the body.
 */

const { isCustomTypeId, sha256 } = require('./ids');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const { TOKEN_WORDS } = require('../piiDetection/tokenNeutralise');
const { LIMITS } = require('./limits');
const { METHOD_BLOCKS, isPlainObject } = require('./specMethods');

const METHODS = Object.freeze(['words', 'pattern', 'ai']);
const TOKEN_KEY_RE = /^[a-z](?:[a-z0-9_]{0,30}[a-z])?$/;
/** Migrated legacy types keep today's placeholder, `[customterm_N]`. */
const LEGACY_TOKEN_KEY = 'customterm';

/**
 * Placeholder keys are compared the way restoreTokens compares them.
 * @param {string} k
 */
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** @type {Set<string> | null} */
let _reserved = null;
/** Every key a type may not use: built-in categories, TOKEN_WORDS, and four words. */
function reservedTokenKeys() {
    if (!_reserved) {
        const s = new Set(['data', 'pii', LEGACY_TOKEN_KEY, 'custom']);
        for (const id of ALL_PII_CATEGORY_IDS) s.add(String(id).toLowerCase().replace(/[^a-z0-9]/g, '_'));
        for (const k of Object.keys(TOKEN_WORDS)) s.add(k);
        _reserved = s;
    }
    return new Set(_reserved);
}
/** @type {Set<string> | null} */
let _reservedNorm = null;
/**
 * @param {string} key
 */
function _isReserved(key) {
    if (!_reservedNorm) _reservedNorm = new Set([...reservedTokenKeys()].map(normKey));
    return _reservedNorm.has(normKey(key));
}

/** The fields that decide what a type matches and how it is shown. */
function canonicalContent(t) {
    const w = t?.words || {};
    const p = t?.pattern || {};
    const a = t?.ai || {};
    return JSON.stringify([
        t?.name || '', t?.description || '', t?.method || '', t?.tokenKey || '',
        t?.method === 'words' ? [Array.isArray(w.values) ? w.values : [], w.caseSensitive === true, w.wholeWord === true] : null,
        t?.method === 'pattern' ? [String(p.source || ''), p.caseSensitive === true] : null,
        t?.method === 'ai' ? [String(a.prompt || ''), Number(a.floor)] : null,
    ]);
}

/** Digest of what a scan with this type can produce (matcher + label + placeholder). */
function specDigest(t) {
    const p = t?.pattern || {};
    return sha256(JSON.stringify([
        t?.id, t?.status || '', canonicalContent(t), t?.method === 'pattern' ? p.engine || 're2' : '',
    ])).slice(0, 16);
}

/** Digest of an ordered list of types (order breaks merge ties). */
function typesDigest(types) {
    const list = Array.isArray(types) ? types : [];
    if (!list.length) return '';
    return sha256(list.map(specDigest).join('|')).slice(0, 16);
}

function _cleanQuality(q) {
    if (!isPlainObject(q)) return undefined;
    const int = (v) => (Number.isInteger(v) && v >= 0 && v <= 100_000 ? v : 0);
    const out = { found: int(q.found), total: int(q.total), falseAlarms: int(q.falseAlarms), sentences: int(q.sentences) };
    if (typeof q.at === 'string' && q.at.length <= 40) out.at = q.at;
    if (typeof q.stale === 'boolean') out.stale = q.stale;
    return out;
}

/** @typedef {(field: string, code: string, message: string) => void} ErrSink */
/** @typedef {Record<string, any>} TypeBody  a type as sent, once known to be an object */
/** @typedef {Record<string, any> | null | undefined} StoredType  the saved version of a type, if any */

/**
 * STRUCTURAL checks: a usable id, name and method, and a legacy flag only
 * where the stored version carries it. Reports through `err`; the caller
 * drops the type when any was raised.
 * @param {TypeBody} type
 * @param {string | null} id
 * @param {any[]} storedTypes
 * @param {ErrSink} err
 */
function structuralFields(type, id, storedTypes, err) {
    if (!id) err('id', 'invalid_id', 'A data type id is cdt_ followed by 10 hex characters.');
    const name = typeof type.name === 'string' ? type.name.trim() : '';
    if (!name || name.length > LIMITS.nameMax) err('name', 'name_invalid', `Give the data type a name of 1 to ${LIMITS.nameMax} characters.`);
    if (!METHODS.includes(type.method)) err('method', 'method_invalid', 'The method is words, pattern or ai.');
    const stored = id ? storedTypes.find(t => t && t.id === id) : null;
    const isLegacy = !!(stored && stored.legacy === true);
    if (type.legacy === true && !isLegacy) err('legacy', 'legacy_forged', 'Only the server marks a data type as migrated.');
    return { name, stored, isLegacy };
}

/**
 * The description, trimmed and cut to its cap (reported, but it does not switch the type off).
 * @param {TypeBody} type
 * @param {ErrSink} err
 */
function cleanDescription(type, err) {
    const description = typeof type.description === 'string' ? type.description.trim() : '';
    if (description.length <= LIMITS.descriptionMax) return description;
    err('description', 'description_too_long', `The description holds at most ${LIMITS.descriptionMax} characters.`);
    return description.slice(0, LIMITS.descriptionMax);
}

/**
 * Another type (not this one, not a migrated `customterm`) with the same placeholder.
 * @param {any[]} existingTypes
 * @param {string | null} id
 * @param {string} tokenKey
 */
const tokenKeyTaken = (existingTypes, id, tokenKey) => existingTypes.some(t => t && t.id !== id && !(t.legacy && t.tokenKey === LEGACY_TOKEN_KEY)
    && normKey(t.tokenKey) === normKey(tokenKey));

/**
 * The placeholder key: well formed, not a built-in kind, not taken. A
 * migrated type keeps `customterm`. A malformed key is reported and kept in
 * its cleaned-up form.
 * @param {TypeBody} type
 * @param {{ id: string | null, isLegacy: boolean, existingTypes: any[] }} ctx
 * @param {ErrSink} err
 */
function cleanTokenKey(type, { id, isLegacy, existingTypes }, err) {
    const tokenKey = typeof type.tokenKey === 'string' ? type.tokenKey : '';
    if (isLegacy && tokenKey === LEGACY_TOKEN_KEY) return tokenKey;
    if (!TOKEN_KEY_RE.test(tokenKey)) {
        err('tokenKey', 'token_key_invalid', 'The placeholder name uses lowercase letters, digits and underscores, starts and ends with a letter, and is at most 32 characters.');
        return tokenKey.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
    }
    if (_isReserved(tokenKey)) {
        err('tokenKey', 'token_key_reserved', 'This placeholder name is already used by a built-in kind of data. Pick another one.');
    } else if (tokenKeyTaken(existingTypes, id, tokenKey)) {
        err('tokenKey', 'token_key_duplicate', 'Another data type already uses this placeholder name.');
    }
    return tokenKey;
}

/**
 * The fields that are the server's to say: origin, the legacy marks and the
 * timestamps and author, from the stored version when there is one.
 * @param {Record<string, any>} out
 * @param {TypeBody} type
 * @param {{ stored: StoredType, isLegacy: boolean, userId: string | null | undefined, now: string }} ctx
 */
function setServerFields(out, type, { stored, isLegacy, userId, now }) {
    out.origin = stored?.origin === 'migrated' ? 'migrated' : 'created';
    if (isLegacy) out.legacy = true;
    if (isLegacy && typeof stored?.legacyTermId === 'string') out.legacyTermId = stored.legacyTermId;
    out.createdAt = createdAtOf(stored, type, now);
    out.createdBy = stored ? (stored.createdBy ?? null) : (userId ?? null);
    out.updatedAt = updatedAtOf(stored, out, now);
}

/**
 * The stored creation time, else a short one from the body, else now.
 * @param {StoredType} stored
 * @param {TypeBody} type
 * @param {string} now
 */
const createdAtOf = (stored, type, now) => (typeof stored?.createdAt === 'string' && stored.createdAt)
    || (typeof type.createdAt === 'string' && type.createdAt.length <= 40 && type.createdAt) || now;

/**
 * The stored update time while the content is unchanged, else now.
 * @param {StoredType} stored
 * @param {Record<string, any>} out
 * @param {string} now
 */
const updatedAtOf = (stored, out, now) => (stored && canonicalContent(stored) === canonicalContent(out) && typeof stored.updatedAt === 'string'
    ? stored.updatedAt : now);

/**
 * @param {any} type
 * @param {{ orgId?: string, existingTypes?: any[], storedTypes?: any[], userId?: string|null, now?: string }} [opts]
 *   existingTypes: the org's OTHER types, for placeholder uniqueness.
 *   storedTypes:   the saved versions (legacy/origin/createdAt come from here);
 *                  defaults to existingTypes.
 * @returns {{ ok: boolean, normalized: any|null, errors: Array<{id: string|null, field: string, code: string, message: string}> }}
 */
function validateTypeSpec(type, opts = {}) {
    const existingTypes = Array.isArray(opts.existingTypes) ? opts.existingTypes : [];
    const storedTypes = Array.isArray(opts.storedTypes) ? opts.storedTypes : existingTypes;
    const now = opts.now || new Date().toISOString();
    /** @type {CustomTypeError[]} */
    const errors = [];
    if (!isPlainObject(type)) {
        return { ok: false, normalized: null, errors: [{ id: null, field: 'type', code: 'invalid_type', message: 'A data type is an object.' }] };
    }
    const id = isCustomTypeId(type.id) ? type.id : null;
    /** @type {ErrSink} */
    const err = (field, code, message) => { errors.push({ id, field, code, message }); };

    const { name, stored, isLegacy } = structuralFields(type, id, storedTypes, err);
    if (errors.length) return { ok: false, normalized: null, errors };

    const description = cleanDescription(type, err);
    const tokenKey = cleanTokenKey(type, { id, isLegacy, existingTypes }, err);
    /** @type {Record<string, any>} */
    const out = { id, name, description, method: type.method, tokenKey };
    const readBlock = /** @type {NonNullable<ReturnType<typeof METHOD_BLOCKS.get>>} */ (METHOD_BLOCKS.get(type.method));
    out[type.method] = readBlock(type, { err, isLegacy, stored });

    const quality = _cleanQuality(type.quality);
    if (quality) out.quality = quality;
    // A description is only shown: cut to size and reported, it does not
    // switch the type off.
    if (errors.some(e => e.field !== 'description')) out.status = 'invalid';
    setServerFields(out, type, { stored, isLegacy, userId: opts.userId, now });

    return { ok: errors.length === 0, normalized: out, errors };
}

/**
 * Validate the whole list an admin saves: every type, plus the rules that
 * need the list (duplicate ids, unique placeholders, the caps).
 *
 * Migrated legacy types are never dropped by the 50-type cap: an org that had
 * more than 50 "Always hide these" terms keeps every one of them enforced.
 *
 * @param {any[]} list
 * @param {{ orgId?: string, storedTypes?: any[], userId?: string|null, now?: string }} [opts]
 */
function validateTypeList(list, opts = {}) {
    const storedTypes = Array.isArray(opts.storedTypes) ? opts.storedTypes : [];
    const errors = [];
    const types = [];
    const seen = new Set();
    let createdCount = 0;
    for (const raw of Array.isArray(list) ? list : []) {
        const res = validateTypeSpec(raw, { ...opts, existingTypes: [], storedTypes });
        if (!res.normalized) { errors.push(...res.errors); continue; }
        const t = res.normalized;
        if (seen.has(t.id)) {
            errors.push({ id: t.id, field: 'id', code: 'duplicate_id', message: 'Two data types have the same id.' });
            continue;
        }
        if (!t.legacy) {
            if (types.length >= LIMITS.maxTypes || createdCount >= LIMITS.maxTypes) {
                errors.push({ id: t.id, field: 'customDataTypes', code: 'too_many_types', message: `An organisation has at most ${LIMITS.maxTypes} data types.` });
                continue;
            }
            createdCount += 1;
        }
        seen.add(t.id);
        errors.push(...res.errors);
        types.push(t);
    }

    /**
     * @param {string} field
     * @param {string} code
     * @param {string} message
     */
    const markInvalid = (t, field, code, message) => {
        t.status = 'invalid';
        errors.push({ id: t.id, field, code, message });
    };
    const byKey = new Set();
    for (const t of types) {
        if (!t.tokenKey || (t.legacy && t.tokenKey === LEGACY_TOKEN_KEY)) continue;
        const k = normKey(t.tokenKey);
        if (byKey.has(k)) markInvalid(t, 'tokenKey', 'token_key_duplicate', 'Another data type already uses this placeholder name.');
        else byKey.add(k);
    }
    let aiCount = 0;
    const prompts = new Set();
    for (const t of types) {
        if (t.method !== 'ai' || t.status === 'invalid') continue;
        // The guard refuses two labels with the same prompt in one request.
        const p = String(t.ai?.prompt || '').trim().toLowerCase();
        if (prompts.has(p)) {
            markInvalid(t, 'ai.prompt', 'ai_prompt_duplicate', 'Another data type already uses this label for the AI.');
            continue;
        }
        prompts.add(p);
        aiCount += 1;
        if (aiCount > LIMITS.maxAiTypes) {
            markInvalid(t, 'method', 'too_many_ai', `At most ${LIMITS.maxAiTypes} data types can be recognised by the AI.`);
        }
    }
    return { types, errors };
}

module.exports = {
    LIMITS,
    METHODS,
    TOKEN_KEY_RE,
    LEGACY_TOKEN_KEY,
    normKey,
    reservedTokenKeys,
    validateTypeSpec,
    validateTypeList,
    canonicalContent,
    specDigest,
    typesDigest,
};

/**
 * @typedef {{ found: number, total: number, falseAlarms: number, sentences: number, at?: string, stale?: boolean }} CustomTypeQuality
 * @typedef {{ id: string, name: string, description: string, method: string, tokenKey: string,
 *   words?: { values: string[], caseSensitive: boolean, wholeWord: boolean },
 *   pattern?: { source: string, caseSensitive: boolean, engine: string, error?: string },
 *   ai?: { prompt: string, floor: number, groupSignature?: string },
 *   quality?: CustomTypeQuality, status?: string, origin?: string, legacy?: boolean, legacyTermId?: string,
 *   createdAt?: string, createdBy?: string | null, updatedAt?: string }} CustomDataType
 * @typedef {{ id: string | null, field: string, code: string, message: string }} CustomTypeError
 */
