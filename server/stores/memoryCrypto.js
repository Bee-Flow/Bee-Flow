// @typecheck
/**
 * Crypto for the memory store (user_memories): which key seals a row, which
 * columns are sealed, the blind index that replaces SQL equality on
 * subject/attribute, and the one `hydrate` every read path goes through.
 *
 * ── Which key ───────────────────────────────────────────────────────────────
 *
 * Memory is written and read with no session in scope (the extractor runs after
 * the reply, automations read it at 3am, retention prunes it), so it is a
 * BACKGROUND surface: the key is `resolveCrypto().backgroundKey`.
 *
 *   managed   the user's escrowed DEK (the same key as every other surface)
 *   zk        the NARROW ESCROW (MEMORIES is in ZK_ESCROW_SURFACES). Honestly
 *             labelled: on zk, memory is readable by the server operator, like
 *             the Privacy Shield token map and conversation titles. Message
 *             bodies stay strictly zero-knowledge.
 *   project   a row in a project's shared pool is keyed to the PROJECT
 *             (auth/projectEscrow.js), on every tier, because every member and
 *             every background job must open the same rows. Derived from the
 *             org root key, so an ORK rotation is refused while such rows exist
 *             (SEALED_UNDER_PROJECT_KEYS in projectEscrow.js).
 *
 * The raw DEK is never used directly: two HKDF children split it into an
 * encryption key and a blind-index key, so the HMAC key and the AES key never
 * coincide (and neither coincides with the message or vault keys).
 *
 * ── Reading is format-driven, never mode-driven ─────────────────────────────
 *
 * `hydrate` asks each VALUE whether it is an envelope. Plaintext legacy rows
 * keep reading after encryption is switched on, ciphertext keeps reading after
 * it is switched off. Reads never consult the policy; they only need the key,
 * and they resolve it lazily, so a plaintext-only install never touches the
 * escrow (which would mint a key for every user).
 *
 * ── What is sealed ──────────────────────────────────────────────────────────
 *
 *   sealed   content, summary, value, evidence_quote, subject, attribute, and
 *            the embedding (an inverted embedding can leak the text, so the
 *            vector is content). The embedding moves to `embedding_enc` and the
 *            plaintext JSONB column is NULLed when a row is sealed.
 *   clear    type, agent_id, project_id, importance, status, timestamps,
 *            origin, sensitivity, counters. Routing, lifecycle and ranking
 *            primitives; encrypting them turns every query into a table scan.
 *            `type` is a 7-value label with no content.
 *   subject/attribute are sealed (not NULLed) so the UI and the prompt
 *   formatter still have them; equality lookups go through `key_hash`.
 *   upsertScheduleCoverage rows are bookkeeping, not memories, and stay clear.
 *
 * ── AAD ─────────────────────────────────────────────────────────────────────
 *
 * `bfmem:v1:<memoryId>:<field>`. Bound to the row and the column, NOT to a
 * reader (the lesson of messageCrypto: an AAD that names the reader turns a
 * shared or admin-viewed row into a decrypt failure). A value copied to another
 * row or another column fails its tag.
 *
 * ── Blind index ─────────────────────────────────────────────────────────────
 *
 * key_hash = HMAC-SHA256(indexKey, type|subject|attribute), each part trimmed,
 * lower-cased and whitespace-collapsed. With no key (tier none, or the surface
 * off) it is a plain SHA-256 of the same string: the subject is stored in the
 * clear next to it, so the digest reveals nothing the row does not already.
 * Lookups try BOTH forms when a key is at hand, so flipping encryption on or
 * off does not stop the canonical dedupe from finding older rows.
 */

const crypto = require('crypto');
const { encryptField, decryptField, isEnvelope, FieldDecryptError } = require('./lib/fieldEnvelope');
const log = require('../telemetry/log');

const HKDF_SALT = Buffer.from('beeflow:memory:hkdf-salt:v1');

/** Text columns that are sealed. */
const SEALED_FIELDS = Object.freeze(['content', 'summary', 'value', 'evidence_quote', 'subject', 'attribute']);

/** A SQL LIKE pattern that matches a sealed TEXT value (see fieldEnvelope's wire format). */
const ENVELOPE_LIKE = '{"_bfenc"%';

/**
 * @typedef {object} MemoryKeys
 * @property {Buffer} enc    AES-256-GCM key for the sealed columns
 * @property {Buffer} index  HMAC key for key_hash
 */

