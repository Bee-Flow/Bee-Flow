#!/usr/bin/env node
/**
 * Delete organisations and everything under them — by explicit id.
 *
 * Background:
 *   An authorised pentest on 2026-08-10 left a trail of throwaway tenants and
 *   accounts behind (the report named three; the database actually held a dozen,
 *   including one org carrying an ACTIVE enterprise licence). Removing them by
 *   hand means remembering the cascade order across ~20 tables, which is exactly
 *   the kind of thing that leaves orphans. userStore.deleteOrganization already
 *   knows that order, so this script is a safe, auditable front-end to it rather
 *   than a second implementation.
 *
 * What it does (per org): calls userStore.deleteOrganization(orgId), which
 * deletes every member via deleteUser (chats, notebooks, memories, PII vault,
 * connections, agents, …), then the org's groups, subscriptions, voiceprints,
 * connection grants, per-org config keys, knowledge bases, projects, tasks,
 * custom tables (including DROP TABLE for dynamic ones), dashboards and finally
 * the organisations row. licence_keys rows disappear on their own — that table
 * has ON DELETE CASCADE on organization_id.
 *
 * Usage:
 *   node server/scripts/deleteOrgs.js --orgs a,b,c              # dry-run (default)
 *   node server/scripts/deleteOrgs.js --orgs a,b,c --apply      # actually delete
 *   node server/scripts/deleteOrgs.js --orgs a --apply --yes    # skip the confirmation pause
 *
 * Safety:
 *   - Dry-run by default: prints exactly what would go, with member counts,
 *     licences and a CSV, and changes nothing.
 *   - Ids must be listed explicitly. There is deliberately no pattern match:
 *     a `--like pentest%` flag is one typo away from deleting a customer.
 *   - PROTECTED_ORG_IDS can never be deleted, whatever the flags say.
 *   - Refuses to run against a non-local database unless --force-remote is
 *     given, so a stray shell with production credentials cannot wipe tenants.
 *   - --apply pauses for 5 seconds first, listing what is about to go.
 *
 * This is destructive and irreversible. Take a database dump first.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { pool } = require('../db');
const userStore = require('../stores/userStore');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const YES = argv.includes('--yes');
const FORCE_REMOTE = argv.includes('--force-remote');

function argValue(flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

// Never deletable, regardless of what is passed in.
//   bee-flow  — the operator's own tenant on every install
//   org-smoke — the standing DLP/stack smoke-test org (see the smoke runbook);
//               deleting it silently breaks the authenticated smoke test
const PROTECTED_ORG_IDS = new Set(['bee-flow', 'org-smoke']);

/**
 * Is the configured database a local/dev one?
 *
 * The rule is the shape of the hostname, not a list of names. A managed
 * production endpoint is always a routable FQDN or IP (…​.rdb.fr-par.scw.cloud,
 * an IPv4 literal); a docker-compose service is a bare label with no dot
 * ("postgres", "beeflow-postgres"). So: loopback and dotless names are local,
 * anything with a dot is treated as remote and needs --force-remote.
 *
 * A list would have to be kept in sync with every environment and would fail
 * open the day someone adds one — this fails closed instead.
 */
function isLocalDatabase() {
    const explicit = process.env.PGHOST || process.env.DB_HOST || '';
    let host = explicit;
    if (!host && process.env.DATABASE_URL) {
        try { host = new URL(process.env.DATABASE_URL).hostname; } catch (_) { host = ''; }
    }
    if (!host) return false; // can't tell → treat as remote
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === 'host.docker.internal') return true;
    return !h.includes('.'); // bare docker-compose service label
}

async function main() {
    const raw = argValue('--orgs');
    if (!raw) {
        console.error('Nothing to do: pass --orgs <id[,id...]>.');
        console.error('Run with --orgs a,b to see a dry-run of what would be deleted.');
        process.exit(2);
    }

    if (!isLocalDatabase() && !FORCE_REMOTE) {
        console.error('Refusing to run: the configured database does not look local.');
        console.error('If you really mean to delete tenants there, re-run with --force-remote.');
        process.exit(2);
    }

    const requested = raw.split(',').map(s => s.trim()).filter(Boolean);
    const protectedHits = requested.filter(id => PROTECTED_ORG_IDS.has(id));
    const targets = requested.filter(id => !PROTECTED_ORG_IDS.has(id));

    for (const id of protectedHits) {
        console.log(`SKIP  ${id} — protected, never deletable by this script.`);
    }

    const rows = [];
    const csv = ['org_id,org_name,members,licences,exists'];
    for (const orgId of targets) {
        const org = await userStore.getOrganization(orgId);
        if (!org) {
            console.log(`SKIP  ${orgId} — no such organisation.`);
            csv.push(`${orgId},,0,0,false`);
            continue;
        }
        const members = await pool.query('SELECT id, email, "orgRole" FROM users WHERE "organizationId" = $1 ORDER BY id', [orgId]);
        const licences = await pool.query('SELECT id, tier, refresh_status FROM license_keys WHERE organization_id = $1', [orgId]);
        rows.push({ org, members: members.rows, licences: licences.rows });
        csv.push(`${orgId},"${(org.name || '').replace(/"/g, '""')}",${members.rowCount},${licences.rowCount},true`);
    }

    if (rows.length === 0) {
        console.log('\nNothing matched — no organisation deleted.');
        await pool.end();
        return;
    }

    console.log('─'.repeat(78));
    for (const { org, members, licences } of rows) {
        console.log(`${APPLY ? 'DELETE' : 'would delete'}  ${org.id}  (${org.name || 'unnamed'})`);
        for (const m of members) {
            console.log(`    user     ${m.id}${m.email ? ` <${m.email}>` : ''}${m.orgRole ? ` [${m.orgRole}]` : ''}`);
        }
        for (const l of licences) {
            console.log(`    licence  ${l.id} tier=${l.tier} status=${l.refresh_status}`);
        }
    }
    console.log('─'.repeat(78));
    console.log(`${rows.length} organisation(s), ${rows.reduce((n, r) => n + r.members.length, 0)} user(s), ${rows.reduce((n, r) => n + r.licences.length, 0)} licence row(s).`);

    if (!APPLY) {
        console.log('\nCSV:');
        console.log(csv.join('\n'));
        console.log('\nDry run — nothing was changed. Re-run with --apply to commit.');
        await pool.end();
        return;
    }

    if (!YES) {
        console.log('\nDeleting in 5 seconds. Ctrl-C to abort.');
        await new Promise(r => setTimeout(r, 5000));
    }

    let ok = 0;
    for (const { org } of rows) {
        try {
            await userStore.deleteOrganization(org.id);
            console.log(`deleted  ${org.id}`);
            ok++;
        } catch (err) {
            console.error(`FAILED   ${org.id}: ${err.message}`);
        }
    }
    console.log('─'.repeat(78));
    console.log(`Deleted ${ok}/${rows.length} organisation(s).`);

    await pool.end();
}

main().catch(err => {
    console.error('deleteOrgs failed:', err);
    pool.end().catch(() => {});
    process.exit(1);
});
