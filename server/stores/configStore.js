// @typecheck
/**
 * Config Store - PostgreSQL-backed key-value configuration
 * Stores sensitive config like API keys in beeflow_core
 *
 * Sensitive values (API keys, secrets) are encrypted at rest
 * using AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 *
 * ──── MASTER_ENCRYPTION_KEY rotation ──────────────────────────────────
 * Use scripts/rotate-master-key.js. Operational steps:
 *   1. Generate a new key:  openssl rand -hex 32
 *   2. Set MASTER_ENCRYPTION_KEY_NEW in secrets; redeploy (servers boot
 *      with BOTH the old and new env vars). The cluster keeps reading
 *      with the old key during this window.
 *   3. Run `node scripts/rotate-master-key.js` on one node — it decrypts
 *      every config row with OLD and re-encrypts with NEW. Idempotent.
 *   4. Promote NEW → MASTER_ENCRYPTION_KEY in secrets; drop the _NEW
 *      alias on next deploy.
 * Documented inline rather than only in a runbook so anyone touching this
 * file sees the procedure.
 */

const { run, getOne, getAll, exec, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { Client } = require('pg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('../telemetry/log');

// ── Encryption helpers for secrets at rest ──────────────────────
// Derives a 256-bit key from MASTER_ENCRYPTION_KEY using HKDF-SHA256.
//
// Two derivation contexts are supported:
//   • 'beeflow:config-secrets:v1'         — default; used by all rows that
//      don't belong to a single org (provider client secrets, FX rates, …)
//      and by every legacy row written before per-org HKDF landed.
//   • 'beeflow:config-secrets:v1:<orgId>' — used for `org_<orgId>_*` keys.
//      A master-key rotation re-encrypts all rows under the new master, but
//      per-org rows additionally bind to the org id so a leak of one org's
//      derived key doesn't reveal another org's.
//
// The envelope records the context as `keyContext: '<orgId>' | undefined`
// so decrypt can pick the right derivation without scanning the key name.

const ORG_KEY_PREFIX_RE = /^org_([^_]+)_/;

function _inferOrgIdFromKey(key) {
    if (!key || typeof key !== 'string') return null;
    const m = key.match(ORG_KEY_PREFIX_RE);
    return m ? m[1] : null;
}

function _deriveKey(orgId = null) {
    const master = process.env.MASTER_ENCRYPTION_KEY;
    if (!master) throw new Error('MASTER_ENCRYPTION_KEY env var is required for config encryption');
    const info = orgId
        ? `beeflow:config-secrets:v1:${orgId}`
        : 'beeflow:config-secrets:v1';
    return crypto.createHmac('sha256', master).update(info).digest();
}

function _getServerEncryptionKey() {
    return _deriveKey(null);
}

// ── Rate-limited decrypt failure logging ────────────────────────
// Batches decrypt errors into a single summary per interval
let _decryptFailCount = 0;
let _decryptFailTimer = null;
const DECRYPT_FAIL_LOG_INTERVAL_MS = 60_000; // 1 minute

function _logDecryptFailure() {
    _decryptFailCount++;
    if (!_decryptFailTimer) {
        _decryptFailTimer = setTimeout(() => {
            if (_decryptFailCount > 0) {
                log.warn(`[ConfigStore] Failed to decrypt ${_decryptFailCount} value(s) in the last 60s — check MASTER_ENCRYPTION_KEY or re-enter API keys via Admin UI`);
                _decryptFailCount = 0;
            }
            _decryptFailTimer = null;
        }, DECRYPT_FAIL_LOG_INTERVAL_MS);
        // Don't hold the process open for this timer
        if (_decryptFailTimer.unref) _decryptFailTimer.unref();
    }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a JSON-encoded envelope: { _encrypted: "config-v1", iv, authTag, data }.
 *
 * When `orgId` is supplied, derives a per-org key via HKDF info string
 * `beeflow:config-secrets:v1:<orgId>` and records the org context in the
 * envelope so decrypt can rebuild the right key.
 */
function encryptValue(plaintext, orgId = null) {
    if (!plaintext) return plaintext;
    const key = _deriveKey(orgId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const env = {
        _encrypted: 'config-v1',
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        data: encrypted.toString('hex'),
    };
    if (orgId) env.keyContext = orgId;
    return JSON.stringify(env);
}

/**
 * Decrypt an AES-256-GCM encrypted envelope.
 *
 *   • Envelopes with `keyContext: '<orgId>'` derive the per-org key.
 *   • Envelopes without keyContext use the legacy single-tenant key.
 *   • Plaintext values pass through unchanged.
 *
 * On failure, returns null (caller surfaces via the rate-limited logger).
 */
function decryptValue(stored) {
    if (!stored) return stored;

    // Parse if string
    let envelope = stored;
    if (typeof stored === 'string') {
        try { envelope = JSON.parse(stored); } catch (_) { return stored; /* plaintext */ }
    }

    // Not an encrypted envelope — return as-is (legacy migration)
    if (!envelope || typeof envelope !== 'object' || envelope._encrypted !== 'config-v1') {
        // If it was parsed from JSON but isn't an encrypted envelope, return original string
        return typeof stored === 'string' ? stored : JSON.stringify(stored);
    }

    try {
        const orgCtx = (typeof envelope.keyContext === 'string' && envelope.keyContext) ? envelope.keyContext : null;
        const key = _deriveKey(orgCtx);
        const iv = Buffer.from(envelope.iv, 'hex');
        const authTag = Buffer.from(envelope.authTag, 'hex');
        const data = Buffer.from(envelope.data, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        return decipher.update(data) + decipher.final('utf8');
    } catch (err) {
        _logDecryptFailure();
        return null;
    }
}

// ── In-memory cache (avoids DB round-trips for hot-path reads) ──────
// Config values change very rarely (monthly). Caching them for 60s
// eliminates ~6 DB queries per KB search call.
const CACHE_TTL_MS = 60_000; // 60 seconds
const _cache = new Map(); // key → { value, ts }

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry) return undefined; // undefined = cache miss
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
        _cache.delete(key);
        return undefined;
    }
    return entry.value; // may be null (config key exists but has no value)
}

function _cacheSet(key, value) {
    _cache.set(key, { value, ts: Date.now() });
}

function _cacheInvalidate(key) {
    _cache.delete(key);
}

// ── Cross-replica cache invalidation via Postgres LISTEN/NOTIFY ─────
// The cache above is per-process. In a multi-replica deployment a write on one
// replica invalidates only THAT replica's Map; other replicas keep serving the
// stale value until their 60s TTL lapses. That is precisely what made CMS edits
// appear to "revert" (a save lands on pod A, the follow-up GET is load-balanced
// to pod B, which returns the pre-edit value). Broadcasting the invalidated KEY
// over a Postgres NOTIFY channel lets every replica drop its local entry within
// milliseconds. The payload carries the key only — NOTIFY caps at ~8000 bytes
// and values must never travel the channel.
const CONFIG_INVALIDATE_CHANNEL = 'beeflow_config_invalidate';

function _notifyInvalidate(key) {
    // Fire-and-forget: the INSERT/UPDATE/DELETE already committed (autocommit)
    // before this runs, so any replica that re-reads on receipt sees the new
    // row. Non-fatal on failure — the local cache is already busted and other
    // replicas self-heal within the TTL even if a NOTIFY is lost.
    run('SELECT pg_notify($1, $2)', [CONFIG_INVALIDATE_CHANNEL, String(key)]).catch(() => {});
}

// Apply an invalidation received from another replica. Empty payload = flush
// everything (used on listener (re)connect, when notifications may have been
// missed). Exported for tests. The listener can't tell a plain key from its
// secret twin, so both are dropped.
function _applyInvalidation(payload) {
    if (!payload) { _cache.clear(); return; }
    _cacheInvalidate(payload);
    _cacheInvalidate(`__secret__${payload}`);
}

let _listenerClient = null;
let _reconnectTimer = null;
let _listenerBackoffMs = 1000;
const _LISTENER_MAX_BACKOFF_MS = 30_000;

function _connString() {
    return process.env.CORE_DATABASE_URL
        || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core';
}

async function _startInvalidationListener() {
    // A dedicated Client, NOT a pooled connection: pooled clients get recycled,
    // which silently drops the LISTEN registration.
    const client = new Client({ connectionString: _connString(), application_name: 'beeflow-config-listener' });
    client.on('error', (e) => { log.warn('[ConfigStore] invalidation listener error:', e.message); _scheduleReconnect(); });
    client.on('end', () => _scheduleReconnect());
    client.on('notification', (msg) => {
        if (msg.channel !== CONFIG_INVALIDATE_CHANNEL) return;
        _applyInvalidation(msg.payload);
    });
    try {
        await client.connect();
        await client.query(`LISTEN ${CONFIG_INVALIDATE_CHANNEL}`);
        _listenerClient = client;
        _listenerBackoffMs = 1000;
        // A gap in the listener means missed invalidations — the only safe
        // recovery is to drop the whole local cache and let it re-warm.
        _cache.clear();
        log.info('[ConfigStore] cross-replica cache invalidation listener active');
    } catch (e) {
        log.warn('[ConfigStore] invalidation listener connect failed:', e.message);
        try { await client.end(); } catch (_) { /* already down */ }
        _scheduleReconnect();
    }
}

function _scheduleReconnect() {
    if (_listenerClient) {
        try { _listenerClient.removeAllListeners(); _listenerClient.end().catch(() => {}); } catch (_) { /* noop */ }
        _listenerClient = null;
    }
    if (_reconnectTimer) return;
    const delay = _listenerBackoffMs;
    _listenerBackoffMs = Math.min(_listenerBackoffMs * 2, _LISTENER_MAX_BACKOFF_MS);
    _reconnectTimer = setTimeout(() => { _reconnectTimer = null; _startInvalidationListener(); }, delay);
    if (_reconnectTimer.unref) _reconnectTimer.unref();
}

function _stopInvalidationListener() {
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_listenerClient) {
        try { _listenerClient.removeAllListeners(); _listenerClient.end().catch(() => {}); } catch (_) { /* noop */ }
        _listenerClient = null;
    }
}

// Start unless disabled (kill switch) or under test. Tests mock ../db but can't
// intercept `new Client()` from pg, so leaving this on would open a real socket.
if (process.env.NODE_ENV !== 'test' && process.env.CONFIG_INVALIDATION_LISTENER !== '0') {
    _startInvalidationListener().catch((e) => log.warn('[ConfigStore] listener bootstrap failed:', e.message));
}

// Schema init
const initDB = makeStoreInit('ConfigStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
}

async function getConfig(key) {
    // Check in-memory cache first
    const cached = _cacheGet(key);
    if (cached !== undefined) return cached;

    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row) {
        _cacheSet(key, null);
        return null;
    }
    let result;
    try {
        result = JSON.parse(row.value);
    } catch (e) {
        result = row.value;
    }
    _cacheSet(key, result);
    return result;
}

