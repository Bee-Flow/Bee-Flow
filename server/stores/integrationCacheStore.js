// @typecheck
/**
 * The DURABLE half of "ask this app only once" — one Postgres row per cached
 * integration answer, opt-in and off by default.
 *
 * The run memo (core/automationRunner/toolMemo.js) is the safe subset: it lives
 * on the run's ctx and cannot cross a user, an org, a run or a replica because
 * there is nowhere for it to go. This one deliberately outlives the run, so
 * every one of those guarantees has to be built rather than inherited.
 *
 * ── POSTGRES, NOT REDIS ─────────────────────────────────────────────
 * Redis is optional and empty on the default self-host core profile, so
 * anything that must work belongs here. It also gives the row an owner and an
 * expiry a DELETE can find, which is what makes erasure and retention true
 * rather than aspirational.
 *
 * ── THE KEY IS AN HMAC, NOT A HASH ──────────────────────────────────
 * A plain sha256 of the call is reversible in practice: the argument space of
 * a real look-up is tiny ({"email":"someone@a-company.com"}), so anyone holding
 * a database dump could confirm which addresses an organisation looked up by
 * hashing candidates. The key is therefore an HMAC under a server-side secret,
 * which turns "guess and check" into something that needs the secret too. The
 * arguments themselves are never stored in any form.
 *
 * ── THE PAYLOAD IS ENCRYPTED AT REST ────────────────────────────────
 * The value is the RAW third-party response, taken before guardToolOutput runs
 * — that is what makes it reusable, and exactly what makes it sensitive: a
 * Gmail search result is somebody's mail. It goes through secretBox
 * (AES-256-GCM, per-feature salt) like every other stored payload in this
 * codebase, so an org's cached answers are not readable from a table dump.
 *
 * ── DEFENCE IN DEPTH ON THE LOOKUP ──────────────────────────────────
 * organization_id is bound INTO the key and also compared in the WHERE clause.
 * The second one is redundant while the first is correct; it is there so that a
 * future bug in key construction cannot become a cross-tenant read.
 *
 * ── THE TTL IS A CEILING, NOT A CONTRACT ────────────────────────────
 * expires_at is stamped at write time, so it records the policy as it stood
 * then. `get` therefore takes the CURRENT window too and refuses anything
 * older, and the settings route shrinks the stored rows on a reduction. An
 * admin who drops the window after noticing stale data means "now", not "in
 * another 59 minutes".
 *
 * ── THE QUOTA REFUSES, IT DOES NOT EVICT ────────────────────────────
 * Per org: MAX_ROWS_PER_ORG rows and MAX_BYTES_PER_ORG of stored payload.
 * Over either, the write is refused and the caller counts a refusal. Evicting
 * would drop an answer a running automation is about to read; a refusal is just a
 * miss, and a miss makes the call for real.
 */

'use strict';

const crypto = require('crypto');
const { run, getOne } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { createSecretBox } = require('../utils/secretBox');
const log = require('../telemetry/log');

const TABLE = 'integration_response_cache';

/**
 * The per-entry ceiling a caller gets when it does not name one. It used to be
 * optional (`if (maxBytes && …)`), so a caller that simply forgot the argument
 * had NO size limit at all — one 40 MB response and the org's whole budget is
 * one row. Mirrors toolMemo's MAX_ENTRY_BYTES; kept as a literal rather than
 * imported so a store does not reach up into the runner.
 */
const MAX_ENTRY_BYTES = 262_144;

/**
 * The per-organisation ceiling. There was none: only a TTL, which bounds how
 * LONG a row lives and says nothing about how many arrive per minute. A
 * higher-volume, author-controlled writer (http_request) makes that the
 * difference between a bounded table and an unbounded one.
 *
 * Over the cap the write is REFUSED, never evicted. Eviction would silently
 * drop an answer a running automation is about to read — a cache that loses the
 * entry it just stored is indistinguishable from one that is broken — whereas
 * a refusal is a miss, and a miss makes the call for real.
 */
const MAX_ROWS_PER_ORG = 5000;
const MAX_BYTES_PER_ORG = 64 * 1024 * 1024;

// Counting rows on every write would put a COUNT+SUM in front of each store.
// 60 seconds of drift only ever lets an org run slightly over its cap before
// the next refresh notices, which is the harmless direction.
const USAGE_TTL_MS = 60_000;
const REFUSAL_LOG_INTERVAL_MS = 3_600_000;

