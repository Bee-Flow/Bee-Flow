/**
 * Migration: make `automations.organization_id` real (2026-09).
 *
 * The column has existed since the init migration, and `createAutomation`
 * accepts an `organizationId` (stores/automationStore/automations.js:10) — but
 * neither of the two create call sites in routes/automation/crud.js ever passed
 * one. So the column is NULL for effectively every routine ever made, and the
 * runner compensates at run time: `runOrgFor` (core/automationRunner/
 * execution.js) falls back to the OWNER's `users."organizationId"`.
 *
 * That fallback is fine while a routine is owner-private, which everything in
 * the automation subsystem is today. It is NOT fine as the tenancy key of a
 * shared, writable resource: datatables are scoped by organisation, and "which
 * org does this run belong to" has to be a stored fact, not a lookup that can
 * change under you when a user is moved between organisations.
 *
 * This backfill writes exactly what `runOrgFor` already derives, and exactly
 * what stores/automationStore/forms.js already COALESCEs at read time. It is a
 * FREEZE of today's behaviour, not a change of it — which is why the companion
 * test asserts `runOrgFor` returns the same value before and after.
 *
 * Rows whose owner has no organisation (personal / single-user installs) stay
 * NULL on purpose. Nothing invents an organisation for them, and the datatable
 * step refuses to run rather than guessing (`datatable_no_org`).
 *
 * "Has no organisation" means EMPTY STRING as often as NULL: stores/user/users.js
 * createUser writes `organizationId || ''`, so the built-in operator account and
 * every org-less signup hold ''. The first cut of this migration guarded on
 * `u."organizationId" IS NOT NULL`, which copied '' into automations as if it
 * were a tenant — the exact opposite of the paragraph above — and made
 * `idx_automations_org … WHERE organization_id IS NOT NULL` index every row it
 * was built to skip. So both halves test truthiness, and any '' already written
 * is normalised back to NULL first.
 *
 * Idempotent: the WHERE clause only touches rows still NULL, so re-running is a
 * no-op. It is deliberately NOT a one-shot — a routine created between the
 * deploy of this migration and the deploy of the crud.js change would otherwise
 * be missed.
 */

const { exec, run } = require('../db');

async function up() {
    // Index first: the UPDATE below and every later per-org read want it, and
    // creating it on an empty-ish column is cheap.
    await exec(`CREATE INDEX IF NOT EXISTS idx_automations_org ON automations(organization_id) WHERE organization_id IS NOT NULL`);

    // Normalise BEFORE the backfill, so a routine that was stamped '' gets its
    // owner's real organisation on the same pass instead of sitting on a tenant
    // key that addresses nothing. Idempotent: the second run matches no rows.
    const cleared = await run(`UPDATE automations SET organization_id = NULL WHERE organization_id = ''`);
    const c = cleared?.rowCount ?? 0;
    if (c > 0) console.log(`[Migration] automation-org-backfill-2026-09: cleared ${c} empty-string organisation${c === 1 ? '' : 's'}`);

    const res = await run(`
        UPDATE automations a
           SET organization_id = u."organizationId"
          FROM users u
         WHERE a.user_id = u.id
           AND a.organization_id IS NULL
           AND COALESCE(u."organizationId", '') <> ''
    `);
    const n = res?.rowCount ?? 0;
    console.log(`[Migration] automation-org-backfill-2026-09 applied (${n} routine${n === 1 ? '' : 's'} stamped with their owner's organisation)`);
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
