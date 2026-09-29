'use strict';
/**
 * The test sets of the "Your own data" types, stored encrypted and apart.
 *
 * A test set holds REAL values: the admin's examples ("KL-12345") and the
 * sentences they are tested in. That is why it never lives in the shield
 * document, which every org member can read and the runtime caches. It is one
 * encrypted config row per org, `org_<orgId>_custom_data_tests`, written with
 * configStore.setSecret (AES-256-GCM under the per-org derived key, see
 * stores/configStore.js `_deriveKey`). Only org admins ever read it.
 *
 * Shape (pinned in the feature contract):
 *
 *   { "cdt_0123456789": {
 *       examples:  string[]  (≤10 × 1..100),
 *       keepFixed: string[]? (≤2 × 1..8, pattern types only),
 *       sentences: [{ id, text (1..300), gold?: [{start,end}] (≤5, disjoint, in range),
 *                     origin: 'assistant'|'nearmiss'|'own'|'feedback' }] (≤40),
 *       updatedAt: ISO string? } }
 *
 * Offsets are JavaScript string indices (UTF-16 code units), the same unit
 * the SPA's text selection and the Node matchers use.
 *
 * `gold` absent and `gold: []` mean different things and both survive: no
 * gold is "not marked yet" (try-your-own-text), an empty list is "nothing in
 * here should be hidden" (a near miss).
 *
 * sanitizeTests builds every entry from an allow-list of fields, so a key the
 * client adds is never stored. It repairs what can be repaired without
 * guessing (drops an out-of-range gold span, caps a list) and reports each
 * repair in `errors`; it never rewrites a sentence's text, because that would
 * move every gold offset in it.
 */

const { HttpError } = require('../../http/errors');

const TYPE_ID_RX = /^cdt_[0-9a-f]{10}$/;
const SENTENCE_ID_RX = /^[A-Za-z0-9_.:-]{1,40}$/;
const ORIGINS = Object.freeze(['assistant', 'nearmiss', 'own', 'feedback']);

const LIMITS = Object.freeze({
    maxExamples: 10,
    maxExampleChars: 100,
    maxKeepFixed: 2,
    maxKeepFixedChars: 8,
    maxSentences: 40,
    maxSentenceChars: 300,
    maxGold: 5,
    maxBytes: 256 * 1024,
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The configStore key of an org's test sets. */
function testsKeyFor(orgId) {
    if (typeof orgId !== 'string' || !orgId || orgId.length > 100 || /\p{Cc}/u.test(orgId)) {
        throw new HttpError(400, 'invalid_request', 'Unknown organization.');
    }
    return `org_${orgId}_custom_data_tests`;
}

function toIdSet(typeIds) {
    if (typeIds == null) return null;
    if (typeIds instanceof Set) return typeIds;
    if (Array.isArray(typeIds)) return new Set(typeIds);
    return new Set();
}

function methodFor(methods, id) {
    if (!methods) return null;
    if (methods instanceof Map) return methods.get(id) || null;
    return isPlainObject(methods) ? (methods[id] || null) : null;
}

function cleanStringList(raw, { max, maxChars, field, typeId, errors, trim = true }) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        errors.push({ id: typeId, field, code: 'invalid_list', message: `${field} is a list of text.` });
        return [];
    }
    const out = [];
    const seen = new Set();
    let dropped = 0;
    for (const item of raw) {
        const value = typeof item === 'string' ? (trim ? item.trim() : item) : '';
        if (!value || value.length > maxChars) { dropped += 1; continue; }
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    if (dropped) {
        errors.push({ id: typeId, field, code: 'invalid_entry', message: `${dropped} ${field} entr${dropped === 1 ? 'y was' : 'ies were'} empty or longer than ${maxChars} characters and ${dropped === 1 ? 'was' : 'were'} left out.` });
    }
    if (out.length > max) {
        errors.push({ id: typeId, field, code: 'too_many', message: `At most ${max} ${field} are kept.` });
        out.length = max;
    }
    return out;
}

/**
 * Gold spans of one sentence: integers, in range, non-empty, disjoint, at most
 * LIMITS.maxGold. Returns undefined when the sentence carries no gold at all.
 */
function cleanGold(raw, textLength, { typeId, field, errors }) {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
        errors.push({ id: typeId, field, code: 'invalid_gold', message: 'A marked part is a list of { start, end }.' });
        return undefined;
    }
    const spans = [];
    let dropped = 0;
    for (const g of raw) {
        const start = isPlainObject(g) ? g.start : undefined;
        const end = isPlainObject(g) ? g.end : undefined;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > textLength || start >= end) {
            dropped += 1;
            continue;
        }
        spans.push({ start, end });
    }
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    const disjoint = [];
    for (const s of spans) {
        const last = disjoint[disjoint.length - 1];
        if (last && s.start < last.end) { dropped += 1; continue; }
        disjoint.push(s);
    }
    if (dropped) {
        errors.push({ id: typeId, field, code: 'invalid_gold', message: `${dropped} marked part${dropped === 1 ? ' was' : 's were'} out of range or overlapping and ${dropped === 1 ? 'was' : 'were'} left out.` });
    }
    if (disjoint.length > LIMITS.maxGold) {
        errors.push({ id: typeId, field, code: 'too_many_gold', message: `A sentence keeps at most ${LIMITS.maxGold} marked parts.` });
        disjoint.length = LIMITS.maxGold;
    }
    return disjoint;
}