const _usage = new Map();          // orgId → { at, rowCount, bytes }
const _refusalLoggedAt = new Map();// orgId → epoch ms of the last ops line

// Resolved lazily, never defaulted: this cache holds third-party integration
// responses (mail, calendar, CRM rows), and a baked-in fallback would encrypt
// them under a constant published with the source. index.js refuses to boot
// without SESSION_SECRET, so this only fires for a module loaded outside the
// server — which is exactly where a silent public key would go unnoticed.
// Same hard-fail as supportInboxStore/storageProxy.
function sessionSecret() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) {
        throw new Error('[IntegrationCache] SESSION_SECRET must be set (≥32 chars) — it derives the AES-256 key for cached integration responses. See .env.example.');
    }
    return s;
}

// Distinct salt per feature — a SESSION_SECRET compromise scoped to one
// feature's blobs must not trivially decrypt another's (see secretBox).
let _box = null;
function box() {
    if (!_box) {
        _box = createSecretBox(
            sessionSecret(),
            'integration-response-cache-salt',
            { logPrefix: '[IntegrationCache]' },
        );
    }
    return _box;
}

let _keySecret = null;
function keySecret() {
    if (_keySecret === null) {
        _keySecret = crypto.createHash('sha256')
            .update(sessionSecret())
            .update('integration-response-cache-key')
            .digest();
    }
    return _keySecret;
}

/**
 * Digest the identity of a call. Takes the SAME parts as toolMemo.memoKey and
 * adds nothing: the two must agree about what "the same call" means, or a step
 * would be served one answer within a run and a different one across runs.
 */
function cacheKey(parts) {
    return crypto.createHmac('sha256', keySecret())
        .update(String(parts || ''))
        .digest('hex');
}

const initDB = makeStoreInit('IntegrationCache', _doInit);

async function _doInit() {
    // The schema lives in server/migrations/integration-response-cache-2026-09
    // so a DBA reading the migrations folder can see that this table exists.
    // This call is the belt: a fresh replica can reach a cache write before a
    // standalone `db:migrate` has run.
    //
    // The probe checks the COLUMN, not just the table: an installation that got
    // the table from this store's old lazy DDL has no payload_bytes, and
    // skipping on `to_regclass` alone would leave the quota counting NULLs
    // forever.
    // pg_attribute against the regclass, not information_schema by table NAME:
    // this box also carries per-tenant schemas, and a name match in one of
    // those would report a column the search_path cannot actually see.
    const probe = await getOne(
        `SELECT to_regclass('${TABLE}') AS t,
                (SELECT 1 FROM pg_attribute
                  WHERE attrelid = to_regclass('${TABLE}')
                    AND attname = 'payload_bytes' AND NOT attisdropped) AS c`,
    ).catch(() => null);
    if (!(probe?.t && probe?.c)) {
        await require('../migrations/integration-response-cache-2026-09').up();
    }
    // Runs regardless of the probe above, because half of it stamps CONFIG
    // rows and no schema probe can see those. Self-limiting (it skips any row
    // that already carries `scopes`) and non-fatal: a cache that cannot
    // migrate its consent rows must still be able to miss rather than throw.
    await require('../migrations/integration-cache-scopes-2026-09').up()
        .catch(e => log.error('[IntegrationCache] scopes migration failed:', e.message));
}

/**
 * The cached answer, or null on a miss, an expiry, or anything at all going
 * wrong. A cache that throws is worse than a cache that misses: the caller's
 * only correct response to a failure here is to make the call for real.
 *
 * `maxAgeSeconds` is the CURRENT policy window, and checking it here is what
 * makes a shortened org TTL take effect immediately. `expires_at` is stamped
 * at write time, so lowering the window from 60 minutes to 5 would otherwise
 * keep serving the old answers for another 59 — which is the opposite of what
 * an admin who just noticed stale data is asking for. The write path shrinks
 * the stored rows too; this check is the half that is correct on every replica
 * the instant the policy changes.
 */
