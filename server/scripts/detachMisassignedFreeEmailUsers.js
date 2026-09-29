#!/usr/bin/env node
/**
 * Detach users who were wrongly auto-bound to an organisation because their
 * free/public email domain (gmail.com, …) matched an org's contact-email domain
 * or allowed_domains.
 *
 * Background:
 *   The OAuth login path resolved a user's organisation by email domain with no
 *   free-provider exclusion, so a personal gmail account got bound to whichever
 *   org happened to carry a gmail contact address (the free-mail org-binding
 *   incident), and every gmail signup collapsed onto the first such org. The
 *   code path is fixed (server/auth/ssoUserResolver.js +
 *   utils/freeEmailDomains.js); this script cleans up the rows that were
 *   already written.
 *
 * What it does (per affected user): clears organizationId + orgRole, drops the
 * groups owned by that org, and sets status='active' (an org-less account is a
 * consumer account — see server/auth/loginRoutes.js). No user is deleted.
 *
 * Usage:
 *   node server/scripts/detachMisassignedFreeEmailUsers.js                 # dry-run (default)
 *   node server/scripts/detachMisassignedFreeEmailUsers.js --apply         # actually mutate
 *   node server/scripts/detachMisassignedFreeEmailUsers.js --org <orgId>   # limit to one org
 *   node server/scripts/detachMisassignedFreeEmailUsers.js --since 2026-01-01  # created on/after
 *
 * Safety:
 *   - Dry-run by default; prints a table + CSV of exactly what --apply would do.
 *   - Never touches org_admins, Nextcloud-provisioned users, Azure users, or
 *     users with a matching invitation (those bindings are legitimate).
 *   - Leaves support-thread org snapshots and the consent ledger untouched
 *     (historical records).
 *   - Re-running is a no-op (detached users no longer match).
 */

const path = require('path');
const { pool } = require(path.join(__dirname, '..', 'db'));
const userStore = require(path.join(__dirname, '..', 'stores', 'userStore'));
const freeEmailDomains = require(path.join(__dirname, '..', 'utils', 'freeEmailDomains'));

const APPLY = process.argv.includes('--apply');
function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const ONLY_ORG = argValue('--org');
const SINCE = argValue('--since'); // YYYY-MM-DD, compared against createdAt (date)

// Same per-user data tables as cleanupAzureDuplicates.js — used to warn when a
// detached user carries history (informational only; we never delete it).
const USER_DATA_TABLES = [
    { table: 'user_memories', column: 'user_id' },
    { table: 'agent_conversations', column: 'user_id' },
    { table: 'direct_conversations', column: 'user_id' },
    { table: 'execution_history', column: 'user_id' },
];

