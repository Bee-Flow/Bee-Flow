/**
 * Migration: stamp the A3 org-MFA duty explicitly OFF for existing orgs (U10).
 *
 * The new per-org duty `org_mfa_required_<orgId>` (read by
 * core/entitlements/orgMfaRequired.js, OR'd with the platform flag in
 * auth/login/currentUserRoutes.js) normalises a MISSING value to false, so
 * existing orgs already behave exactly as before this release. This
 * grandfather makes that state EXPLICIT: every org that has no stored row
 * gets one that says `required: false`.
 *
 * Why write rows at all when missing already means off?
 *   - it freezes today's behaviour as data, so a later release may change
 *     what "no row" means for NEW orgs (or write `required: true` at
 *     org-creation) without touching anyone who predates the toggle;
 *   - after a rollback the row is inert (old code never reads the key) and
 *     says exactly what was enforced — nothing.
 *
 * ON CONFLICT (key) DO NOTHING is the whole safety story: a row that already
 * exists — an admin (or a future write UI) that set the duty ON between
 * deploys, or a previous run of this ladder — is never overwritten, at any
 * of the every-boot re-runs. Orgs created between boots get stamped off at
 * the next tick, which equals the reader's default for them.
 *
 * The org flag can only ADD the MFA duty; the platform flag
 * `require_mfa_for_password_accounts` (missing ⇒ ON) stays the backstop, so
 * this migration can never weaken anyone's MFA posture.
 *
 * Standalone: node migrations/org-mfa-required-2026-09.js [--dry-run]
 */

const { getAll, run } = require('../db');

// Must match core/entitlements/orgMfaRequired.js CONFIG_KEY_PREFIX — the
// colocated test pins the two literals together. Kept literal here so the
// migration stays a leaf on db.js, like the rest of this ladder.
const CONFIG_KEY_PREFIX = 'org_mfa_required_';

async function up({ dryRun = false } = {}) {
    try {
        if (dryRun) {
            const rows = await getAll(`
                SELECT o.id FROM organizations o
                 WHERE NOT EXISTS (SELECT 1 FROM config c WHERE c.key = $1 || o.id)`,
                [CONFIG_KEY_PREFIX]);
            const n = (rows || []).length;
            console.log(`[org-mfa-required] DRY-RUN: would stamp ${n} organisation(s) explicitly off; nothing written`);
            return n;
        }
        const value = JSON.stringify({
            required: false,
            updatedAt: new Date().toISOString(),
            updatedBy: 'migration:org-mfa-required-2026-09',
        });
        const res = await run(`
            INSERT INTO config (key, value, updated_at)
            SELECT $1 || o.id, $2, NOW() FROM organizations o
            ON CONFLICT (key) DO NOTHING
        `, [CONFIG_KEY_PREFIX, value]);
        const n = res?.rowCount ?? 0;
        if (n > 0) console.log(`[org-mfa-required] stamped ${n} organisation(s) explicitly off (grandfather)`);
        return n;
    } catch (e) {
        // Loud skip; the reader's missing⇒false default keeps behaviour
        // identical until the next boot retries.
        console.warn('[org-mfa-required] grandfather skipped:', e.message);
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