async function get(key, organizationId, { maxAgeSeconds = null } = {}) {
    if (!key || !organizationId) return null;
    const maxAge = (maxAgeSeconds === null || maxAgeSeconds === undefined)
        ? null : Math.max(1, Number(maxAgeSeconds) || 0);
    try {
        await initDB();
        const row = await getOne(
            `SELECT payload FROM ${TABLE}
              WHERE cache_key = $1 AND organization_id = $2 AND expires_at > NOW()
                AND ($3::int IS NULL OR created_at > NOW() - make_interval(secs => $3::int))`,
            [key, organizationId, maxAge],
        );
        if (!row) return null;
        // decrypt returns null on a tampered or unreadable blob — treated as a
        // miss, never as an empty answer.
        const value = box().decrypt(row.payload);
        if (value === null) {
            // And REAPED, not left to expire. A blob that will not decrypt
            // never will — a SESSION_SECRET rotation invalidates every row at
            // once — so leaving it costs a fetch and a failed decrypt on every
            // run that asks for it, for up to the full TTL.
            await run(`DELETE FROM ${TABLE} WHERE cache_key = $1 AND organization_id = $2`,
                [key, organizationId]);
            _usage.delete(organizationId);
            return null;
        }
        return { value };
    } catch (e) {
        log.warn('[IntegrationCache] read failed:', e.message);
        return null;
    }
}

/**
 * An EXPIRED row that is still inside a grace window — the input to a
 * conditional revalidation, never an answer on its own.
 *
 * The caller reissues the same GET with `If-None-Match` / `If-Modified-Since`
 * and only uses this value if the origin answers 304, so nothing here is ever
 * served stale: a real request decided it. That is the whole reason it is a
 * separate function from `get` rather than a widened `maxAgeSeconds` — `get`
 * hands back something to USE, this hands back something to CHECK.
 *
 * Deliberately NOT filtered by the current policy window: the entry is past its
 * TTL by construction, so `created_at > NOW() - maxAge` would reject every row
 * this exists to find. The grace window is the bound.
 * @param key
 * @param organizationId
 * @param {{ graceSeconds?: number }} [opts]
 */
async function getStale(key, organizationId, { graceSeconds } = {}) {
    if (!key || !organizationId) return null;
    const grace = Math.max(1, Number(graceSeconds) || 0);
    if (!grace) return null;
    try {
        await initDB();
        const row = await getOne(
            `SELECT payload FROM ${TABLE}
              WHERE cache_key = $1 AND organization_id = $2
                AND expires_at <= NOW()
                AND expires_at > NOW() - make_interval(secs => $3::int)`,
            [key, organizationId, grace],
        );
        if (!row) return null;
        const value = box().decrypt(row.payload);
        if (value === null) {
            // Same reaping as `get`: a blob that will not decrypt never will.
            await run(`DELETE FROM ${TABLE} WHERE cache_key = $1 AND organization_id = $2`,
                [key, organizationId]);
            _usage.delete(organizationId);
            return null;
        }
        return { value };
    } catch (e) {
        log.warn('[IntegrationCache] stale read failed:', e.message);
        return null;
    }
}

/**
 * A 304 said the stored body is still current: push its expiry out by one
 * window. Returns true when a row was actually refreshed.
 *
 * `created_at` moves too. It is what `get`'s `maxAgeSeconds` compares against,
 * so leaving it would have the row refused by the very next look-up — the
 * revalidation would then repeat on every single call, which is the opposite of
 * what it is for.
 */
async function touch(key, organizationId, ttlSeconds) {
    if (!key || !organizationId) return false;
    const secs = Math.max(1, Number(ttlSeconds) || 0);
    try {
        await initDB();
        const r = await run(
            `UPDATE ${TABLE}
                SET expires_at = NOW() + make_interval(secs => $3::int), created_at = NOW()
              WHERE cache_key = $1 AND organization_id = $2`,
            [key, organizationId, secs],
        );
        return (r?.rowCount || 0) > 0;
    } catch (e) {
        log.warn('[IntegrationCache] touch failed:', e.message);
        return false;
    }
}

/**
 * What this organisation is currently holding — live rows and stored bytes.
 * Memoised for USAGE_TTL_MS because it sits in front of every write.
 */
