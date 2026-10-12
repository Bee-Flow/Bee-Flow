// @typecheck
/**
 * Per-user tokenization vault — the durable token ↔ value dictionary.
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * Privacy Shield token maps used to be scoped to a single conversation. The
 * same colleague was `[person_1]` in one chat, `[person_4]` in the next, and
 * `[person_2]` in a notebook — so the user could not build a mental model of
 * their own redactions, and the model could not carry a reference across
 * conversations. The vault makes a value's token STABLE for a user: detect
 * "Theodorus van der Brug" anywhere, get the same token every time.
 *
 * ── Three rules that keep it correct ────────────────────────────────────────
 *
 *   1. The CONVERSATION map always wins inside its own conversation. Nothing
 *      here ever changes what an existing `[person_1]` in a stored message
 *      means; restoration does not consult the vault at all. Otherwise
 *      introducing the vault would retroactively rewrite history.
 *   2. A vault hit whose token is ALREADY taken in that conversation by a
 *      different value is discarded, and a fresh token is minted instead.
 *   3. Counters are high-water marks in their own table, never derived by
 *      scanning entries. A high-water must never decrease — including after
 *      eviction — or an evicted number would be reissued to a different value
 *      and two people would collide on one token across time.
 *
 * ── Why norm_key is an HMAC and not a hash ──────────────────────────────────
 *
 * Lookup is by value, so the value needs an index. A plain SHA-256 of
 * "tomsmit@beeflow.nl" would let anyone holding a database dump CONFIRM a guess
 * — offline, instantly, for every entry — which leaks precisely what the vault
 * exists to protect. It is therefore a keyed blind index: HMAC-SHA256 under a
 * key derived from the user's DEK, useless without that key.
 *
 * ── Why it is not a policy surface ──────────────────────────────────────────
 *
 * Every entry in `SURFACES` is a toggle an admin can switch off. This store is
 * a long-lived accumulation of raw PII across all of a user's conversations,
 * and nothing searches it in SQL, so an "off" switch would have a real cost and
 * no benefit. It encrypts whenever a key resolves, on every tier — matching the
 * always-on posture of orgVault and automation_credentials.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { encryptField, decryptField } = require('./lib/fieldEnvelope');
const log = require('../telemetry/log');

/**
 * Hard cap per user. Beyond this, least-recently-used entries are dropped.
 * Sized well above the per-conversation cap (2 000 / 5 000 in dlpRunner)
 * because this accumulates across every conversation a user ever has.
 */
const MAX_ENTRIES_PER_USER = 20_000;

const initVaultTables = makeStoreInit('PiiVault', _initVaultTables);

async function _initVaultTables() {
    await exec(`
        CREATE TABLE IF NOT EXISTS pii_vault_entries (
            id            TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL,
            category      TEXT NOT NULL,
            token         TEXT NOT NULL,
            norm_key      TEXT NOT NULL,
            value_enc     TEXT NOT NULL,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            use_count     INTEGER NOT NULL DEFAULT 1
        )
    `);
    // The two uniqueness guarantees the design rests on: one token per value,
    // and one value per token. Both are per user.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_vault_value
                ON pii_vault_entries(user_id, category, norm_key)`);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pii_vault_token
                ON pii_vault_entries(user_id, token)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pii_vault_lru
                ON pii_vault_entries(user_id, last_used_at ASC)`);
    await exec(`
        CREATE TABLE IF NOT EXISTS pii_vault_counters (
            user_id    TEXT NOT NULL,
            category   TEXT NOT NULL,
            high_water INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, category)
        )
    `);
}

// ── Keys ────────────────────────────────────────────────────────────────────

/**
 * The vault's two keys, both derived from the user's escrowed DEK.
 *
 * The escrow — not the session DEK — because the vault is read by the DLP
 * runner (no session in scope) and written on every redaction, including from
 * background work. On `managed` the escrow IS the user's one key; on `zk` it is
 * the narrow escrow that also covers the conversation token maps.
 *
 * @returns {Promise<{ value: Buffer, index: Buffer }|null>}
 */
async function _vaultKeys(userId, orgId = undefined) {
    try {
        const { _escrowKey } = require('./agent/messageCrypto');
        const dek = await _escrowKey(userId, orgId);
        if (!dek) return null;
        return vaultKeysFromDek(dek);
    } catch (err) {
        log.warn(`[PiiVault] key unavailable for ${userId}: ${err.message}`);
        return null;
    }
}

/**
 * The two vault keys for an escrowed DEK. Exported so the encryption backfill
 * derives them from the DEK resolveCrypto already handed it (backgroundKey IS
 * the escrow key on both encrypting tiers) instead of copying the HKDF labels.
 * @param {Buffer} dek
 * @returns {{ value: Buffer, index: Buffer }}
 */