/**
 * @typedef {object} MemoryWriteContext
 * @property {boolean} encrypt        seal what is written
 * @property {MemoryKeys|null} keys   present whenever a key resolved, even if the surface is off (lookups need it)
 */

/** @type {Readonly<MemoryWriteContext>} */
const PLAINTEXT_WRITE = Object.freeze({ encrypt: false, keys: null });

/** @param {Buffer} dek @returns {MemoryKeys} */
function memoryKeys(dek) {
    const child = (info) => Buffer.from(crypto.hkdfSync('sha256', dek, HKDF_SALT, info, 32));
    return { enc: child('beeflow:memory:v1:enc'), index: child('beeflow:memory:v1:keyhash') };
}

/** @param {string} memoryId @param {string} field */
function memoryAad(memoryId, field) {
    return `bfmem:v1:${memoryId}:${field}`;
}

const normPart = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The canonical string a key_hash is computed over. */
function canonicalKey(type, subject, attribute) {
    return `${normPart(type)}|${normPart(subject)}|${normPart(attribute)}`;
}

/** The three normalised parts of a canonical key, for SQL fallbacks. */
function canonicalParts(type, subject, attribute) {
    return [normPart(type), normPart(subject), normPart(attribute)];
}

/**
 * The key_hash to STORE.
 * @param {{type: string, subject: string, attribute: string}} parts
 * @param {MemoryWriteContext} ctx
 */
function keyHashForWrite(parts, ctx) {
    const canon = canonicalKey(parts.type, parts.subject, parts.attribute);
    if (ctx.encrypt && ctx.keys) return crypto.createHmac('sha256', ctx.keys.index).update(canon).digest('hex');
    return crypto.createHash('sha256').update(canon).digest('hex');
}

/**
 * Every key_hash an equal key may have been stored under: the plain digest
 * (rows written before encryption was on) and, when a key is at hand, the HMAC.
 * @returns {string[]}
 */
function keyHashCandidates(parts, ctx) {
    const canon = canonicalKey(parts.type, parts.subject, parts.attribute);
    const out = [crypto.createHash('sha256').update(canon).digest('hex')];
    if (ctx.keys) out.push(crypto.createHmac('sha256', ctx.keys.index).update(canon).digest('hex'));
    return out;
}

/**
 * Resolve how to WRITE for this owner. Never throws for a missing key (plaintext
 * is recoverable, an undecryptable value is not); a shared project whose key
 * cannot be produced DOES throw, exactly as resolveCrypto does, because the
 * alternative is writing a project's memory in the clear on an encrypted org.
 *
 * @param {{ userId: string, projectId?: string|null }} p
 * @returns {Promise<MemoryWriteContext>}
 */
async function resolveWriteContext({ userId, projectId = null }) {
    try {
        const { resolveCrypto } = require('./agent/messageCrypto');
        const ctx = await resolveCrypto(projectId
            ? { userId, projectKeyFor: { projectId } }
            : { userId });
        if (!ctx.backgroundKey) return PLAINTEXT_WRITE;
        return { encrypt: !!ctx.encryptMemories, keys: memoryKeys(ctx.backgroundKey) };
    } catch (err) {
        if (err && err.code === 'PROJECT_KEY_UNAVAILABLE') throw err;
        log.error('[MemoryCrypto] write context failed, writing plaintext:', err.message);
        return PLAINTEXT_WRITE;
    }
}

/**
 * Resolve the key that opens an existing row, WITHOUT consulting the policy
 * (a row stays readable after the surface is switched off). Only called when a
 * value is actually an envelope, so the escrow it reads already exists.
 *
 * @param {Record<string, any>} row  needs user_id and project_id
 * @returns {Promise<Buffer|null>} the enc key
 */
async function resolveReadKey(row) {
    try {
        if (row.project_id) {
            const user = await require('./userStore').getUser(row.user_id);
            const { getProjectKey } = require('../auth/projectEscrow');
            return memoryKeys(await getProjectKey(row.project_id, user?.organizationId || null)).enc;
        }
        const { _escrowKey } = require('./agent/messageCrypto');
        const dek = await _escrowKey(row.user_id);
        return dek ? memoryKeys(dek).enc : null;
    } catch (err) {
        log.warn(`[MemoryCrypto] read key unavailable for ${row.project_id ? 'project ' + row.project_id : 'user ' + row.user_id}: ${err.message}`);
        return null;
    }
}

/**
 * Seal the text fields of one row. Fields that are null/undefined pass through.
 * @param {string} memoryId
 * @param {Record<string, any>} fields  any subset of SEALED_FIELDS
 * @param {MemoryWriteContext} ctx
 */
