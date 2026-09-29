#!/usr/bin/env node
/**
 * Migration: backfill organizations.registration_source (BFSF-286).
 *
 * The column records provenance — via which route an organisation was
 * registered: 'direct' (signup/OAuth wizard), 'admin' (admin panel) or
 * 'nextcloud_connector' (connector bootstrap fresh-org). It is write-once at
 * creation and backs the "which T&C channel applies" decision
 * the admin-dashboard "Registered via"
 * label and marketing/support segmentation.
 *
 * Backfill heuristic — deliberately NOT authMethod-based: pairing-code binds
 * rewrite an existing direct org to authMethod='nextcloud_connector'
 * (connectorBootstrap.js bindOrgToNcInstance) and unbind clears it again
 * (ncBindingRoutes.js), so authMethod misclassifies in both directions.
 * Instead we use the two fingerprints only the connector fresh-org branch
 * leaves: the auto-provisioned description and the deterministic 'nc-' id
 * prefix (connectorBootstrap.js fresh-org branch). Everything else predates
 * the connector or came through signup/OAuth/admin — 'direct' is the
 * T&C-correct catch-all. Historical admin-created orgs are indistinguishable
 * from signups and land on 'direct' (accepted). Known limit: an
 * auto-provisioned org whose admin edited the description AND whose
 * nc_instance_id was since unbound falls through to 'direct' — rare,
 * one-shot, accepted.
 *
 * Idempotent — both UPDATEs only touch rows WHERE registration_source IS
 * NULL; a re-run affects 0 rows. Auto-runs from server boot (server/index.js).
 * Manual usage:
 *   node server/migrations/org-registration-source-2026-07.js
 */

const { run } = require('../db');

async function up() {
    // Self-sufficient: guarantee the column exists even if this fires before
    // userStore.initDB() finishes on a first boot (harmless duplicate of the
    // initDB ALTER; a fresh DB has no orgs to backfill anyway).
    await run(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "registration_source" TEXT`);

    // 1) Fresh-connector orgs — connector-bootstrap fingerprints only.
    const nc = await run(
        `UPDATE organizations SET "registration_source" = 'nextcloud_connector'
          WHERE "registration_source" IS NULL
            AND (description LIKE 'Auto-provisioned from Nextcloud%'
                 OR (id LIKE 'nc-%' AND nc_instance_id IS NOT NULL))`
    );

    // 2) Everything else → 'direct' (see header for why this is the correct
    // catch-all, including pre-connector and admin-created orgs).
    const direct = await run(
        `UPDATE organizations SET "registration_source" = 'direct'
          WHERE "registration_source" IS NULL`
    );

    const ncCount = nc?.rowCount || 0;
    const directCount = direct?.rowCount || 0;
    if (ncCount + directCount > 0) {
        console.log(`[org-registration-source] backfilled nc=${ncCount} direct=${directCount}`);
    }
    return { nc: ncCount, direct: directCount };
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