/**
 * One sentence, built from an allow-list. Returns null (with an error) when
 * the sentence cannot be kept as it is: a missing or duplicate id, or a text
 * that is empty or too long. The text is never trimmed or cut, because that
 * would move the gold offsets.
 */
function cleanSentence(raw, index, { typeId, errors, seenIds }) {
    const field = `sentences[${index}]`;
    if (!isPlainObject(raw)) {
        errors.push({ id: typeId, field, code: 'invalid_sentence', message: 'A test sentence is an object with an id and a text.' });
        return null;
    }
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!SENTENCE_ID_RX.test(id)) {
        errors.push({ id: typeId, field: `${field}.id`, code: 'invalid_sentence_id', message: 'A test sentence needs an id of at most 40 letters, digits or _ . : -' });
        return null;
    }
    if (seenIds.has(id)) {
        errors.push({ id: typeId, field: `${field}.id`, code: 'duplicate_sentence_id', message: 'Two test sentences had the same id; the second was left out.' });
        return null;
    }
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim() || text.length > LIMITS.maxSentenceChars) {
        errors.push({ id: typeId, field: `${field}.text`, code: 'invalid_sentence_text', message: `A test sentence holds 1 to ${LIMITS.maxSentenceChars} characters.` });
        return null;
    }
    seenIds.add(id);
    const gold = cleanGold(raw.gold, text.length, { typeId, field: `${field}.gold`, errors });
    const origin = ORIGINS.includes(raw.origin) ? raw.origin : 'own';
    const out = { id, text };
    if (gold !== undefined) out.gold = gold;
    out.origin = origin;
    return out;
}

function cleanEntry(raw, { typeId, method, errors }) {
    if (!isPlainObject(raw)) {
        errors.push({ id: typeId, field: 'tests', code: 'invalid_tests', message: 'The tests of a type are an object.' });
        return null;
    }
    const entry = {};
    entry.examples = cleanStringList(raw.examples, {
        max: LIMITS.maxExamples, maxChars: LIMITS.maxExampleChars, field: 'examples', typeId, errors,
    });
    if (raw.keepFixed !== undefined && raw.keepFixed !== null && (method === null || method === 'pattern')) {
        const keep = cleanStringList(raw.keepFixed, {
            max: LIMITS.maxKeepFixed, maxChars: LIMITS.maxKeepFixedChars, field: 'keepFixed', typeId, errors, trim: false,
        });
        if (keep.length) entry.keepFixed = keep;
    }
    const sentences = [];
    if (raw.sentences !== undefined && raw.sentences !== null && !Array.isArray(raw.sentences)) {
        errors.push({ id: typeId, field: 'sentences', code: 'invalid_list', message: 'sentences is a list.' });
    } else {
        const seenIds = new Set();
        for (const [i, s] of (raw.sentences || []).entries()) {
            const clean = cleanSentence(s, i, { typeId, errors, seenIds });
            if (clean) sentences.push(clean);
        }
    }
    if (sentences.length > LIMITS.maxSentences) {
        errors.push({ id: typeId, field: 'sentences', code: 'too_many', message: `A type keeps at most ${LIMITS.maxSentences} test sentences.` });
        sentences.length = LIMITS.maxSentences;
    }
    entry.sentences = sentences;
    if (typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40 && Number.isFinite(Date.parse(raw.updatedAt))) {
        entry.updatedAt = raw.updatedAt;
    }
    return entry;
}

