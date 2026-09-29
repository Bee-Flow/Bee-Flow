// @typecheck
/**
 * PII scan ledger — a durable memo of the guard's verdict for one segment.
 *
 * WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
 * Rows hold OFFSETS ONLY: `[{o,l,c,lb,cf}]` = offset, length, category, label,
 * confidence. Never `entity.text`, never tokenised text, never a token map.
 * That is possible because `tokenizeText` re-slices every value out of the live
 * text (core/piiDetection.js:860-868) and only falls back to `entity.text` when
 * the offsets are out of range — which a ledger hit never is, because the hit
 * requires byte-identical text. So this table cannot contain a string that is
 * not already in the tenant's own document, which is a materially weaker
 * exposure than `notebooks.pii_token_map` (real values) sitting next to it.
 *
 * WHY POSTGRES AND NOT REDIS
 * Redis is optional in this codebase; a Redis-backed ledger would be a silent
 * no-op on every self-host. And the owner's decision is "valid until the content
 * or the policy changes" — no expiry — which needs storage that survives a
 * restart and is shared by every replica.
 *
 * EVERY FAILURE RESOLVES TO A MISS. A missing table, a role without CREATE, a
 * dead connection: all of it degrades to "scan it again", never to a wrong
 * answer.
 */

const { exec, getAll, run } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

let _healthy = true;

const initDB = makeStoreInit('PiiScanLedger', _initDB);

// Swallows its own failure rather than rejecting, so the memo stays resolved
// and callers stop asking: every failure here resolves to a cache miss, and a
// retry loop against a table we are not allowed to create would only add load.
async function _initDB() {
    try {
        await exec(`
            CREATE TABLE IF NOT EXISTS pii_scan_ledger (
                scan_key      TEXT PRIMARY KEY,
                entities      JSONB NOT NULL,
                entity_count  INTEGER NOT NULL,
                char_len      INTEGER NOT NULL,
                key_v         INTEGER NOT NULL,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);
        // Retention/eviction walks this; nothing reads by anything but the PK.
        await exec(`CREATE INDEX IF NOT EXISTS idx_pii_ledger_lru ON pii_scan_ledger(last_used_at)`);
    } catch (err) {
        _healthy = false;
        log.warn(`[PiiScanLedger] init failed, ledger disabled: ${err.message}`);
    }
}

/**
 * @param {string[]} keys
 * @returns {Promise<Map<string, {entities: Array, charLen: number}>>}
 */
async function getMany(keys) {
    const out = new Map();
    if (!_healthy || !Array.isArray(keys) || keys.length === 0) return out;
    try {
        await initDB();
        if (!_healthy) return out;
        const rows = await getAll(
            `SELECT scan_key, entities, entity_count, char_len FROM pii_scan_ledger WHERE scan_key = ANY($1)`,
            [keys],
        );
        for (const r of rows || []) {
            const list = Array.isArray(r.entities) ? r.entities : [];
            // entity_count is stored alongside so a truncated/garbled JSONB is
            // detectable rather than silently under-redacting.
            if (list.length !== r.entity_count) continue;
            out.set(r.scan_key, { entities: list, charLen: r.char_len });
        }
        // Touch asynchronously: retention is LRU and a read is a use, but the
        // request must never wait on bookkeeping.
        if (out.size > 0) {
            run(`UPDATE pii_scan_ledger SET last_used_at = NOW() WHERE scan_key = ANY($1)`, [[...out.keys()]])
                .catch(() => { /* bookkeeping only */ });
        }
    } catch (err) {
        log.warn(`[PiiScanLedger] read failed, treating as miss: ${err.message}`);
    }
    return out;
}

/**
 * @param {Array<{key:string, entities:Array, charLen:number, keyVersion:number}>} rows
 */
async function putMany(rows) {
    if (!_healthy || !Array.isArray(rows) || rows.length === 0) return;
    try {
        await initDB();
        if (!_healthy) return;
        for (const r of rows) {
            await run(
                `INSERT INTO pii_scan_ledger (scan_key, entities, entity_count, char_len, key_v)
                 VALUES ($1, $2::jsonb, $3, $4, $5)
                 ON CONFLICT (scan_key) DO UPDATE SET last_used_at = NOW()`,
                [r.key, JSON.stringify(r.entities), r.entities.length, r.charLen, r.keyVersion],
            );
        }
    } catch (err) {
        log.warn(`[PiiScanLedger] write failed, verdict simply not memoised: ${err.message}`);
    }
}

/**
 * Drop rows from a superseded key version, and the coldest rows past the cap.
 * @param {{ keyVersion?: number, maxRows?: number }} [opts]
 */
async function prune({ keyVersion, maxRows = 500_000 } = {}) {
    if (!_healthy) return { deleted: 0 };
    let deleted = 0;
    try {
        await initDB();
        if (Number.isFinite(keyVersion)) {
            const r = await run(`DELETE FROM pii_scan_ledger WHERE key_v < $1`, [keyVersion]);
            deleted += r?.rowCount || 0;
        }
        const r2 = await run(
            `DELETE FROM pii_scan_ledger WHERE ctid IN (
                 SELECT ctid FROM pii_scan_ledger ORDER BY last_used_at DESC OFFSET $1
             )`,
            [maxRows],
        );
        deleted += r2?.rowCount || 0;
    } catch (err) {
        log.warn(`[PiiScanLedger] prune failed: ${err.message}`);
    }
    return { deleted };
}

module.exports = { initDB, getMany, putMany, prune, _isHealthy: () => _healthy };

// Awaitbare init-ingang voor migrateDb.
module.exports.initDB = initDB;