/**
 * Read a plain config value straight from the DB, bypassing (and refreshing)
 * the in-memory cache. The plain-config twin of getSecretFresh: each server
 * replica has its own 60s cache invalidated only on the replica that wrote, so
 * right after one replica persists a value another replica can serve the OLD
 * value for up to a minute (e.g. a CMS edit "reverts" when the follow-up GET
 * lands on a different pod). A fresh read closes that window for callers that
 * need strict read-your-writes (the admin editor payload). Also refreshes the
 * local cache so the stale entry self-heals.
 *
 * Note: unlike getConfig (which returns the SHARED cached object on a hit),
 * this always hands back a private JSON.parse copy — so callers that mutate the
 * result in place (getProject/getAdminPayload) can't corrupt a cached object.
 */
async function getConfigFresh(key) {
    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row) {
        _cacheSet(key, null);
        return null;
    }
    let result;
    try {
        result = JSON.parse(row.value);
    } catch (e) {
        result = row.value;
    }
    _cacheSet(key, result);
    return result;
}

async function setConfig(key, value) {
    await initDB();
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, stringValue]);
    _cacheInvalidate(key); // bust cache on write
    _notifyInvalidate(key); // and every other replica's cache
    return true;
}

/**
 * Atomic read-modify-write of a single config key, serialized across ALL
 * replicas by a Postgres advisory lock keyed on the config key. Use for values
 * that are concurrently read-modified-written (e.g. the CMS projects index blob)
 * where plain setConfig's last-write-wins would silently drop a concurrent
 * change — two site creates racing on different pods would otherwise lose one
 * index entry, orphaning a project.
 *
 * `mutatorFn(current)` receives the current parsed value (or null) and returns
 * the new value. It runs inside the locked transaction and MAY be retried, so
 * it must be pure (no side effects). Busts + broadcasts the cache on commit.
 */
