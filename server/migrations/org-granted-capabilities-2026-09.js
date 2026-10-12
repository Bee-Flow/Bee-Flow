/**
 * Migration: grant-grandfather for growth of USER_FACING_CORE (U10).
 *
 * On cloud, a user-facing (togglable) CORE capability is only granted to an
 * org's members when its id sits in `organizations.org_granted_capabilities`
 * (core/entitlements/entitlements.js — "the menu alone does not grant on
 * cloud"). The column DEFAULT and its '[]'-backfill (stores/user/schema.js)
 * seed exactly the original trio: notebooks / projects / component_designer.
 * So the moment USER_FACING_CORE (core/entitlements/capabilityRegistry.js)
 * grows, every EXISTING org would silently lose the new feature — it was
 * implicitly on-for-everyone before it became a toggle, and no stored row
 * mentions it.
 *
 * This migration closes that gap in the compliance-plan-flag-2026-09 shape,
 * with one addition. For every id in USER_FACING_CORE beyond the seeded trio
 * it APPENDS (never replaces) that id to every existing org's grant list —
 * but ONCE, bounded by a config marker (`cap_grant_backfill_<id>`,
 * ON CONFLICT DO NOTHING). The marker matters because this ladder re-runs at
 * every boot of every replica: without it, an org-admin who deliberately
 * toggles the new capability OFF would find it re-granted on the next deploy.
 * A blind append is idempotent; a marker-bounded append is idempotent AND
 * respects later admin intent.
 *
 * Rows still at NULL get the seeded trio plus the new id: schema.js's own
 * backfill rewrites exactly those rows to the trio at every boot, so appending
 * only the new id would stop that backfill from matching and cost the org its
 * trio. A '[]' row is NOT pending: schema.js leaves it alone, because it is
 * how an admin's deliberate "all off" is stored, so it only gets the new id.
 * (In the boot/migrate ladders the stores run first, so a NULL row is normally
 * already the trio by the time this runs.)
 *
 * Orgs created AFTER the marker rely on the column DEFAULT — growing
 * USER_FACING_CORE therefore also means growing that DEFAULT (stores/user/
 * schema.js, owned by the stores tree). Existing plans/ceilings are not
 * touched: this is a grant, clamped by each org's plan/licence ceiling as
 * always, so it never widens what a plan allows.
 *
 * TODAY USER_FACING_CORE equals the seeded trio, so this is a deliberate
 * no-op — the mechanism ships ahead of the first id that needs it (release
 * checklist: "Groeit USER_FACING_CORE? … de grant-migratie is aanwezig").
 *
 * Standalone: node migrations/org-granted-capabilities-2026-09.js [--dry-run]
 * (--dry-run reports what would be appended and writes nothing, marker
 * included).
 */

const { getAll, getOne, run } = require('../db');
const { USER_FACING_CORE } = require('../core/entitlements/capabilityRegistry');

// Mirrors the column DEFAULT + '[]'-backfill in stores/user/schema.js — the
// ids every org already has out of the box, which therefore never need (and
// must never get) a re-grant from here.
const SEEDED_DEFAULTS = ['notebooks', 'projects', 'component_designer'];
const MARKER_PREFIX = 'cap_grant_backfill_';

function parseList(v) {
    if (v == null) return null;
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch (_) { return null; } }
    return null;
}

/** Ids added to USER_FACING_CORE since the seeded trio — the grandfather set. */
function newUserFacingCoreIds() {
    const seeded = new Set(SEEDED_DEFAULTS);
    return [...USER_FACING_CORE].filter((id) => !seeded.has(id)).sort();
}

async function up({ dryRun = false } = {}) {
    const ids = newUserFacingCoreIds();
    if (ids.length === 0) return { ids, appended: 0 }; // registry == seeded trio: nothing new in this build

    let appended = 0;
    for (const id of ids) {
        try {
            const marker = `${MARKER_PREFIX}${id}`;
            if (await getOne(`SELECT key FROM config WHERE key = $1`, [marker])) continue;

            const orgs = await getAll(`SELECT id, "org_granted_capabilities" FROM organizations`);
            for (const o of (orgs || [])) {
                const list = parseList(o.org_granted_capabilities);
                // NULL means "seed still pending" (schema.js rewrites it to the
                // trio every boot): preserve that seed alongside the new id
                // instead of leaving a list the backfill no longer matches. An
                // empty array is an admin's explicit "all off" and stays a base.
                const base = Array.isArray(list) ? list : SEEDED_DEFAULTS;
                if (base.includes(id)) continue;
                if (dryRun) {
                    console.log(`[org-granted-capabilities] DRY-RUN org ${o.id}: would append '${id}'`);
                    appended++;
                    continue;
                }
                await run(`UPDATE organizations SET "org_granted_capabilities" = $1 WHERE id = $2`,
                    [JSON.stringify([...base, id]), o.id]);
                console.log(`[org-granted-capabilities] org ${o.id}: grandfathered '${id}' into org_granted_capabilities`);
                appended++;
            }

            if (dryRun) {
                console.log(`[org-granted-capabilities] DRY-RUN: marker ${marker} NOT written`);
            } else {
                // One-shot bound. DO NOTHING keeps racing replicas convergent;
                // from here on, absence of the id is an admin's choice, not a gap.
                await run(`INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (key) DO NOTHING`,
                    [marker, JSON.stringify({ done: true, at: new Date().toISOString(), migration: 'org-granted-capabilities-2026-09' })]);
            }
        } catch (e) {
            // Fail CLOSED and loud: no grant is written, nothing is unlocked by
            // guesswork, and the next boot retries (no marker was written).
            console.warn(`[org-granted-capabilities] grandfather for '${id}' skipped:`, e.message);
        }
    }
    return { ids, appended };
}

module.exports = { up, newUserFacingCoreIds, SEEDED_DEFAULTS, MARKER_PREFIX };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then((res) => {
        console.log(`[org-granted-capabilities] ${dryRun ? 'DRY-RUN ' : ''}done:`, JSON.stringify(res));
        process.exit(0);
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