function assertSize(doc) {
    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (bytes > LIMITS.maxBytes) {
        throw new HttpError(400, 'custom_data_tests_too_large',
            'The test sentences are too large to save. Remove some sentences or examples and save again.',
            { bytes, maxBytes: LIMITS.maxBytes });
    }
    return bytes;
}

/**
 * Clean a TestsDoc before it is stored.
 *
 * @param {any} doc  the client's `customDataTests`
 * @param {{ typeIds?: string[]|Set<string>|null, methods?: Record<string,string>|Map<string,string> }} [opts]
 *   typeIds: the ids of the SAVED types; entries for any other id are dropped
 *   silently (a removed type's tests go with it). null means "no filter".
 *   methods: optional id → method; when given, keepFixed is kept only for
 *   pattern types.
 * @returns {{ doc: object, errors: Array<{id: string|null, field: string, code: string, message: string}> }}
 * @throws HttpError 400 invalid_request when doc is not an object,
 *         HttpError 400 custom_data_tests_too_large over 256 KB serialised.
 */
function sanitizeTests(doc, { typeIds = null, methods = null } = {}) {
    if (doc === undefined || doc === null) return { doc: {}, errors: [] };
    if (!isPlainObject(doc)) {
        throw new HttpError(400, 'invalid_request', 'customDataTests is an object keyed by type id.');
    }
    const allowed = toIdSet(typeIds);
    const errors = [];
    const out = {};
    for (const [typeId, raw] of Object.entries(doc)) {
        if (!TYPE_ID_RX.test(typeId)) continue;
        if (allowed && !allowed.has(typeId)) continue;
        const entry = cleanEntry(raw, { typeId, method: methodFor(methods, typeId), errors });
        if (entry) out[typeId] = entry;
    }
    assertSize(out);
    return { doc: out, errors };
}

function createTestsStore({ configStore = null, log = null } = {}) {
    const store = () => configStore || require('../../../stores/configStore');
    const logger = () => log || require('../../../telemetry/log');

    /** The org's test sets, or null when there are none (or the row is unreadable). */
    async function readTests(orgId) {
        const key = testsKeyFor(orgId);
        const raw = await store().getSecret(key);
        if (raw === null || raw === undefined || raw === '') return null;
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (isPlainObject(parsed)) return parsed;
        } catch (_) { /* fall through */ }
        logger().warn('[CustomDataTests] stored test sets could not be read; treating them as empty');
        return null;
    }

    /**
     * Store the org's test sets. Pass a doc that went through sanitizeTests;
     * the size is checked again here. An empty doc removes the row.
     */
    async function writeTests(orgId, doc, auditCtx = null) {
        const key = testsKeyFor(orgId);
        if (!isPlainObject(doc)) throw new HttpError(400, 'invalid_request', 'customDataTests is an object keyed by type id.');
        const s = store();
        if (Object.keys(doc).length === 0) {
            if (typeof s.deleteConfig === 'function') await s.deleteConfig(key, { orgId, ...(auditCtx || {}) });
            else await s.setSecret(key, '', { orgId, ...(auditCtx || {}) });
            return;
        }
        assertSize(doc);
        await s.setSecret(key, JSON.stringify(doc), { orgId, integration: 'custom_data_tests', ...(auditCtx || {}) });
    }

    return { readTests, writeTests };
}

const defaultStore = createTestsStore();

module.exports = {
    sanitizeTests,
    readTests: defaultStore.readTests,
    writeTests: defaultStore.writeTests,
    createTestsStore,
    testsKeyFor,
    TESTS_LIMITS: LIMITS,
    TEST_ORIGINS: ORIGINS,
};
