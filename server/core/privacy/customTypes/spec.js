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
const { re2Compile, v8Compile } = require('./compile');
const { ALL_PII_CATEGORY_IDS } = require('../piiDetection/categories');
const { TOKEN_WORDS } = require('../piiDetection/tokenNeutralise');

const LIMITS = Object.freeze({
    maxTypes: 50,
    maxAiTypes: 6,
    nameMax: 60,
    descriptionMax: 400,
    wordsMax: 500,
    wordMax: 120,
    legacyWordMax: 500,
    patternMax: 300,
    legacyPatternMax: 500,
    promptMin: 2,
    promptMax: 60,
    floorMin: 0.10,
    floorMax: 0.95,
    floorDefault: 0.5,
    groupSignatureMax: 200,
});

const METHODS = Object.freeze(['words', 'pattern', 'ai']);
const TOKEN_KEY_RE = /^[a-z](?:[a-z0-9_]{0,30}[a-z])?$/;
/** Migrated legacy types keep today's placeholder, `[customterm_N]`. */
const LEGACY_TOKEN_KEY = 'customterm';

/** Placeholder keys are compared the way restoreTokens compares them. */
const normKey = (k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
let _reservedNorm = null;
function _isReserved(key) {
    if (!_reservedNorm) _reservedNorm = new Set([...reservedTokenKeys()].map(normKey));
    return _reservedNorm.has(normKey(key));
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const CONTROL = /\p{Cc}/u;

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
    const errors = [];
    if (!isPlainObject(type)) {
        return { ok: false, normalized: null, errors: [{ id: null, field: 'type', code: 'invalid_type', message: 'A data type is an object.' }] };
    }
    const id = isCustomTypeId(type.id) ? type.id : null;
    const err = (field, code, message) => errors.push({ id, field, code, message });

    // ── structural ─────────────────────────────────────────────────────
    if (!id) err('id', 'invalid_id', 'A data type id is cdt_ followed by 10 hex characters.');
    const name = typeof type.name === 'string' ? type.name.trim() : '';
    if (!name || name.length > LIMITS.nameMax) err('name', 'name_invalid', `Give the data type a name of 1 to ${LIMITS.nameMax} characters.`);
    if (!METHODS.includes(type.method)) err('method', 'method_invalid', 'The method is words, pattern or ai.');
    const stored = id ? storedTypes.find(t => t && t.id === id) : null;
    const isLegacy = !!(stored && stored.legacy === true);
    if (type.legacy === true && !isLegacy) err('legacy', 'legacy_forged', 'Only the server marks a data type as migrated.');
    if (errors.length) return { ok: false, normalized: null, errors };

    // ── content ────────────────────────────────────────────────────────
    let description = typeof type.description === 'string' ? type.description.trim() : '';
    if (description.length > LIMITS.descriptionMax) {
        err('description', 'description_too_long', `The description holds at most ${LIMITS.descriptionMax} characters.`);
        description = description.slice(0, LIMITS.descriptionMax);
    }

    let tokenKey = typeof type.tokenKey === 'string' ? type.tokenKey : '';
    const legacyKey = isLegacy && tokenKey === LEGACY_TOKEN_KEY;
    if (!legacyKey) {
        if (!TOKEN_KEY_RE.test(tokenKey)) {
            err('tokenKey', 'token_key_invalid', 'The placeholder name uses lowercase letters, digits and underscores, starts and ends with a letter, and is at most 32 characters.');
            tokenKey = tokenKey.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
        } else if (_isReserved(tokenKey)) {
            err('tokenKey', 'token_key_reserved', 'This placeholder name is already used by a built-in kind of data. Pick another one.');
        } else if (existingTypes.some(t => t && t.id !== id && !(t.legacy && t.tokenKey === LEGACY_TOKEN_KEY)
            && normKey(t.tokenKey) === normKey(tokenKey))) {
            err('tokenKey', 'token_key_duplicate', 'Another data type already uses this placeholder name.');
        }
    }

    const out = {
        id,
        name,
        description,
        method: type.method,
        tokenKey,
    };

    if (type.method === 'words') {
        const w = isPlainObject(type.words) ? type.words : {};
        const caseSensitive = w.caseSensitive === true;
        const wholeWord = typeof w.wholeWord === 'boolean' ? w.wholeWord : !isLegacy;
        const maxLen = isLegacy ? LIMITS.legacyWordMax : LIMITS.wordMax;
        const values = [];
        const seen = new Set();
        let tooLong = false;
        for (const raw of Array.isArray(w.values) ? w.values : []) {
            if (typeof raw !== 'string') continue;
            // A migrated literal keeps its exact characters (parity with the old
            // scanner); a new word is trimmed.
            const v = isLegacy ? raw : raw.trim();
            if (!v) continue;
            if (v.length > maxLen) { tooLong = true; continue; }
            if (seen.has(v)) continue;
            seen.add(v);
            values.push(v);
        }
        if (!Array.isArray(w.values)) err('words.values', 'words_invalid', 'The words are a list of text.');
        if (tooLong) err('words.values', 'word_too_long', `Each word or phrase holds at most ${maxLen} characters.`);
        if (values.length > LIMITS.wordsMax) err('words.values', 'words_too_many', `A data type holds at most ${LIMITS.wordsMax} words.`);
        if (!values.length) err('words.values', 'words_empty', 'Add at least one word or phrase.');
        out.words = { values: values.slice(0, LIMITS.wordsMax), caseSensitive, wholeWord };
    } else if (type.method === 'pattern') {
        const p = isPlainObject(type.pattern) ? type.pattern : {};
        const source = typeof p.source === 'string' ? p.source : '';
        const caseSensitive = p.caseSensitive === true;
        const max = isLegacy ? LIMITS.legacyPatternMax : LIMITS.patternMax;
        const keepV8 = isLegacy && stored.pattern?.engine === 'v8-legacy' && stored.pattern?.source === source;
        let engine = keepV8 ? 'v8-legacy' : 're2';
        let error = null;
        if (!source) {
            err('pattern.source', 'pattern_required', 'Write the pattern.');
            error = 'missing';
        } else if (source.length > max) {
            err('pattern.source', 'pattern_too_long', `A pattern holds at most ${max} characters.`);
            error = 'too long';
        } else if (keepV8) {
            const v8 = v8Compile(source, caseSensitive);
            if (!v8.ok) { err('pattern.source', 'pattern_invalid', 'This pattern does not compile.'); error = v8.error || 'invalid'; }
        } else {
            const { re, error: re2Error } = re2Compile(source, caseSensitive);
            if (re2Error || !re) {
                err('pattern.source', 'pattern_invalid', `This pattern is not supported: ${re2Error || 'invalid'}.`);
                error = re2Error || 'invalid';
            } else if (!isLegacy && re.test('')) {
                err('pattern.source', 'pattern_matches_empty', 'This pattern also matches empty text, so it would match everywhere. Make it require at least one character.');
                error = 'matches empty text';
            }
            engine = 're2';
        }
        out.pattern = { source: source.slice(0, max), caseSensitive, engine, ...(error ? { error: String(error).slice(0, 200) } : {}) };
    } else {
        const a = isPlainObject(type.ai) ? type.ai : {};
        const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : '';
        if (prompt.length < LIMITS.promptMin || prompt.length > LIMITS.promptMax
            || CONTROL.test(prompt) || prompt.includes('<<') || prompt.includes('>>')) {
            err('ai.prompt', 'ai_prompt_invalid', `The label for the AI is ${LIMITS.promptMin} to ${LIMITS.promptMax} characters of plain text.`);
        }
        let floor = a.floor === undefined ? LIMITS.floorDefault : a.floor;
        if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < LIMITS.floorMin || floor > LIMITS.floorMax) {
            err('ai.floor', 'ai_floor_invalid', `The sensitivity is a number between ${LIMITS.floorMin} and ${LIMITS.floorMax}.`);
            floor = LIMITS.floorDefault;
        }
        out.ai = { prompt: prompt.slice(0, LIMITS.promptMax), floor };
        if (typeof a.groupSignature === 'string' && a.groupSignature.length <= LIMITS.groupSignatureMax) {
            out.ai.groupSignature = a.groupSignature;
        }
    }

    const quality = _cleanQuality(type.quality);
    if (quality) out.quality = quality;
    // A description is only shown: cut to size and reported, it does not
    // switch the type off.
    if (errors.some(e => e.field !== 'description')) out.status = 'invalid';
    out.origin = stored?.origin === 'migrated' ? 'migrated' : 'created';
    if (isLegacy) out.legacy = true;
    if (isLegacy && typeof stored.legacyTermId === 'string') out.legacyTermId = stored.legacyTermId;
    out.createdAt = (typeof stored?.createdAt === 'string' && stored.createdAt)
        || (typeof type.createdAt === 'string' && type.createdAt.length <= 40 && type.createdAt) || now;
    out.createdBy = stored ? (stored.createdBy ?? null) : (opts.userId ?? null);
    out.updatedAt = stored && canonicalContent(stored) === canonicalContent(out) && typeof stored.updatedAt === 'string'
        ? stored.updatedAt : now;

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