function sealFields(memoryId, fields, ctx) {
    const out = {};
    for (const [f, v] of Object.entries(fields)) {
        out[f] = encryptField(v, {
            key: ctx.keys ? ctx.keys.enc : null,
            aad: memoryAad(memoryId, f),
            encrypt: ctx.encrypt,
        });
    }
    return out;
}

/**
 * Columns for a freshly computed embedding.
 * @param {string} memoryId
 * @param {number[]} vector
 * @param {MemoryWriteContext} ctx
 * @returns {{ embedding: string|null, embedding_enc: string|null, embedding_dim: number }}
 */
function sealEmbedding(memoryId, vector, ctx) {
    const json = JSON.stringify(vector);
    if (ctx.encrypt && ctx.keys) {
        return {
            embedding: null,
            embedding_enc: /** @type {string} */ (encryptField(json, { key: ctx.keys.enc, aad: memoryAad(memoryId, 'embedding'), encrypt: true })),
            embedding_dim: vector.length,
        };
    }
    return { embedding: json, embedding_enc: null, embedding_dim: vector.length };
}

function _rowIsSealed(row) {
    if (row.embedding_enc) return true;
    for (const f of SEALED_FIELDS) if (isEnvelope(row[f])) return true;
    return false;
}

/**
 * Open one row. Plaintext values pass through; a sealed value is opened with
 * `encKey`. Throws FieldDecryptError when a value IS sealed and cannot be opened.
 *
 * The returned row never carries `embedding_enc` (the plaintext vector is put
 * back under `embedding`) or `key_hash` (an index value, not API data).
 *
 * @param {Record<string, any>|null|undefined} row
 * @param {Buffer|null} encKey  the enc key from memoryKeys(), or null
 */
function hydrate(row, encKey) {
    if (!row) return row;
    const out = { ...row };
    for (const f of SEALED_FIELDS) {
        out[f] = decryptField(row[f], { key: encKey, aad: memoryAad(row.id, f) });
    }
    if (row.embedding_enc) {
        const json = decryptField(row.embedding_enc, { key: encKey, aad: memoryAad(row.id, 'embedding') });
        out.embedding = JSON.parse(String(json));
    }
    delete out.embedding_enc;
    delete out.key_hash;
    return out;
}

/**
 * Open many rows. Keys are resolved lazily and once per owner (user, or
 * user+project), and only for rows that contain an envelope.
 *
 * A row that cannot be opened is dropped from the result and logged (ids only),
 * so one bad row cannot take down a chat turn; with `keepUnreadable` it is
 * returned with its sealed text blanked and `unreadable: true`, which is what
 * the by-id reads need so that an owner can still authorise and delete it.
 *
 * @param {Array<Record<string, any>>} rows
 * @param {{ keepUnreadable?: boolean }} [opts]
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function hydrateRows(rows, { keepUnreadable = false } = {}) {
    if (!Array.isArray(rows) || rows.length === 0) return rows || [];
    /** @type {Map<string, Promise<Buffer|null>>} */
    const keys = new Map();
    /** @type {Array<Record<string, any>>} */
    const out = [];
    for (const row of rows) {
        if (!_rowIsSealed(row)) { out.push(hydrate(row, null)); continue; }
        const scope = row.project_id ? `p:${row.project_id}|${row.user_id}` : `u:${row.user_id}`;
        if (!keys.has(scope)) keys.set(scope, resolveReadKey(row));
        const key = await keys.get(scope);
        try {
            out.push(hydrate(row, key));
        } catch (err) {
            if (!(err instanceof FieldDecryptError)) throw err;
            log.error(`[MemoryCrypto] memory ${row.id} could not be opened: ${err.message}`);
            if (keepUnreadable) {
                /** @type {Record<string, any>} */
                const stub = { ...row, unreadable: true };
                for (const f of SEALED_FIELDS) stub[f] = isEnvelope(row[f]) ? '' : row[f];
                delete stub.embedding_enc;
                delete stub.key_hash;
                stub.embedding = null;
                out.push(stub);
            }
        }
    }
    return out;
}

module.exports = {
    SEALED_FIELDS,
    ENVELOPE_LIKE,
    PLAINTEXT_WRITE,
    memoryKeys,
    memoryAad,
    canonicalKey,
    canonicalParts,
    keyHashForWrite,
    keyHashCandidates,
    resolveWriteContext,
    resolveReadKey,
    sealFields,
    sealEmbedding,
    hydrate,
    hydrateRows,
};
