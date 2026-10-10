// @typecheck
/**
 * Named MCP access tokens: the `mcp_tokens` table.
 *
 * Only the sha256 of the secret is stored; the secret itself is shown once at
 * creation and cannot be recovered. This file is SQL and row mapping only. The
 * token format, hashing and policy live in `auth/mcpAccess/tokenStore.js`.
 *
 * Schema: created idempotently on boot like every other store (the product has
 * no migration ledger; every replica replays this).
 */

'use strict';

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

const initDB = makeStoreInit('McpTokenStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS mcp_tokens (
            id            TEXT PRIMARY KEY,
            user_id       TEXT NOT NULL,
            org_id        TEXT,
            name          TEXT NOT NULL,
            secret_hash   TEXT NOT NULL,
            scopes        JSONB NOT NULL DEFAULT '{}'::jsonb,
            ip_allowlist  JSONB NOT NULL DEFAULT '[]'::jsonb,
            expires_at    TIMESTAMPTZ,
            last_used_at  TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            revoked_at    TIMESTAMPTZ
        );
        ALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_mcp_tokens_org ON mcp_tokens(org_id) WHERE org_id IS NOT NULL;
    `);
    log.info('[McpTokenStore] PostgreSQL initialized');
}

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Row → the record shape the rest of the server uses. Never carries the hash. */
function toRecord(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        orgId: row.org_id || null,
        name: row.name,
        scopes: row.scopes && typeof row.scopes === 'object' ? row.scopes : {},
        ipAllowlist: Array.isArray(row.ip_allowlist) ? row.ip_allowlist : [],
        expiresAt: iso(row.expires_at),
        lastUsedAt: iso(row.last_used_at),
        createdAt: iso(row.created_at),
        revokedAt: iso(row.revoked_at),
        // Switched off temporarily (reversible); revoking is the permanent act.
        disabledAt: iso(row.disabled_at),
        enabled: !row.disabled_at,
    };
}

const COLUMNS = 'id, user_id, org_id, name, scopes, ip_allowlist, expires_at, last_used_at, created_at, revoked_at, disabled_at';

async function insert({ id, userId, orgId, name, secretHash, scopes, ipAllowlist, expiresAt }) {
    await initDB();
    const row = await getOne(
        `INSERT INTO mcp_tokens (id, user_id, org_id, name, secret_hash, scopes, ip_allowlist, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
         RETURNING ${COLUMNS}`,
        [id, userId, orgId || null, name, secretHash, JSON.stringify(scopes), JSON.stringify(ipAllowlist || []), expiresAt || null],
    );
    return toRecord(row);
}

async function listByUser(userId) {
    await initDB();
    const rows = await getAll(`SELECT ${COLUMNS} FROM mcp_tokens WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
    return rows.map(toRecord);
}

async function countActiveByUser(userId) {
    await initDB();
    const row = await getOne(
        'SELECT COUNT(*)::int AS n FROM mcp_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
        [userId],
    );
    return row ? Number(row.n) : 0;
}

/** The record plus its stored hash, for the constant-time compare. */
async function getWithHash(id) {
    await initDB();
    const row = await getOne(`SELECT ${COLUMNS}, secret_hash FROM mcp_tokens WHERE id = $1`, [id]);
    return row ? { record: toRecord(row), secretHash: row.secret_hash } : null;
}

/** Revoke one of `userId`'s tokens (idempotent). Null when it is not theirs. */
async function revoke(userId, id) {
    await initDB();
    const row = await getOne(
        `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
        [id, userId],
    );
    return toRecord(row);
}

/**
 * Switch one of `userId`'s tokens off or back on. Null when it is not theirs.
 * A revoked token is left alone: the row comes back unchanged and the caller
 * decides what that means.
 */
async function setEnabled(userId, id, enabled) {
    await initDB();
    const row = await getOne(
        `UPDATE mcp_tokens
            SET disabled_at = CASE WHEN revoked_at IS NOT NULL THEN disabled_at
                                   WHEN $3::boolean THEN NULL
                                   ELSE COALESCE(disabled_at, NOW()) END
          WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
        [id, userId, enabled === true],
    );
    return toRecord(row);
}

async function touch(id) {
    await initDB();
    await run('UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1', [id]);
}

module.exports = { initDB, insert, listByUser, countActiveByUser, getWithHash, revoke, setEnabled, touch, toRecord };