function vaultKeysFromDek(dek) {
    return {
        value: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.from('beeflow:piivault:v1'), 'value', 32)),
        index: Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.from('beeflow:piivault:v1'), 'index', 32)),
    };
}

/** Comparison form of a value: case-, punctuation- and whitespace-insensitive. */
function normaliseValue(value) {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Blind index for (category, value).
 *
 * Falls back to a plain digest ONLY when no key can be derived, which is the
 * same install state in which the value itself is stored in the clear — so it
 * reveals nothing the row next to it does not already.
 */
function blindIndex(category, value, keys) {
    const norm = `${category}|${normaliseValue(value)}`;
    return keys
        ? crypto.createHmac('sha256', keys.index).update(norm).digest('hex')
        : crypto.createHash('sha256').update(norm).digest('hex');
}

function _aad(userId, category) {
    return `bfvault:v1:${userId}:${category}`;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Look up existing tokens for a batch of (category, value) candidates.
 *
 * Batched on purpose: a single turn can detect dozens of entities, and one
 * query per entity would put the vault on the critical path of every chat.
 *
 * @param {string} userId
 * @param {Array<{category: string, value: string}>} candidates
 * @returns {Promise<Map<string, {token: string, value: string}>>} keyed `category|normalisedValue`
 */
async function lookupTokens(userId, candidates, orgId = undefined) {
    const out = new Map();
    if (!userId || !Array.isArray(candidates) || candidates.length === 0) return out;
    await initVaultTables();

    const keys = await _vaultKeys(userId, orgId);
    const byIndex = new Map();
    for (const c of candidates) {
        if (!c || !c.value) continue;
        const norm = normaliseValue(c.value);
        if (!norm) continue;
        byIndex.set(blindIndex(c.category, c.value, keys), { category: c.category, norm });
    }
    if (byIndex.size === 0) return out;

    const rows = await getAll(
        `SELECT category, token, norm_key, value_enc FROM pii_vault_entries
         WHERE user_id = $1 AND norm_key = ANY($2::text[])`,
        [userId, [...byIndex.keys()]]
    );

    for (const row of rows) {
        const hit = byIndex.get(row.norm_key);
        if (!hit) continue;
        let value;
        try {
            value = decryptField(row.value_enc, { key: keys?.value || null, aad: _aad(userId, row.category) });
        } catch (err) {
            // One unopenable entry must not fail the turn — the tokenizer just
            // mints a fresh token for that value.
            log.warn(`[PiiVault] entry for ${userId} could not be opened: ${err.message}`);
            continue;
        }
        out.set(`${row.category}|${hit.norm}`, { token: row.token, value });
    }
    return out;
}

/**
 * Per-category high-water marks. The tokenizer needs these as counter floors so
 * a freshly minted token cannot collide with one already issued in the vault.
 * @returns {Promise<Record<string, number>>}
 */
async function getCounterFloors(userId) {
    if (!userId) return {};
    await initVaultTables();
    const rows = await getAll('SELECT category, high_water FROM pii_vault_counters WHERE user_id = $1', [userId]);
    /** @type {Record<string, number>} */
    const out = {};
    for (const r of rows) out[r.category] = r.high_water;
    return out;
}

/**
 * Build the seed map + counter floors for one tokenisation call.
 *
 * This is THE entry point for readers. It lives here rather than in any one
 * caller because there are six places that call `tokenizeText` — the DLP
 * runner, direct chat via validateInputForPii, the attachment scanner, compose
 * scan, tool-result redaction and the automation engine. A vault hooked into
 * only one of them produces exactly the bug this function exists to fix: a
 * value gets a stable token in agent chat and a fresh one in direct chat.
 *
 * ── Precedence (the rules that stop history being rewritten) ────────────────
 *
 * An existing conversation's map may already say `[person_1]` is Alice while
 * the vault says it is Bob. The conversation ALWAYS wins inside its own
 * conversation — stored messages depend on it — so:
 *
 *   • a vault token already used in this conversation is discarded;
 *   • a vault value already tokenised in this conversation is discarded;
 *   • insertion order puts the conversation first, because tokenizeText builds
 *     its value→token index first-wins.
 *
 * Never throws. The vault is an enhancement to tokenisation, not a dependency:
 * if it is unavailable the caller tokenises exactly as it did before.
 *
 * @param {string|null} userId
 * @param {Array<{category?: string, text?: string}>} entities  detected entities
 * @param {object|Map|null} existingTokenMap  the conversation's accumulated map
 * @returns {Promise<{ tokenMap: object, counterFloors: object }>}
 */
async function buildSeed(userId, entities, existingTokenMap = null) {
    const merged = _asObject(existingTokenMap);
    if (!userId || !Array.isArray(entities) || entities.length === 0) {
        return { tokenMap: merged, counterFloors: {} };
    }
    try {
        const { _tokenCategoryKey } = require('../core/privacy/piiDetection');
        const candidates = entities
            .map(e => ({ category: _tokenCategoryKey(e), value: e && e.text }))
            .filter(c => c.value);
        if (candidates.length === 0) return { tokenMap: merged, counterFloors: {} };

        const [hits, counterFloors] = await Promise.all([
            lookupTokens(userId, candidates),
            getCounterFloors(userId),
        ]);

        const usedTokens = new Set(Object.keys(merged));
        const usedValues = new Set(Object.values(merged).map(v => normaliseValue(v)));
        for (const { token, value } of hits.values()) {
            if (usedTokens.has(token)) continue;
            if (usedValues.has(normaliseValue(value))) continue;
            merged[token] = value;
            usedTokens.add(token);
            usedValues.add(normaliseValue(value));
        }
        return { tokenMap: merged, counterFloors: counterFloors || {} };
    } catch (err) {
        log.warn(`[PiiVault] seed unavailable for ${userId}: ${err.message}`);
        return { tokenMap: merged, counterFloors: {} };
    }
}

/** Accept both a plain object and a Map — dlpRunner stores Maps internally. */
function _asObject(tokenMap) {
    const out = {};
    if (!tokenMap) return out;
    const pairs = tokenMap instanceof Map ? tokenMap.entries() : Object.entries(tokenMap);
    for (const [k, v] of pairs) out[k] = v;
    return out;
}

// ── Writes ──────────────────────────────────────────────────────────────────

const _TOKEN_RE = /^\[([a-z0-9_]+)_(\d+)\]$/;

/**
 * Record the tokens used in a turn.
 *
 * Idempotent by construction: `ON CONFLICT DO NOTHING` on the value index means
 * a repeat sighting bumps usage rather than duplicating, and the token index
 * means a token already assigned to a different value is left alone.
 *
 * Never throws. A vault write failing must not fail the chat turn that
 * triggered it — the conversation token map remains the authority for
 * restoring that conversation either way.
 *
 * @param {string} userId
 * @param {Record<string, string>} tokenMap token → real value
 * @returns {Promise<{ stored: number, bumped: number }>}
 */
async function recordTokens(userId, tokenMap, orgId = undefined) {
    const result = { stored: 0, bumped: 0 };
    if (!userId || !tokenMap || typeof tokenMap !== 'object') return result;
    const entries = Object.entries(tokenMap);
    if (entries.length === 0) return result;

    try {
        await initVaultTables();
        const keys = await _vaultKeys(userId, orgId);
        const highWater = {};

        for (const [token, value] of entries) {
            const m = _TOKEN_RE.exec(token);
            if (!m || !value) continue;
            const category = m[1];
            const idx = parseInt(m[2], 10);
            if (Number.isFinite(idx)) highWater[category] = Math.max(highWater[category] || 0, idx);

            const norm = normaliseValue(value);
            if (!norm) continue;
            const normKey = blindIndex(category, value, keys);
            const valueEnc = encryptField(String(value), {
                key: keys?.value || null,
                aad: _aad(userId, category),
                encrypt: !!keys,
            });

            const res = await run(
                `INSERT INTO pii_vault_entries (id, user_id, category, token, norm_key, value_enc)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT DO NOTHING`,
                [uuidv4(), userId, category, token, normKey, valueEnc]
            );
            if ((res?.rowCount ?? 0) > 0) {
                result.stored++;
            } else {
                // Already known — record the sighting. Drives the LRU and the
                // "used 14 times" column in the settings screen.
                const bumped = await run(
                    `UPDATE pii_vault_entries SET last_used_at = NOW(), use_count = use_count + 1
                     WHERE user_id = $1 AND category = $2 AND norm_key = $3`,
                    [userId, category, normKey]
                );
                if ((bumped?.rowCount ?? 0) > 0) result.bumped++;
            }
        }

        await _raiseHighWater(userId, highWater);
        await _evictIfOverCap(userId);
    } catch (err) {
        log.warn(`[PiiVault] recordTokens failed for ${userId}: ${err.message}`);
    }
    return result;
}

/**
 * Raise per-category high-water marks. GREATEST, never assignment: a counter
 * that can go down would reissue a token number to a different value.
 */
async function _raiseHighWater(userId, highWater) {
    for (const [category, value] of Object.entries(highWater)) {
        await run(
            `INSERT INTO pii_vault_counters (user_id, category, high_water)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, category)
             DO UPDATE SET high_water = GREATEST(pii_vault_counters.high_water, EXCLUDED.high_water)`,
            [userId, category, value]
        );
    }
}

/**
 * Drop least-recently-used entries once a user is over the cap.
 *
 * Counters are untouched, so an evicted token number is never handed to a
 * different value later. The user loses the stable mapping for that value —
 * a new sighting mints a new token — which is why it is logged.
 */
async function _evictIfOverCap(userId) {
    const row = await getOne('SELECT COUNT(*)::int AS n FROM pii_vault_entries WHERE user_id = $1', [userId]);
    const total = row?.n || 0;
    if (total <= MAX_ENTRIES_PER_USER) return 0;

    const excess = total - MAX_ENTRIES_PER_USER;
    const res = await run(
        `DELETE FROM pii_vault_entries WHERE id IN (
             SELECT id FROM pii_vault_entries WHERE user_id = $1
             ORDER BY last_used_at ASC LIMIT $2
         )`,
        [userId, excess]
    );
    const evicted = res?.rowCount ?? 0;
    if (evicted > 0) {
        log.warn(`[PiiVault] user ${userId} exceeded ${MAX_ENTRIES_PER_USER} entries; evicted ${evicted} least-recently-used`);
    }
    return evicted;
}

// ── User-facing ─────────────────────────────────────────────────────────────

/**
 * The user's own vault, decrypted, for the settings screen.
 * @returns {Promise<{entries: Array, total: number}>}
 */
async function listForUser(userId, { search = '', limit = 200, offset = 0, orgId = undefined } = {}) {
    if (!userId) return { entries: [], total: 0 };
    await initVaultTables();
    const keys = await _vaultKeys(userId, orgId);

    const countRow = await getOne('SELECT COUNT(*)::int AS n FROM pii_vault_entries WHERE user_id = $1', [userId]);
    const rows = await getAll(
        `SELECT id, category, token, value_enc, first_seen_at, last_used_at, use_count
         FROM pii_vault_entries WHERE user_id = $1
         ORDER BY last_used_at DESC LIMIT $2 OFFSET $3`,
        [userId, Math.min(limit, 500), offset]
    );

    const entries = [];
    for (const r of rows) {
        let value = null;
        try {
            value = decryptField(r.value_enc, { key: keys?.value || null, aad: _aad(userId, r.category) });
        } catch (_) {
            // Surfaced rather than hidden: an entry the server can no longer
            // open is exactly what the user should be able to see and delete.
            value = null;
        }
        // Search runs here, not in SQL — the values are ciphertext on disk and
        // the blind index only answers exact-value questions, not substrings.
        if (search && !(value || '').toLowerCase().includes(search.toLowerCase())
            && !r.token.toLowerCase().includes(search.toLowerCase())) continue;
        entries.push({
            id: r.id,
            category: r.category,
            token: r.token,
            value,
            unreadable: value === null,
            firstSeenAt: r.first_seen_at,
            lastUsedAt: r.last_used_at,
            useCount: r.use_count,
        });
    }
    return { entries, total: countRow?.n || 0 };
}

/**
 * Delete one entry. Scoped to the owner — there is no admin path to this data
 * anywhere, by design.
 *
 * The counter high-water is deliberately NOT lowered: the deleted token number
 * must never be reissued, or a `[person_7]` still sitting in an old stored
 * message would start resolving to somebody else.
 */
async function deleteEntry(userId, entryId) {
    if (!userId || !entryId) return false;
    await initVaultTables();
    const { rowCount } = await run('DELETE FROM pii_vault_entries WHERE id = $1 AND user_id = $2', [entryId, userId]);
    return rowCount > 0;
}

/** Empty a user's vault. Counters survive, for the reason in deleteEntry. */
async function clearForUser(userId) {
    if (!userId) return 0;
    await initVaultTables();
    const { rowCount } = await run('DELETE FROM pii_vault_entries WHERE user_id = $1', [userId]);
    return rowCount ?? 0;
}

/**
 * Full erasure — GDPR right-to-erasure and user deletion. Unlike clearForUser
 * this DOES drop the counters, because the user and every message that could
 * reference a token are going away together.
 */
async function purgeUser(userId) {
    if (!userId) return;
    await initVaultTables();
    await run('DELETE FROM pii_vault_entries WHERE user_id = $1', [userId]);
    await run('DELETE FROM pii_vault_counters WHERE user_id = $1', [userId]);
}

module.exports = {
    initVaultTables,
    MAX_ENTRIES_PER_USER,
    normaliseValue,
    blindIndex,
    vaultKeysFromDek,
    vaultAad: _aad,
    lookupTokens,
    getCounterFloors,
    buildSeed,
    recordTokens,
    listForUser,
    deleteEntry,
    clearForUser,
    purgeUser,
};

// Awaitbare init-ingang voor migrateDb.
module.exports.initDB = initVaultTables;
