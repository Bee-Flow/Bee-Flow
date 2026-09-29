/**
 * Migration: integration_response_cache — the durable "ask this app only once"
 * store's table (2026-09).
 *
 * The table used to be created lazily by the store's own `_doInit` on first
 * use, which meant the FIRST cached answer an organisation ever stored was
 * also the statement that created the table — and a DBA reading
 * `server/migrations/` could not tell the table existed at all. Anything that
 * holds third-party response payloads has to be visible where the schema is
 * documented, not discoverable only by catching it in the act.
 *
 * `payload_bytes` is the new column and the reason this is more than a move:
 * the per-org quota needs a cheap SUM, and `length(payload)` over every row of
 * a growing table is not one. Backfilled once; NULL only ever means "written
 * before this migration ran", which the backfill then removes.
 *
 * Everything here is IF NOT EXISTS and the backfill is bounded by
 * `payload_bytes IS NULL`, so a re-run does no work. The store still calls
 * `up()` from its own init as a belt: a fresh replica may reach a cache write
 * before a standalone `db:migrate` has run.
 */

const { exec, run } = require('../db');

const TABLE = 'integration_response_cache';

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
            cache_key       TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            user_id         TEXT NOT NULL,
            tool_name       TEXT NOT NULL,
            payload         TEXT NOT NULL,
            payload_bytes   INTEGER,
            expires_at      TIMESTAMPTZ NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    // The column is added separately too: an installation that already has the
    // table from the store's lazy init will not get it from CREATE TABLE.
    await exec(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS payload_bytes INTEGER`);

    // user_id and organization_id carry erasure and org teardown; expires_at
    // carries the prune. Nothing here is a lookup path — the primary key is.
    await exec(`CREATE INDEX IF NOT EXISTS idx_intcache_user ON ${TABLE}(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_intcache_org ON ${TABLE}(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_intcache_expires ON ${TABLE}(expires_at)`);

    // The quota counts live rows per org; without this the count is a full
    // scan of every org's rows on every 60-second refresh.
    await exec(`CREATE INDEX IF NOT EXISTS idx_intcache_org_expires ON ${TABLE}(organization_id, expires_at)`);

    // Rows written before the column existed report no size, and a NULL in the
    // SUM would silently under-count the org against its byte cap.
    const { rowCount } = await run(
        `UPDATE ${TABLE} SET payload_bytes = length(payload) WHERE payload_bytes IS NULL`,
    );
    if (rowCount) console.log(`[Migration] integration-response-cache-2026-09: sized ${rowCount} existing row(s)`);
}

module.exports = { up, TABLE };
