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
 * On `zk`, message content cannot be backfilled at all: the key is derived from
 * the user's secret at login and no batch job has it. The script says so and
 * skips that surface rather than pretending.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getAll, getOne, run } = require('../db');
const { SURFACES } = require('../stores/encryptionPolicy');
const { resolveCrypto, conversationKey, messageAad } = require('../stores/agent/messageCrypto');
const { encryptField, isEnvelope } = require('../stores/lib/fieldEnvelope');
const { sealTitle } = require('../stores/agent/conversationTitle');

const BATCH = 200;

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

const stats = {};
function bump(surface, field, n = 1) {
    stats[surface] = stats[surface] || { encrypted: 0, skipped: 0, noKey: 0 };
    stats[surface][field] += n;
}

/**
 * Per-user crypto contexts, resolved once. On `managed` every resolve unwraps
 * the escrowed DEK, which is an Argon2-class cost we are not paying per row.
 */
const ctxCache = new Map();
async function ctxFor(userId, orgId) {
    if (!userId) return null;
    if (!ctxCache.has(userId)) ctxCache.set(userId, await resolveCrypto({ userId, orgId }));
    return ctxCache.get(userId);
}

// ── Surfaces ────────────────────────────────────────────────────────────────

async function backfillMessages(orgId, dryRun, limit) {
    const surface = SURFACES.MESSAGES;
    let cursor = '';
    let seen = 0;

    for (;;) {
        const rows = await getAll(`
            SELECT m.id, m.conversation_id, m.conversation_type, m.content, m.meta_json,
                   COALESCE(ac.user_id, dc.user_id) AS user_id
            FROM conversation_messages m
            LEFT JOIN agent_conversations  ac ON ac.id = m.conversation_id
            LEFT JOIN direct_conversations dc ON dc.id = m.conversation_id
            LEFT JOIN users u ON u.id = COALESCE(ac.user_id, dc.user_id)
            WHERE m.id > $1 AND u."organizationId" = $2
            ORDER BY m.id ASC LIMIT $3
        `, [cursor, orgId, BATCH]);
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;

        for (const row of rows) {
            if (++seen > limit) return;
            const ctx = await ctxFor(row.user_id, orgId);
            if (!ctx) { bump(surface, 'noKey'); continue; }

            const type = row.conversation_type || 'agent';
            const updates = [];
            const params = [];

            // Each field is judged on its own: a row can easily have encrypted
            // content and plaintext meta if a scope toggle changed mid-life.
            if (ctx.encryptMessages && row.content != null && !isEnvelope(row.content)) {
                params.push(encryptField(row.content, {
                    key: conversationKey(ctx.key, row.conversation_id),
                    aad: messageAad(row.conversation_id, type, 'content'),
                    encrypt: true,
                }));
                updates.push(`content = $${params.length}`);
            }
            if (ctx.encryptMeta && row.meta_json != null && !isEnvelope(row.meta_json)) {
                params.push(encryptField(row.meta_json, {
                    key: conversationKey(ctx.key, row.conversation_id),
                    aad: messageAad(row.conversation_id, type, 'meta'),
                    encrypt: true,
                }));
                updates.push(`meta_json = $${params.length}`);
            }

            if (updates.length === 0) { bump(surface, 'skipped'); continue; }
            bump(surface, 'encrypted');
            if (!dryRun) {
                params.push(row.id);
                await run(`UPDATE conversation_messages SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
            }
        }
    }
}

async function backfillTitles(orgId, dryRun, limit) {
    const surface = SURFACES.CONVERSATION_TITLE;
    let seen = 0;

    for (const [table, type] of [['agent_conversations', 'agent'], ['direct_conversations', 'direct']]) {
        let cursor = '';
        for (;;) {
            const rows = await getAll(`
                SELECT c.id, c.user_id, c.title FROM ${table} c
                JOIN users u ON u.id = c.user_id
                WHERE c.id > $1 AND u."organizationId" = $2 AND c.title IS NOT NULL
                ORDER BY c.id ASC LIMIT $3
            `, [cursor, orgId, BATCH]);
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].id;

            for (const row of rows) {
                if (++seen > limit) return;
                if (isEnvelope(row.title)) { bump(surface, 'skipped'); continue; }
                const ctx = await ctxFor(row.user_id, orgId);
                if (!ctx || !ctx.encryptTitle) { bump(surface, ctx ? 'skipped' : 'noKey'); continue; }
                bump(surface, 'encrypted');
                if (!dryRun) {
                    await run(`UPDATE ${table} SET title = $1 WHERE id = $2`,
                        [sealTitle(row.title, row.id, type, ctx), row.id]);
                }
            }
        }
    }
}

async function backfillTokenMaps(orgId, dryRun, limit) {
    const surface = SURFACES.PII_TOKEN_MAP;
    let seen = 0;

    for (const table of ['agent_conversations', 'direct_conversations']) {
        let cursor = '';
        for (;;) {
            const rows = await getAll(`
                SELECT c.id, c.user_id, c.pii_token_map FROM ${table} c
                JOIN users u ON u.id = c.user_id
                WHERE c.id > $1 AND u."organizationId" = $2 AND c.pii_token_map IS NOT NULL
                ORDER BY c.id ASC LIMIT $3
            `, [cursor, orgId, BATCH]);
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].id;

            for (const row of rows) {
                if (++seen > limit) return;
                if (isEnvelope(row.pii_token_map)) { bump(surface, 'skipped'); continue; }
                const ctx = await ctxFor(row.user_id, orgId);
                // The token map rides on backgroundKey — it is written by the
                // DLP runner, which never has a session.
                if (!ctx || !ctx.backgroundKey) { bump(surface, 'noKey'); continue; }
                bump(surface, 'encrypted');
                if (!dryRun) {
                    const sealed = encryptField(JSON.stringify(row.pii_token_map), {
                        key: ctx.backgroundKey,
                        aad: `bfpii:v1:${row.id}`,
                        encrypt: true,
                        asObject: true,
                    });
                    await run(`UPDATE ${table} SET pii_token_map = $1::jsonb WHERE id = $2`,
                        [JSON.stringify(sealed), row.id]);
                }
            }
        }
    }
}

const RUNNERS = {
    [SURFACES.MESSAGES]: backfillMessages,
    [SURFACES.CONVERSATION_TITLE]: backfillTitles,
    [SURFACES.PII_TOKEN_MAP]: backfillTokenMaps,
};

// ── Main ────────────────────────────────────────────────────────────────────

async function backfillOrg(orgId, args) {
    const org = await getOne('SELECT id, encryption_tier FROM organizations WHERE id = $1', [orgId]);
    if (!org) { console.error(`  ! org '${orgId}' not found`); return; }

    console.log(`\n── ${orgId} (tier: ${org.encryption_tier || 'none'}) ${'─'.repeat(Math.max(0, 40 - orgId.length))}`);
    if ((org.encryption_tier || 'none') === 'none') {
        console.log('  tier is `none` — nothing to encrypt. Set a tier first.');
        return;
    }
    if (org.encryption_tier === 'zk') {
        // Being explicit beats a silent zero: on zk the content key exists only
        // inside a logged-in session, so no batch job can produce it.
        console.log('  NOTE: on `zk`, message content cannot be backfilled — its key is derived at');
        console.log('        login and never leaves the session. Token maps and titles use the org');
        console.log('        escrow and WILL be backfilled.');
    }

    const wanted = args.surfaces || Object.keys(RUNNERS);
    for (const surface of wanted) {
        const runner = RUNNERS[surface];
        if (!runner) { console.error(`  ! unknown surface '${surface}' (known: ${Object.keys(RUNNERS).join(', ')})`); continue; }
        process.stdout.write(`  ${surface}… `);
        await runner(orgId, args.dryRun, args.limit);
        const s = stats[surface] || { encrypted: 0, skipped: 0, noKey: 0 };
        console.log(`${s.encrypted} to encrypt, ${s.skipped} already done, ${s.noKey} no key`);
        delete stats[surface];
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
