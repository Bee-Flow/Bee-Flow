#!/usr/bin/env node
/**
 * Migration: seed org_health_problems for ALREADY-broken Nextcloud orgs.
 *
 * The org-health capture layer (server/stores/orgHealthStore.js + the
 * never-throws emitter server/services/orgHealth.js) only records failures
 * from the moment it ships. Orgs that broke BEFORE that — the "NC orgs with
 * 0 AI messages" cohort — would stay invisible until their next connector
 * request. This one-shot seed classifies them up front so the super-admin
 * fleet view and the org-admin banner are useful on day one:
 *
 *   1. chat.subscription_blocked + bootstrap.community_fallback
 *      NC orgs with NO organization_subscriptions row at all. Predicate
 *      deliberately matches what actually gates chat: userStore.
 *      getEffectiveLimits() returns null ONLY when no subscription row
 *      exists (getOrgSubscription does not filter by status), and that null
 *      is what makes limits.checkSubscriptionLimits block every AI request
 *      on cloud. Orgs with a suspended/cancelled/trialing row are deliberate
 *      states and are NOT seeded (prefer under-seeding).
 *   2. auth.blocked_onboarding_pending
 *      Connector-bound orgs (nc_instance_id set — the only ones the
 *      connectorJwt onboarding gate applies to) that never completed the
 *      onboarding wizard.
 *   3. auth.blocked_pending_approval
 *      Connector-bound orgs whose wizard chose pending-by-default AND that
 *      have pending users AND no active non-admin user — the pending-pileup
 *      fingerprint (admins are auto-activated, so "only admins active"
 *      means every real user is stuck).
 *
 * Severity/message/remediation come from the canonical CODES catalog in
 * server/services/orgHealth.js (imported, not duplicated) so seeded rows and
 * live-emitted rows never diverge. Rows are metadata-only (org ids + a
 * 'reason' marker) — no secrets, keys or content.
 *
 * Idempotent — every INSERT ... SELECT carries
 * ON CONFLICT (subject_key, code) DO NOTHING, so re-runs (and races with the
 * live emitter) never inflate counts or duplicate rows. Auto-runs from server
 * boot (server/index.js). Manual usage:
 *   node server/migrations/org-health-seed-2026-07.js
 */

const { run, exec } = require('../db');
const orgHealthStore = require('../stores/orgHealthStore');
const { CODES } = require('../services/orgHealth');

const SOURCE = 'migration:org-health-seed-2026-07';
const SEED_META = JSON.stringify({ reason: 'seeded from pre-existing state' });

// Broad NC predicate for the subscription seeds (chat blocks apply to every
// connector-provenance org, bound or since unbound); the auth.* gate seeds
// additionally require a live binding (nc_instance_id) because connectorJwt
// only runs for bound instances.
const NC_ORG = `(o.nc_instance_id IS NOT NULL OR o.registration_source = 'nextcloud_connector')`;

async function seedProblem(code, whereSql) {
    const def = CODES[code];
    if (!def) throw new Error(`org-health-seed: unknown code ${code}`);
    const r = await run(
        `INSERT INTO org_health_problems
            (subject_key, organization_id, code, category, severity, source, message, remediation, meta)
         SELECT o.id, o.id, $1, $2, $3, $4, $5, $6, $7::jsonb
           FROM organizations o
          WHERE ${NC_ORG}
            AND (${whereSql})
         ON CONFLICT (subject_key, code) DO NOTHING`,
        [code, def.category, def.severity, SOURCE, def.defaultMessage, def.remediation, SEED_META]
    );
    return r?.rowCount || 0;
}

async function up() {
    // org_health_problems must exist before we insert (store DDL is memoized
    // and retried, so this is cheap when already done at boot).
    await orgHealthStore.initDB();

    // Self-sufficient: guarantee the organizations columns we filter on exist
    // even if this fires before userStore.initDB() on a first boot (harmless
    // duplicates of the initDB ALTERs; a fresh DB has no orgs to seed anyway).
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "registration_source" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_onboarding_completed_at" TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_status" TEXT DEFAULT 'active'`); } catch (e) { }

    const noSubscriptionRow =
        `NOT EXISTS (SELECT 1 FROM organization_subscriptions os WHERE os.organization_id = o.id)`;

    const counts = {};
    counts.subscriptionBlocked = await seedProblem('chat.subscription_blocked', noSubscriptionRow);
    counts.communityFallback = await seedProblem('bootstrap.community_fallback', noSubscriptionRow);

    counts.onboardingPending = await seedProblem('auth.blocked_onboarding_pending',
        `o.nc_instance_id IS NOT NULL AND o.nc_onboarding_completed_at IS NULL`);

    counts.pendingApproval = await seedProblem('auth.blocked_pending_approval',
        `o.nc_instance_id IS NOT NULL
         AND o.nc_new_user_default_status = 'pending'
         AND EXISTS (SELECT 1 FROM users u
                      WHERE u."organizationId" = o.id AND u.status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM users u
                          WHERE u."organizationId" = o.id
                            AND COALESCE(u.status, 'active') = 'active'
                            AND COALESCE(u."orgRole", '') NOT IN ('org_admin', 'admin'))`);

    const total = counts.subscriptionBlocked + counts.communityFallback
        + counts.onboardingPending + counts.pendingApproval;
    if (total > 0) {
        console.log(`[org-health-seed] seeded subscription_blocked=${counts.subscriptionBlocked} `
            + `community_fallback=${counts.communityFallback} onboarding_pending=${counts.onboardingPending} `
            + `pending_approval=${counts.pendingApproval}`);
    }
    return counts;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