async function mutateConfig(key, mutatorFn) {
    await initDB();
    const next = await withTransaction(async (client) => {
        // Only serializes writers of THIS key — hashtext maps the key to the
        // bigint the advisory-lock API expects. Released automatically on
        // COMMIT/ROLLBACK (xact-scoped).
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        const row = await client.query('SELECT value FROM config WHERE key = $1', [key]);
        let current = null;
        if (row.rows.length) {
            try { current = JSON.parse(row.rows[0].value); } catch (_) { current = row.rows[0].value; }
        }
        const updated = mutatorFn(current);
        const stringValue = typeof updated === 'object' ? JSON.stringify(updated) : String(updated);
        await client.query(
            `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, stringValue]
        );
        return updated;
    });
    _cacheInvalidate(key);
    _notifyInvalidate(key);
    return next;
}

/**
 * Batched plain-config read: one SELECT for many keys. Returns { [key]: value }
 * with getConfig's JSON-parse semantics; absent keys are simply omitted.
 * Deliberately BYPASSES the per-key cache in both directions — bulk callers
 * (e.g. org-wide learning aggregation) would otherwise flush the hot cache with
 * hundreds of one-shot entries. Not for secrets (no decryption).
 */
async function getConfigsByKeys(keys) {
    const wanted = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string' && k) : [];
    if (!wanted.length) return {};
    await initDB();
    const rows = await getAll('SELECT key, value FROM config WHERE key = ANY($1::text[])', [wanted]);
    const out = {};
    for (const row of rows || []) {
        try { out[row.key] = JSON.parse(row.value); }
        catch (_) { out[row.key] = row.value; }
    }
    return out;
}

/**
 * Heuristic: extract `{orgId, integration}` from a secret key when it follows
 * one of our known naming conventions. The key set evolves; this is best-
 * effort so the audit entry carries useful context without forcing every
 * call site to thread an explicit context object.
 *
 * Examples handled:
 *   org_webhook_signing_key_<orgId>              → org_webhook_signing_key
 *   connector_tenant_key_<orgId>                 → connector_tenant_key
 *   azure_<orgId>_client_secret                  → azure (org-scoped)
 *   <provider>_api_key                           → <provider> (global)
 *   stripe_webhook_secret                        → stripe (global)
 */
function _inferAuditFromKey(key) {
    if (typeof key !== 'string' || !key) return { integration: 'unknown', orgId: null };
    let integration = null;
    let orgId = null;
    // org-scoped prefixes (longest first)
    const orgPrefixes = [
        ['org_webhook_signing_key_', 'webhook_signer'],
        ['connector_tenant_key_', 'nextcloud_connector'],
        ['org_privacy_shield_', 'privacy_shield'],
    ];
    for (const [prefix, name] of orgPrefixes) {
        if (key.startsWith(prefix)) {
            return { integration: name, orgId: key.slice(prefix.length) || null };
        }
    }
    // Heuristic for `${provider}_*` (api_key, secret, token, etc).
    const m = key.match(/^([a-z0-9]+(?:[_-][a-z0-9]+)*?)(?:_(?:api_?key|secret|token|password|webhook_secret|client_secret))$/i);
    if (m) integration = m[1];
    return { integration: integration || 'unknown', orgId };
}

/**
 * Best-effort emit an access-audit entry for a credential change. Lazy-
 * required to avoid the circular configStore↔userStore load. Failures are
 * swallowed — auditing must never block a credential write.
 */
async function _auditCredentialChange(key, action, ctx) {
    try {
        const { logAccessAudit } = require('./userStore');
        const inferred = _inferAuditFromKey(key);
        const orgId = ctx?.orgId || inferred.orgId || null;
        const integration = ctx?.integration || inferred.integration || 'unknown';
        await logAccessAudit(
            `credential.${action}`,
            'credential',
            key,
            ctx?.userId || null,
            null,
            { integration, action },
            orgId,
        );
    } catch (_) { /* non-fatal */ }
}

/**
 * Store a sensitive value (API key, secret) encrypted at rest.
 * Uses AES-256-GCM with a key derived from MASTER_ENCRYPTION_KEY.
 *
 * Optional 3rd arg `auditCtx` carries audit-log context:
 *   { orgId?, userId?, integration? }
 * The key itself is recorded but never the value.
 */
async function setSecret(key, value, auditCtx = null) {
    await initDB();
    // Don't encrypt empty values
    if (!value || value === '') {
        const ok = await setConfig(key, '');
        _auditCredentialChange(key, 'clear', auditCtx).catch(() => {});
        return ok;
    }
    // Per-org HKDF context: `org_<orgId>_*` keys bind their derived key to
    // the org id so a compromise of one org's derived key doesn't leak
    // another org's secrets. Global keys (provider client secrets, FX rates,
    // …) continue to use the single-tenant info string.
    const orgCtx = _inferOrgIdFromKey(key);
    const encrypted = encryptValue(String(value), orgCtx);
    await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, encrypted]);
    _cacheInvalidate(key);
    _cacheInvalidate(`__secret__${key}`); // bust secret cache on write
    _notifyInvalidate(key);               // and every other replica's cache
    _auditCredentialChange(key, 'set', auditCtx).catch(() => {});
    return true;
}

/**
 * Atomic "store this secret only if the key is absent" — and ALWAYS return the
 * authoritative stored value (the winner's, which may be a concurrent caller's).
 *
 * Unlike setSecret (INSERT … ON CONFLICT DO UPDATE = last-write-wins), this uses
 * INSERT … ON CONFLICT DO NOTHING so that when many callers race to mint the
 * same key (e.g. concurrent connector bootstraps across replicas each minting a
 * random tenant key), exactly ONE value is ever stored and everyone reads it
 * back. This closes the tenant-key divergence at the DB — the only shared state
 * across server replicas. Returns the stored value, or null on failure.
 */
async function setSecretIfAbsent(key, value, auditCtx = null) {
    await initDB();
    if (!value || value === '') return await getSecret(key);
    const orgCtx = _inferOrgIdFromKey(key);
    const encrypted = encryptValue(String(value), orgCtx);
    const res = await run(`
        INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT(key) DO NOTHING
    `, [key, encrypted]);
    // Bust local caches (a prior getSecret may have cached `null` for this key)
    // so the read-back hits the DB and returns the authoritative winner.
    _cacheInvalidate(key);
    _cacheInvalidate(`__secret__${key}`);
    const inserted = (res && (res.rowCount === 1 || res.rowCount === undefined && res.rows));
    // Only broadcast when a row was actually minted — the losing racers wrote
    // nothing, so their peers' caches don't need busting.
    if (inserted) {
        _notifyInvalidate(key);
        _auditCredentialChange(key, 'set', auditCtx).catch(() => {});
    }
    return await getSecret(key);
}

/**
 * Retrieve a sensitive value, decrypting if it was encrypted.
 * Transparently handles legacy plaintext values (returns as-is).
 */
async function getSecret(key) {
    // Check in-memory cache first (decrypted values are cached)
    const cached = _cacheGet(`__secret__${key}`);
    if (cached !== undefined) return cached;

    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row || !row.value) {
        // Dual-read: a legacy per-user key with no `config` row may be backed by
        // a named integration connection (configStore stays authoritative when a
        // row IS present). Lazy require breaks the configStore↔connection cycle.
        // Not cached — a connection's value can change without busting this key.
        try {
            const fromConn = await require('./integrationConnectionStore').getLegacySecretValue(key);
            if (fromConn !== undefined) return fromConn;
        } catch (_) { /* fall through to null */ }
        _cacheSet(`__secret__${key}`, null);
        return null;
    }

    const rawValue = row.value;
    let result;

    // Try to parse as encrypted envelope
    try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1') {
            result = decryptValue(parsed);
        } else if (typeof parsed === 'string') {
            result = parsed;
        } else {
            result = rawValue;
        }
    } catch (_) {
        // Not JSON — plaintext legacy value
        result = rawValue;
    }

    _cacheSet(`__secret__${key}`, result);
    return result;
}

/**
 * Read a secret straight from the DB, bypassing (and refreshing) the in-memory
 * cache. Used on the connector-JWT verification path: each server replica has
 * its own 60s secret cache, so right after a tenant key is (re)minted on one
 * replica, another replica can still serve the OLD key for up to a minute and
 * reject the connector's valid new JWT with a 403. A fresh read closes that
 * window. Also refreshes the cache so the stale entry self-heals.
 */
async function getSecretFresh(key) {
    await initDB();
    const row = await getOne('SELECT value FROM config WHERE key = $1', [key]);
    if (!row || !row.value) { _cacheSet(`__secret__${key}`, null); return null; }
    let result;
    try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1') result = decryptValue(parsed);
        else if (typeof parsed === 'string') result = parsed;
        else result = row.value;
    } catch (_) { result = row.value; }
    _cacheSet(`__secret__${key}`, result);
    return result;
}

async function deleteConfig(key, auditCtx = null) {
    await initDB();
    const { rowCount } = await run('DELETE FROM config WHERE key = $1', [key]);
    _cacheInvalidate(key);
    _cacheInvalidate(`__secret__${key}`);
    if (rowCount > 0) _notifyInvalidate(key);
    // Audit deletions of secret-like keys so the trail captures revocations
    // (e.g. an admin clearing an org's Slack token). Plain config deletes
    // are noisy and not interesting from a security standpoint, so we gate
    // on the same heuristic the re-encryption migration uses.
    if (rowCount > 0 && _looksLikeSecretKey(key)) {
        _auditCredentialChange(key, 'delete', auditCtx).catch(() => {});
    }
    return rowCount > 0;
}

async function getAllConfig() {
    await initDB();
    const rows = await getAll('SELECT key, value FROM config');
    const result = {};
    for (const row of rows) {
        try {
            result[row.key] = JSON.parse(row.value);
        } catch (e) {
            result[row.key] = row.value;
        }
    }
    return result;
}

/**
 * List config KEYS matching a prefix — full keys, no values, no JSON.parse.
 *
 * Exists because the connector JWT middleware needs "which org ids have a
 * tenant key" on requests that carry no cookie session — and its fallback
 * was getAllConfig(): a full-table read + parse of every config row (user
 * prefs, CMS content, learning blobs) on EVERY embedded API call, which is
 * the single biggest reason Bee Flow-inside-Nextcloud felt slower than
 * standalone. `key` is the primary key, so this is an index-range read.
 */
async function listKeysWithPrefix(prefix) {
    if (!prefix || typeof prefix !== 'string') return [];
    await initDB();
    const escaped = prefix.replace(/([\\%_])/g, '\\$1');
    const rows = await getAll("SELECT key FROM config WHERE key LIKE $1 ESCAPE '\\'", [`${escaped}%`]);
    return rows.map(r => r.key);
}

// Automatic migration from config.json to database
async function migrateConfigJson() {
    const ROOT_CONFIG_PATH = path.join(__dirname, 'config.json');
    const DATA_CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

    let configToMigrate = null;
    let configPathToRename = null;

    if (fs.existsSync(DATA_CONFIG_PATH)) {
        try {
            configToMigrate = JSON.parse(fs.readFileSync(DATA_CONFIG_PATH, 'utf8'));
            configPathToRename = DATA_CONFIG_PATH;
        } catch (e) {
            log.error(`[ConfigStore] Error reading ${DATA_CONFIG_PATH}: ${e.message}`);
        }
    } else if (fs.existsSync(ROOT_CONFIG_PATH)) {
        try {
            configToMigrate = JSON.parse(fs.readFileSync(ROOT_CONFIG_PATH, 'utf8'));
            configPathToRename = ROOT_CONFIG_PATH;
        } catch (e) {
            log.error(`[ConfigStore] Error reading ${ROOT_CONFIG_PATH}: ${e.message}`);
        }
    }

    if (configToMigrate) {
        log.info(`[ConfigStore] Migrating settings from config.json to database...`);
        for (const [key, value] of Object.entries(configToMigrate)) {
            await setConfig(key, value);
        }
        try {
            fs.renameSync(configPathToRename, `${configPathToRename}.bak`);
            log.info(`[ConfigStore] Migration complete. Renamed to config.json.bak`);
        } catch (e) {
            log.error(`[ConfigStore] Failed to rename config.json: ${e.message}`);
        }
    }
}

migrateConfigJson().catch(err => log.error('[ConfigStore] Migration error:', err.message));

// ── One-shot legacy plaintext re-encryption ─────────────────────────────────
// Older deployments stored some secret-like keys in plaintext. New writes go
// through encryptValue, but rows created before the encryption rollout sit in
// the DB as readable strings — anyone with read-only DB access can lift API
// keys, webhook secrets, tokens. This migration sweeps the table once,
// identifies plaintext rows whose keys match secret-like patterns, and
// rewrites them through encryptValue. Idempotent: rows already in the
// `config-v1` envelope are skipped.
const SECRET_KEY_PATTERNS = [
    /api[_-]?key$/i,
    /^.*api[_-]?key_/i,
    /secret$/i,
    /_secret_/i,
    /password$/i,
    /_password_/i,
    /token$/i,
    /^.*token_/i,
    /^webhook_signing_/i,
    /^stripe_webhook_secret/i,
    /^connector_tenant_key_/i,
    /^org_webhook_signing_key_/i,
    /^opaque_/i,
    /credentials?$/i,
    /^smtp_pass/i,
];

// Keys that incidentally match a SECRET_KEY_PATTERN (e.g. they contain the
// substring "_password_") but are NOT secrets — they're policy flags/toggles
// read via the PLAIN getConfig path (no decryption). Encrypting them would make
// the reader see a truthy `config-v1` envelope object instead of the real value
// (e.g. boolean false), silently inverting the setting. Keep them plaintext.
const SECRET_KEY_EXCEPTIONS = new Set([
    'require_mfa_for_password_accounts',
]);

function _looksLikeSecretKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (SECRET_KEY_EXCEPTIONS.has(key)) return false;
    return SECRET_KEY_PATTERNS.some(re => re.test(key));
}

function _isAlreadyEncrypted(raw) {
    if (!raw || typeof raw !== 'string') return false;
    try {
        const parsed = JSON.parse(raw);
        return !!(parsed && typeof parsed === 'object' && parsed._encrypted === 'config-v1');
    } catch (_) { return false; }
}

async function reencryptLegacyPlaintextSecrets() {
    try {
        if (!process.env.MASTER_ENCRYPTION_KEY) {
            // Can't encrypt without a key — leave plaintext rows alone rather
            // than crash. Operators are expected to set this before the
            // first cloud deploy.
            return { scanned: 0, encrypted: 0, skipped: 0, note: 'no MASTER_ENCRYPTION_KEY' };
        }
        await initDB();
        const rows = await getAll('SELECT key, value FROM config');
        let scanned = 0;
        let encrypted = 0;
        let skipped = 0;
        for (const row of rows) {
            scanned++;
            if (!row.value) { skipped++; continue; }
            if (_isAlreadyEncrypted(row.value)) { skipped++; continue; }
            if (!_looksLikeSecretKey(row.key)) { skipped++; continue; }
            try {
                const orgCtx = _inferOrgIdFromKey(row.key);
                const sealed = encryptValue(String(row.value), orgCtx);
                await run(
                    `UPDATE config SET value = $1, updated_at = NOW() WHERE key = $2`,
                    [sealed, row.key]
                );
                _cacheInvalidate(row.key);
                _cacheInvalidate(`__secret__${row.key}`);
                _notifyInvalidate(row.key);
                encrypted++;
            } catch (e) {
                log.warn(`[ConfigStore] re-encrypt failed for key="${row.key}": ${e.message}`);
            }
        }
        if (encrypted > 0) {
            log.info(`[ConfigStore] Legacy plaintext re-encryption: ${encrypted}/${scanned} rows sealed (skipped ${skipped}).`);
        }
        return { scanned, encrypted, skipped };
    } catch (err) {
        log.error('[ConfigStore] reencryptLegacyPlaintextSecrets error:', err.message);
        return { scanned: 0, encrypted: 0, skipped: 0, error: err.message };
    }
}

// Run at module load — best-effort, never blocks startup.
reencryptLegacyPlaintextSecrets().catch(() => {});

log.info('[ConfigStore] Initialized (PostgreSQL)');

module.exports = {
    getConfig,
    getConfigFresh,
    getConfigsByKeys,
    setConfig,
    mutateConfig,
    deleteConfig,
    getAllConfig,
    listKeysWithPrefix,
    setSecret,
    setSecretIfAbsent,
    getSecret,
    getSecretFresh,
    encryptValue,
    decryptValue,
    reencryptLegacyPlaintextSecrets,
    // cross-replica cache invalidation (exported for tests / shutdown)
    _applyInvalidation,
    _startInvalidationListener,
    _stopInvalidationListener,
    CONFIG_INVALIDATE_CHANNEL,
};

// Awaitbare init-ingang voor migrateDb (memoised — zelfde promise als de load-time init).
module.exports.initDB = initDB;
