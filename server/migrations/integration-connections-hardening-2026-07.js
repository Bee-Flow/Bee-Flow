/**
 * Migration: two fixes to the integration-connections schema.
 *
 * 1. connection_grants.resource_type CHECK gains 'studio_app'.
 *    routes/integrations/connections.js has always ACCEPTED studio_app in
 *    VALID_RESOURCE_TYPES and appStudio/connectors.js resolves viewer-mode
 *    lends with it, but the original CHECK (agent|webpage|skill|routine) made
 *    every such share fail with a 23514 that surfaced as a 500 — so
 *    resource-scoped lending for studio apps could never work.
 *
 * 2. Collapse duplicate OAuth connection rows per (owner_user_id, provider).
 *    The connectors called createConnection on every reconnect and it has no
 *    dedupe, so each re-consent stacked another metadata row describing the
 *    same credential (users saw "Default" and "their@email.com" side by side
 *    under one provider). The keeper is the default row, else the oldest —
 *    the row the legacy backfill and any existing grants already point at.
 *    Grants are re-pointed at the keeper before the losers are deleted, so no
 *    lend is silently dropped by the FK cascade.
 *
 * Both steps are idempotent: DROP IF EXISTS + re-ADD for the constraint, and
 * the collapse is a no-op once only one row per pair remains.
 */

const { exec, getAll, run } = require('../db');

const OAUTH_PROVIDERS = ['google', 'microsoft', 'nextcloud'];

async function up() {
    // ── 1. Widen the resource_type CHECK ────────────────────────────
    // This runs on every store init, so the list is the CURRENT one: an
    // automation-scoped grant has been 'automation' since 2026-10 (it was
    // 'routine'). Rows of the old spelling are moved first, or the constraint
    // could not be added over them.
    await exec(`ALTER TABLE connection_grants DROP CONSTRAINT IF EXISTS connection_grants_resource_type_check`);
    await exec(`UPDATE connection_grants SET resource_type = 'automation' WHERE resource_type = 'routine'`);
    await exec(`
        ALTER TABLE connection_grants ADD CONSTRAINT connection_grants_resource_type_check
            CHECK (resource_type IS NULL OR resource_type IN ('agent','webpage','skill','automation','studio_app'))
    `);

    // ── 2. Collapse duplicate OAuth rows ────────────────────────────
    const dupes = await getAll(`
        SELECT owner_user_id, provider, COUNT(*) AS n
        FROM integration_connections
        WHERE kind = 'oauth' AND provider = ANY($1::text[])
        GROUP BY owner_user_id, provider
        HAVING COUNT(*) > 1
    `, [OAUTH_PROVIDERS]);

    let collapsed = 0;
    let regrafted = 0;
    for (const d of dupes) {
        const rows = await getAll(`
            SELECT id FROM integration_connections
            WHERE owner_user_id = $1 AND provider = $2 AND kind = 'oauth'
            ORDER BY is_default DESC, created_at ASC
        `, [d.owner_user_id, d.provider]);
        if (rows.length < 2) continue;
        const keep = rows[0].id;
        const drop = rows.slice(1).map(r => r.id);

        // Move any grants off the losing rows first — deleting them with live
        // grants attached would cascade those lends away.
        const { rowCount: moved } = await run(
            'UPDATE connection_grants SET connection_id = $1 WHERE connection_id = ANY($2::uuid[])',
            [keep, drop]
        );
        regrafted += moved || 0;
        await run('DELETE FROM integration_connections WHERE id = ANY($1::uuid[])', [drop]);
        collapsed += drop.length;

        // The keeper must remain the default for its (owner, provider); the
        // partial unique index allows only one, and we may have just deleted it.
        await run(
            'UPDATE integration_connections SET is_default = TRUE, updated_at = NOW() WHERE id = $1 AND is_default = FALSE',
            [keep]
        );
    }

    if (collapsed > 0) {
        console.log(`[Migration] integration-connections-hardening-2026-07 collapsed ${collapsed} duplicate OAuth row(s), re-pointed ${regrafted} grant(s)`);
    }
    console.log('[Migration] integration-connections-hardening-2026-07 applied');
}

module.exports = { up };