async function countUserRows(userId) {
    const counts = {};
    let total = 0;
    for (const { table, column } of USER_DATA_TABLES) {
        try {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`,
                [userId],
            );
            const n = rows[0]?.n || 0;
            if (n > 0) counts[table] = n;
            total += n;
        } catch (_) { /* table may not exist — treat as zero */ }
    }
    return { counts, total };
}

// Legitimacy signals — queried defensively (tables may be absent on some
// deployments). An invitation to the bound org means the binding is intended.
async function hasInvitation(email, orgId) {
    if (!email) return false;
    try {
        const { rows } = await pool.query(
            `SELECT 1 FROM invitations WHERE LOWER(email) = LOWER($1) AND organization_id = $2 LIMIT 1`,
            [email, orgId],
        );
        return rows.length > 0;
    } catch (_) { return false; }
}
async function hasConsumerConsent(userId) {
    try {
        const { rows } = await pool.query(
            `SELECT 1 FROM consent_acceptances WHERE user_id = $1 AND account_type = 'consumer' LIMIT 1`,
            [userId],
        );
        return rows.length > 0;
    } catch (_) { return false; }
}

function emailDomain(email) {
    const at = String(email || '').indexOf('@');
    return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

// A binding is "explainable by the bug" if the bound org's own contact-email
// domain equals the user's domain, or the org allow-lists that domain.
function bindingExplainedByBug(org, domain) {
    if (!org) return false;
    if (Array.isArray(org.allowedDomains) && org.allowedDomains.map(d => String(d).toLowerCase()).includes(domain)) return true;
    return emailDomain(org.email) === domain;
}

async function main() {
    console.log('─'.repeat(78));
    console.log(`Detach mis-assigned free-email users — ${APPLY ? 'APPLY' : 'DRY-RUN'}`
        + `${ONLY_ORG ? `  org=${ONLY_ORG}` : ''}${SINCE ? `  since=${SINCE}` : ''}`);
    console.log('─'.repeat(78));

    const [users, orgs, groups, freeSet] = await Promise.all([
        userStore.getAllUsers(),
        userStore.getAllOrganizations(),
        userStore.getAllGroups(),
        freeEmailDomains.getEffectiveFreeEmailDomains(),
    ]);
    const orgById = new Map(orgs.map(o => [o.id, o]));
    // group id → owning org id (for stripping org-scoped groups on detach)
    const groupOrg = new Map(groups.map(g => [g.id, g.organization_id || null]));

    const candidates = [];
    let skippedInvited = 0;

    for (const u of users) {
        const domain = emailDomain(u.email);
        if (!domain || !freeEmailDomains.isFreeEmailDomain(domain, freeSet)) continue;
        if (!u.organizationId) continue;
        if (!(u.orgRole === '' || u.orgRole === 'user' || u.orgRole == null)) continue; // spare org_admins
        if (String(u.id).startsWith('nc_')) continue;                 // Nextcloud-provisioned
        if (u.nc_uid) continue;
        if (u.azureUserId) continue;                                  // Azure/Microsoft SSO
        if (ONLY_ORG && u.organizationId !== ONLY_ORG) continue;
        if (SINCE && u.createdAt && String(u.createdAt) < SINCE) continue;

        const org = orgById.get(u.organizationId);
        if (!bindingExplainedByBug(org, domain)) continue;            // some other reason bound them

        if (await hasInvitation(u.email, u.organizationId)) { skippedInvited++; continue; }

        candidates.push({ u, org, domain });
    }

    if (candidates.length === 0) {
        console.log('No mis-assigned free-email users found. ✅');
        if (skippedInvited) console.log(`(${skippedInvited} free-email user(s) skipped — they have an invitation to their org.)`);
        await pool.end();
        return;
    }

    console.log(`Found ${candidates.length} affected user(s)`
        + `${skippedInvited ? ` (+${skippedInvited} skipped as invited)` : ''}:\n`);

    const csv = [['id', 'email', 'orgId', 'orgName', 'orgRole', 'status', 'createdAt', 'consumerConsent', 'dataRows'].join(',')];
    const affectedOrgs = new Set();

    for (const { u, org } of candidates) {
        const { counts, total } = await countUserRows(u.id);
        const consumerConsent = await hasConsumerConsent(u.id);
        affectedOrgs.add(u.organizationId);

        const refsStr = total === 0 ? 'no data' : Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ');
        console.log(`• ${u.email}  (id=${u.id})`);
        console.log(`    org=${org?.name || u.organizationId} (${u.organizationId})  orgRole='${u.orgRole || ''}'  status=${u.status || 'active'}`);
        console.log(`    created=${u.createdAt || '?'}  consumerConsent=${consumerConsent ? 'yes' : 'no'}  data: ${refsStr}`);

        const orgGroups = (u.groups || []).filter(g => groupOrg.get(g) === u.organizationId);
        const remaining = (u.groups || []).filter(g => groupOrg.get(g) !== u.organizationId);
        if (orgGroups.length) console.log(`    would drop ${orgGroups.length} org-owned group(s): ${orgGroups.join(', ')}`);

        if (APPLY) {
            await userStore.updateUser(u.id, {
                organizationId: '',
                orgRole: '',
                groups: remaining,
                status: 'active',
            });
            console.log('    ✔ detached');
        } else {
            console.log('    → would detach (organizationId → "", orgRole → "", status → active)');
        }

        csv.push([
            u.id, u.email, u.organizationId, JSON.stringify(org?.name || ''), u.orgRole || '',
            u.status || 'active', u.createdAt || '', consumerConsent ? 'yes' : 'no', total,
        ].join(','));
        console.log('');
    }

    // Re-bill per-seat plans for the orgs we removed users from.
    if (APPLY) {
        try {
            const { syncSeatQuantityForOrg } = require(path.join(__dirname, '..', 'services', 'stripeService'));
            for (const orgId of affectedOrgs) {
                try { await syncSeatQuantityForOrg(orgId); } catch (_) { /* best-effort */ }
            }
        } catch (_) { /* stripe optional */ }
    }

    console.log('─'.repeat(78));
    console.log(`Summary: ${candidates.length} user(s) across ${affectedOrgs.size} org(s) — ${APPLY ? 'DETACHED' : 'would detach'}.`);
    console.log('\nCSV:');
    console.log(csv.join('\n'));
    console.log('─'.repeat(78));
    if (!APPLY) console.log('Run again with --apply to commit these changes.');

    await pool.end();
}

main().catch(err => {
    console.error('detachMisassignedFreeEmailUsers failed:', err);
    pool.end().catch(() => {});
    process.exit(1);
});
