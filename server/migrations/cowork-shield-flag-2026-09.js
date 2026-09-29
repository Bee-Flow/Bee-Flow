/**
 * Migration: stamp the CW-10 cowork-shield flag explicitly OFF for existing
 * orgs (U10).
 *
 * `org_cowork_shield_<orgId>` (read by core/entitlements/coworkShieldFlag.js)
 * will let the NON-agent run path (aiTaskRunner.executeTask for tasks without
 * an agent — shared with scheduled Routines) apply the org privacy shield.
 * The reader normalises MISSING to OFF, so existing orgs already keep today's
 * behaviour; this grandfather freezes that as data: every org without a
 * stored row gets one that says `enabled: false`.
 *
 * That explicit row is what lets a later release turn the flag ON for NEW
 * orgs (an explicit write at org-creation, shipped with the write UI —
 * never a reader default) without changing a single org that predates the
 * toggle: their `enabled: false` row wins by existing. And after a rollback
 * the row is inert — old code never reads the key — so no admin has seen a
 * shield claim that silently stopped being enforced.
 *
 * ON CONFLICT (key) DO NOTHING carries the idempotence AND the admin-respect:
 * an existing row (a future UI's `enabled: true`, or a previous run) is never
 * overwritten by this every-boot ladder.
 *
 * Standalone: node migrations/cowork-shield-flag-2026-09.js [--dry-run]
 */

const { getAll, run } = require('../db');

// Must match core/entitlements/coworkShieldFlag.js CONFIG_KEY_PREFIX — the
// colocated test pins the two literals together.
const CONFIG_KEY_PREFIX = 'org_cowork_shield_';

async function up({ dryRun = false } = {}) {
    try {
        if (dryRun) {
            const rows = await getAll(`
                SELECT o.id FROM organizations o
                 WHERE NOT EXISTS (SELECT 1 FROM config c WHERE c.key = $1 || o.id)`,
                [CONFIG_KEY_PREFIX]);
            const n = (rows || []).length;
            console.log(`[cowork-shield-flag] DRY-RUN: would stamp ${n} organisation(s) explicitly off; nothing written`);
            return n;
        }
        const value = JSON.stringify({
            enabled: false,
            updatedAt: new Date().toISOString(),
            updatedBy: 'migration:cowork-shield-flag-2026-09',
        });
        const res = await run(`
            INSERT INTO config (key, value, updated_at)
            SELECT $1 || o.id, $2, NOW() FROM organizations o
            ON CONFLICT (key) DO NOTHING
        `, [CONFIG_KEY_PREFIX, value]);
        const n = res?.rowCount ?? 0;
        if (n > 0) console.log(`[cowork-shield-flag] stamped ${n} organisation(s) explicitly off (grandfather)`);
        return n;
    } catch (e) {
        // Loud skip; the reader's missing⇒off default keeps behaviour identical
        // until the next boot retries.
        console.warn('[cowork-shield-flag] grandfather skipped:', e.message);
        return 0;
    }
}

module.exports = { up, CONFIG_KEY_PREFIX };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then(() => process.exit(0)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