async function usageForOrg(organizationId) {
    const hit = _usage.get(organizationId);
    if (hit && (Date.now() - hit.at) < USAGE_TTL_MS) return hit;
    const row = await getOne(
        `SELECT COUNT(*)::int AS row_count, COALESCE(SUM(payload_bytes), 0)::bigint AS byte_count
           FROM ${TABLE} WHERE organization_id = $1 AND expires_at > NOW()`,
        [organizationId],
    );
    const usage = { at: Date.now(), rowCount: Number(row?.row_count) || 0, bytes: Number(row?.byte_count) || 0 };
    // One entry per org that has written recently. A box with thousands of
    // orgs would otherwise accumulate them for the lifetime of the process.
    if (_usage.size > 500) _usage.clear();
    _usage.set(organizationId, usage);
    return usage;
}

/** Forget the memoised usage — after anything that deletes rows. */
function invalidateUsage(organizationId) {
    if (organizationId) _usage.delete(organizationId);
    else _usage.clear();
}

/**
 * One ops line per org per hour. A quota that refuses silently presents as
 * "the cache stopped working" with nothing in the log to name the org or the
 * cap — and a per-write log line on a hot loop is its own incident.
 */
function noteRefusal(organizationId, usage) {
    const last = _refusalLoggedAt.get(organizationId) || 0;
    if (Date.now() - last < REFUSAL_LOG_INTERVAL_MS) return;
    _refusalLoggedAt.set(organizationId, Date.now());
    log.warn(`[IntegrationCache] org ${organizationId} is at its cache quota`
        + ` (${usage.rowCount}/${MAX_ROWS_PER_ORG} entries, ${usage.bytes}/${MAX_BYTES_PER_ORG} bytes)`
        + ' — new answers are not being stored');
}

/**
 * Remember an answer. Returns false when it was refused or failed, so the
 * caller can count stores honestly.
 *
 * An oversized answer is REFUSED rather than truncated: a truncated payload
 * replayed as if whole is the failure where a collection step then reports
 * "arrayRef did not resolve to an array". The same reasoning is why being over
 * the ORG quota refuses instead of evicting.
 */
async function put({ key, organizationId, userId, toolName, value, ttlSeconds, maxBytes = MAX_ENTRY_BYTES }) {
    if (!key || !organizationId || !userId) return false;
    let payload;
    let payloadBytes;
    try {
        const json = JSON.stringify(value);
        if (json === undefined) return false;
        // maxBytes measures the ANSWER; payload_bytes measures what lands in
        // the column (ciphertext, hex). The entry cap is about a payload a
        // automation has to be handed back whole; the org budget is about the
        // size of the table.
        if (Buffer.byteLength(json, 'utf8') > maxBytes) return false;
        payload = box().encrypt(value);
        payloadBytes = Buffer.byteLength(payload, 'utf8');
    } catch (_) {
        return false;
    }
    try {
        await initDB();
        const usage = await usageForOrg(organizationId);
        if (usage.rowCount >= MAX_ROWS_PER_ORG || (usage.bytes + payloadBytes) > MAX_BYTES_PER_ORG) {
            noteRefusal(organizationId, usage);
            return false;
        }
        await run(
            `INSERT INTO ${TABLE} (cache_key, organization_id, user_id, tool_name, payload, payload_bytes, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7::int))
             ON CONFLICT (cache_key) DO UPDATE
                SET payload = EXCLUDED.payload,
                    payload_bytes = EXCLUDED.payload_bytes,
                    expires_at = EXCLUDED.expires_at,
                    created_at = NOW()`,
            // make_interval rather than ($7 || ' seconds')::interval: with both
            // sides of that concatenation untyped, Postgres cannot resolve the
            // operator and rejects the statement outright.
            [key, organizationId, userId, String(toolName || ''), payload, payloadBytes,
                Math.max(1, Number(ttlSeconds) || 300)],
        );
        // Count it against the memoised usage rather than waiting for the next
        // refresh: a forEach can store hundreds of rows inside one 60-second
        // window. An ON CONFLICT replace makes this an over-count, which only
        // ever refuses EARLIER — the safe direction — and the refresh corrects it.
        usage.rowCount += 1;
        usage.bytes += payloadBytes;
        return true;
    } catch (e) {
        log.warn('[IntegrationCache] write failed:', e.message);
        return false;
    }
}

/**
 * Pull every stored row for an org back inside `ttlSeconds` of its creation.
 * Called when an admin SHORTENS the window: expires_at was stamped at write
 * time, so without this the rows already in the table keep their old, longer
 * expiry and the setting means nothing until they age out on their own.
 *
 * Only ever shortens — LEAST plus the narrowing WHERE — so re-running it or
 * calling it on a widened window does nothing.
 */
