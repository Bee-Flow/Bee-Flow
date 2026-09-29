/**
 * Migration: rename every per-tenant datatable schema from `dtorg_<orgId>` to
 * the fixed-length hashed name `dt_<sha256(scopeKind\0scopeId)[0:40]>` (2026-09).
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────
 * `datatableDbStore.schemaFor` built `'dtorg_' + orgId` and its comment assumed
 * a 36-character UUID. Org ids are not UUIDs: they are slugs of the
 * organisation NAME (auth/accountProvisioning.slugifyOrgId), and nothing capped
 * their length. Postgres truncates every identifier to 63 bytes even when it is
 * quoted, so two organisations whose ids share 57 leading characters land in
 * ONE schema and read, overwrite and delete each other's rows. Reproduced on a
 * real Postgres; latent only because org names happen to be short today.
 *
 * The hashed name is 43 fixed characters, so the length can never depend on the
 * tenant again.
 *
 * ── WHY IT IS SAFE ──────────────────────────────────────────────────
 * ALTER SCHEMA … RENAME TO moves no bytes: it rewrites one catalog row. One
 * transaction per tenant, so a failure for one organisation leaves every other
 * tenant renamed and that one exactly as it was.
 *
 * Guarded rather than blind, and idempotent because of the guard: rename only
 * when the legacy schema exists AND the hashed one does not. A second run finds
 * the target already there and does nothing. Two replicas racing is the same
 * case — one wins the lock, the other's ALTER fails with duplicate_schema
 * (42P06) or invalid_schema_name (3F000) and is treated as "already done".
 *
 * BOTH names existing is NOT "already done" — it is an orphan (a half-failed
 * rename, or a write that landed under the legacy name after one). It is logged
 * and left alone: dropping either side would be destroying rows nobody has
 * looked at yet. server/scripts/datatable-orphan-scan.mjs lists them.
 *
 * ── THE FALLBACK THAT MAKES A FAILURE SURVIVABLE ────────────────────
 * `datatableDbStore.schemaFor` resolves the hashed name only when it exists and
 * otherwise falls back to `dtorg_<id>` when THAT does, so a tenant this
 * migration could not rename keeps working. Without it the next schema save
 * would not 404 — applyMigration runs CREATE SCHEMA IF NOT EXISTS — it would
 * silently create an EMPTY schema while the organisation's real rows sat
 * orphaned with no metadata, no access filter, no retention and no UI. Do not
 * remove the fallback in the same release as this migration.
 */

const { getAll, getOne, withTransaction } = require('../db');
const { schemaNameFor, LEGACY_ORG_PREFIX } = require('../stores/datatableDbStore');

// Postgres SQLSTATEs that mean another replica finished the rename first.
const ALREADY_DONE = new Set(['42P06', '3F000']);

/** A Postgres quoted identifier — the only correct escape is doubling `"`. */
function quoted(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
}

async function up() {
    // A fresh install reaches this migration with no datatable tables at all.
    const probe = await getOne(`SELECT to_regclass('datatable_models') AS t`).catch(() => null);
    if (!probe?.t) return;

    const rows = await getAll(`SELECT organization_id FROM datatable_models`);
    let renamed = 0;
    let orphaned = 0;

    for (const row of rows) {
        const orgId = row.organization_id;
        if (orgId === null || orgId === undefined) continue;
        const legacy = LEGACY_ORG_PREFIX + orgId;
        const hashed = schemaNameFor('org', orgId);
        try {
            const outcome = await withTransaction(async (client) => {
                const chk = await client.query(
                    `SELECT to_regnamespace($1) IS NOT NULL AS has_legacy,
                            to_regnamespace($2) IS NOT NULL AS has_hashed`,
                    [quoted(legacy), quoted(hashed)],
                );
                const { has_legacy: hasLegacy, has_hashed: hasHashed } = chk.rows[0] || {};
                if (!hasLegacy) return 'nothing_to_do';   // already renamed, or never created
                if (hasHashed) return 'both';
                await client.query(`ALTER SCHEMA ${quoted(legacy)} RENAME TO ${quoted(hashed)}`);
                return 'renamed';
            });
            if (outcome === 'renamed') renamed++;
            if (outcome === 'both') {
                orphaned++;
                console.warn(
                    `[Migration] datatable-schema-rename: org ${orgId} has BOTH ${legacy} and ${hashed} — ` +
                    'left untouched. Run scripts/datatable-orphan-scan.mjs and merge them by hand.',
                );
            }
        } catch (e) {
            if (ALREADY_DONE.has(e?.code)) continue;   // another replica won the race
            // One tenant with an unusual schema must not hold back everyone
            // else's rename, and the legacy fallback keeps this org working.
            console.error(`[Migration] datatable-schema-rename: org ${orgId} failed: ${e.message}`);
        }
    }

    if (renamed || orphaned) {
        console.log(`[Migration] datatable-schema-rename-2026-09 renamed ${renamed} schema(s), ${orphaned} left as orphan(s)`);
    }
}

module.exports = { up, quoted };
