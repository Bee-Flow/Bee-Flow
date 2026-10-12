#!/usr/bin/env node
/**
 * Backfill encryption over rows written before a tier was switched on.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The policy layer only governs WRITES; reads detect the format of the value in
 * front of them. That asymmetry is what makes toggling safe in both directions,
 * and it also means switching a tier on protects nothing that already exists.
 * An org that enabled encryption after a year of use had a year of plaintext
 * sitting behind an "encrypted" badge.
 *
 * ── Safety properties ───────────────────────────────────────────────────────
 *
 *   • IDEMPOTENT — a value that is already an envelope is skipped, so a rerun
 *     after an interruption costs a read and nothing else.
 *   • RESUMABLE  — batched with a keyset cursor; interrupt it and run it again.
 *   • DRY RUN FIRST — --dry-run reports exactly what would change, and is the
 *     default posture in the docs for a reason.
 *   • ONE KEY SOURCE — every key comes from resolveCrypto, the same resolver
 *     the runtime uses. A backfill that derived its own key would encrypt the
 *     whole history under something the app cannot open, which is worse than
 *     leaving it in plaintext.
 *
 * It never DEcrypts. Turning a tier off leaves existing ciphertext readable, so
 * there is nothing to undo; a --decrypt mode would only add a way to bulk-strip
 * protection by typo.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/backfill-encryption.js --org <orgId> --dry-run
 *   node scripts/backfill-encryption.js --org <orgId>
 *   node scripts/backfill-encryption.js --org <orgId> --surface messages
 *   node scripts/backfill-encryption.js --all-orgs --dry-run
 *
 * The logic lives in stores/encryptionBackfill.js (also used by the admin API);
 * this file is only the command line.
 *
 * On `zk`, message content cannot be backfilled at all: the key is derived from
 * the user's secret at login and no batch job has it. The script says so and
 * skips that surface rather than pretending.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getAll } = require('../db');
const { backfillOrg: runBackfill, RUNNERS } = require('../stores/encryptionBackfill');

function parseArgs(argv) {
    const args = { dryRun: false, orgId: null, allOrgs: false, surfaces: null, limit: Infinity };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') args.dryRun = true;
        else if (a === '--all-orgs') args.allOrgs = true;
        else if (a === '--org') args.orgId = argv[++i];
        else if (a === '--surface') args.surfaces = (args.surfaces || []).concat(argv[++i]);
        else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || Infinity;
        else if (a === '--help' || a === '-h') args.help = true;
        else { console.error(`Unknown argument: ${a}`); process.exit(2); }
    }
    return args;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function backfillOrg(orgId, args) {
    const unknown = (args.surfaces || []).filter(name => !RUNNERS[name]);
    for (const name of unknown) console.error(`  ! unknown surface '${name}' (known: ${Object.keys(RUNNERS).join(', ')})`);

    const res = await runBackfill(orgId, {
        dryRun: args.dryRun,
        surfaces: args.surfaces,
        limit: args.limit,
    });
    if (res.notFound) { console.error(`  ! org '${orgId}' not found`); return; }

    console.log(`\n── ${orgId} (tier: ${res.tier}) ${'─'.repeat(Math.max(0, 40 - orgId.length))}`);
    if (res.tier === 'none') {
        console.log('  tier is `none` — nothing to encrypt. Set a tier first.');
        return;
    }
    if (res.tier === 'zk') {
        // Being explicit beats a silent zero: on zk the content key exists only
        // inside a logged-in session, so no batch job can produce it.
        console.log('  NOTE: on `zk`, message content and notebook chats cannot be backfilled — their key is');
        console.log('        derived at login and never leaves the session. Token maps, titles, conversation');
        console.log('        meta and transcripts use an org-held key and WILL be backfilled.');
    }
    for (const [surface, s] of Object.entries(res.surfaces)) {
        const failed = s.failed ? `, ${s.failed} FAILED (see log)` : '';
        if (surface === 'legacyBlobs') {
            const why = s.reasons && Object.keys(s.reasons).length
                ? ` (${Object.entries(s.reasons).map(([k, n]) => `${k}: ${n}`).join(', ')})` : '';
            const blocked = s.blocked ? `, BLOCKED: ${s.blocked}` : '';
            console.log(`  ${surface}… ${s.migrated || 0} to migrate, ${s.encrypted} old copies to remove, ${s.skipped} skipped${why}, ${s.noKey} no key${failed}${blocked}`);
            continue;
        }
        console.log(`  ${surface}… ${s.encrypted} to encrypt, ${s.skipped} already done, ${s.noKey} no key${failed}`);
    }
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.help || (!args.orgId && !args.allOrgs)) {
        console.log('Usage: node scripts/backfill-encryption.js (--org <id> | --all-orgs) [--dry-run] [--surface <name>] [--limit <n>]');
        console.log(`Surfaces: ${Object.keys(RUNNERS).join(', ')}`);
        process.exit(args.help ? 0 : 2);
    }

    console.log(args.dryRun
        ? '=== DRY RUN — no rows will be modified ==='
        : '=== LIVE RUN — rows will be rewritten ===');

    const orgIds = args.allOrgs
        ? (await getAll("SELECT id FROM organizations WHERE COALESCE(encryption_tier,'none') <> 'none'")).map(r => r.id)
        : [args.orgId];

    if (orgIds.length === 0) { console.log('No organisations have encryption enabled.'); return; }

    for (const id of orgIds) {
        try {
            await backfillOrg(id, args);
        } catch (err) {
            // One org's failure must not abandon the rest — and the run is
            // resumable, so the right move is to report and continue.
            console.error(`  ! ${id} failed: ${err.message}`);
        }
    }

    console.log(args.dryRun
        ? '\nDry run complete. Re-run without --dry-run to apply.'
        : '\nBackfill complete.');
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(err => { console.error('Backfill failed:', err); process.exit(1); });
}

module.exports = { parseArgs, RUNNERS };