async function shrinkTtlForOrg(organizationId, ttlSeconds) {
    const secs = Math.max(1, Number(ttlSeconds) || 0);
    if (!organizationId || !secs) return 0;
    try {
        await initDB();
        const r = await run(
            `UPDATE ${TABLE}
                SET expires_at = LEAST(expires_at, created_at + make_interval(secs => $2::int))
              WHERE organization_id = $1
                AND expires_at > created_at + make_interval(secs => $2::int)`,
            [organizationId, secs],
        );
        invalidateUsage(organizationId);
        return r?.rowCount || 0;
    } catch (e) {
        log.warn('[IntegrationCache] ttl shrink failed:', e.message);
        return 0;
    }
}

/** Drop everything past its expiry. Idempotent — safe on multi-replica runs. */
async function pruneExpired() {
    try {
        await initDB();
        const r = await run(`DELETE FROM ${TABLE} WHERE expires_at <= NOW()`);
        invalidateUsage();
        return r?.rowCount || 0;
    } catch (e) {
        log.warn('[IntegrationCache] prune failed:', e.message);
        return 0;
    }
}

/**
 * Erasure. A cached answer was fetched with this person's credentials and is
 * about the things they can see, so it goes with the account — the same reason
 * automation_credentials and the PII vault do.
 */
async function purgeForUser(userId) {
    if (!userId) return 0;
    try {
        await initDB();
        const r = await run(`DELETE FROM ${TABLE} WHERE user_id = $1`, [userId]);
        // The row's org is not in hand here, so drop every memoised count
        // rather than leave one org believing it still holds what was erased.
        invalidateUsage();
        return r?.rowCount || 0;
    } catch (e) {
        log.warn('[IntegrationCache] user purge failed:', e.message);
        return 0;
    }
}

/**
 * Everything an organisation has cached. Called when an admin switches the
 * feature OFF: leaving the rows behind would mean "off" still had stored
 * answers sitting in the database, which is not what anyone reads it as.
 */
async function purgeForOrg(organizationId) {
    if (!organizationId) return 0;
    try {
        await initDB();
        const r = await run(`DELETE FROM ${TABLE} WHERE organization_id = $1`, [organizationId]);
        invalidateUsage(organizationId);
        return r?.rowCount || 0;
    } catch (e) {
        log.warn('[IntegrationCache] org purge failed:', e.message);
        return 0;
    }
}

/**
 * Counters for the org settings screen — never a key, never a payload.
 *
 * `expiredEntries` is counted separately rather than filtered out: the prune
 * runs hourly, so between passes an org can hold thousands of expired-but-
 * present rows while a screen that reported only live ones told them zero. The
 * purge button deletes everything, so the count was the only thing that was
 * wrong. `bytes` is what the org is actually storing, which is the number an
 * admin needs before the quota starts refusing.
 */
async function statsForOrg(organizationId) {
    const empty = { entries: 0, expiredEntries: 0, bytes: 0 };
    if (!organizationId) return empty;
    try {
        await initDB();
        const row = await getOne(
            `SELECT (COUNT(*) FILTER (WHERE expires_at > NOW()))::int  AS entries,
                    (COUNT(*) FILTER (WHERE expires_at <= NOW()))::int AS expired_entries,
                    COALESCE(SUM(payload_bytes) FILTER (WHERE expires_at > NOW()), 0)::bigint AS bytes
               FROM ${TABLE} WHERE organization_id = $1`,
            [organizationId],
        );
        return {
            entries: Number(row?.entries) || 0,
            expiredEntries: Number(row?.expired_entries) || 0,
            bytes: Number(row?.bytes) || 0,
        };
    } catch (_) {
        return empty;
    }
}

module.exports = {
    cacheKey, get, getStale, touch, put, shrinkTtlForOrg, pruneExpired,
    purgeForUser, purgeForOrg, statsForOrg, invalidateUsage,
    TABLE, MAX_ENTRY_BYTES, MAX_ROWS_PER_ORG, MAX_BYTES_PER_ORG,
};

// Awaitbare init-ingang voor migrateDb (initDB is al een promise-memo).
module.exports.initDB = initDB;
