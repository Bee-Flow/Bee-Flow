#!/usr/bin/env node
/**
 * Put the S3 fixture account back the way session one found it.
 *
 * The borrowed-phone study hands a signed-in device to a stranger and watches
 * where they fall over. That only works once: session two opens onto session
 * one's chat history, session one's half-finished notebook and session one's
 * uploads, and the second participant is then navigating a different product
 * from the first. Every finding after the first session is contaminated by the
 * session before it, and nobody notices, because the contamination looks
 * exactly like normal use.
 *
 * So this script exists to be run between sessions, and it has two halves:
 *
 *   --seed    Create the fixture content and then mark the baseline. Run once,
 *             before the first session. Idempotent: it skips anything already
 *             there, so re-running it after a --reset is safe and cheap.
 *
 *   --reset   Delete everything the fixture user created AFTER the baseline.
 *             The fixture content pre-dates the mark and is therefore never
 *             touched — which is the whole reason the baseline is a timestamp
 *             rather than a list of ids to spare.
 *
 * Usage
 *   node server/scripts/research/reseed-fixture-account.js --user <id> --seed
 *   node server/scripts/research/reseed-fixture-account.js --user <id>            # dry run
 *   node server/scripts/research/reseed-fixture-account.js --user <id> --reset --apply
 *
 * Safety
 *   - Dry-run by default. --reset without --apply prints the counts and exits.
 *   - Refuses a non-local database unless RESEARCH_ALLOW_REMOTE=1. The fixture
 *     account is meant to live on a disposable install; if this ever points at
 *     production it is pointing at a real person's chats.
 *   - Refuses to touch a user who has no baseline mark. An unmarked account is
 *     an account this script has never seeded, which means it is somebody's.
 *   - Never deletes the user, the org, the KBs or the documents themselves.
 *     Deleting content the participant merely READ is not a reset, it is a
 *     different fixture.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

const fs = require('fs');

const configStore = require('../../stores/configStore');
const kbStore = require('../../stores/knowledgeBases');
const userStore = require('../../stores/userStore');
const { getAll, getOne, run, pool } = require('../../db');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SEED = argv.includes('--seed');
const RESET = argv.includes('--reset');

function argValue(flag) {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const USER_ID = argValue('--user');
const ORG_ID = argValue('--org');

// ── Guards ──────────────────────────────────────────────────────────────────

const CONN = process.env.CORE_DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_core';
const HOST = (() => { try { return new URL(CONN).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', ''].includes(HOST) && process.env.RESEARCH_ALLOW_REMOTE !== '1') {
    console.error(`Refusing to touch non-local database host "${HOST}". Set RESEARCH_ALLOW_REMOTE=1 if you mean it.`);
    process.exit(1);
}

if (!USER_ID) {
    console.error('Usage: --user <fixture user id> [--org <id>] [--seed | --reset] [--apply]');
    process.exit(1);
}

const BASELINE_KEY = `research_fixture_baseline_${USER_ID}`;

// ── The fixture ─────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, 'fixtures');

const CLEAN_KB = {
    name: 'Contracten',
    description: 'Lopende contracten en inkoopvoorwaarden.',
    docs: [
        ['raamovereenkomst-van-dijk-2025.md', 'Raamovereenkomst Van Dijk BV (2025)'],
        ['onderhoudscontract-brouwer.md', 'Onderhoudscontract Brouwer Klimaat'],
        ['inkoopvoorwaarden-2024.md', 'Algemene inkoopvoorwaarden 2024'],
    ],
};

const MESSY_KB = {
    name: 'Algemeen',
    description: 'Van alles. Nog niet opgeruimd.',
    docs: [
        ['raamovereenkomst-van-dijk-2023.md', 'raamovereenkomst def FINAL (2).md'],
        ['notulen-mt-2025-03.md', 'notulen 12-3'],
        ['beleid-thuiswerken.md', 'Thuiswerkbeleid'],
    ],
};

/**
 * Runs that have already failed, days ago.
 *
 * The Needs-you screen is one of S3's four blocks, and it is empty on a fresh
 * account — so without these the participant is asked to "deal with this" on a
 * screen with nothing on it. The ages are staggered because a column of runs
 * that all failed at the same second reads as a fixture, and a participant who
 * notices the fixture starts performing rather than working.
 *
 * `summary` and `error` are both populated on purpose: RunRow renders whichever
 * it has, and a run with neither is the empty-failure case the fix list already
 * dealt with. These are here to be read, not to test the empty state.
 */
const AGED_RUNS = [
    {
        daysAgo: 1,
        status: 'failed',
        error: 'HTTP 401 from the mail connector',
        summary: 'Could not send the weekly summary: the mailbox connection was rejected. Reconnect the mailbox under Integrations, then run this again.',
    },
    {
        daysAgo: 3,
        status: 'failed',
        error: 'Step "Read the folder" returned no files',
        summary: 'The folder this watches is empty, so there was nothing to file. If that is unexpected, check whether the folder was moved.',
    },
    {
        daysAgo: 6,
        status: 'failed',
        error: 'Timed out after 120s',
        summary: 'The document took too long to read and the run was stopped. A shorter document, or splitting this into two steps, will usually get it through.',
    },
];

const FIXTURE_AUTOMATION = {
    title: 'Weekoverzicht mailen',
    description: 'Elke maandag een samenvatting van de openstaande punten.',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function readFixture(file) {
    return fs.readFileSync(path.join(FIXTURES, file), 'utf8');
}

async function findKbByName(tenantId, name) {
    const rows = await getAll(
        `SELECT id, name FROM knowledge_bases WHERE tenant_id = $1 AND name = $2 LIMIT 1`,
        [tenantId, name],
    );
    return rows?.[0] || null;
}

async function seedKb(spec) {
    let kb = await findKbByName(USER_ID, spec.name);
    if (kb) {
        console.log(`  KB "${spec.name}" already exists (${kb.id})`);
    } else {
        kb = await kbStore.createKB(USER_ID, spec.name, spec.description, ORG_ID || null);
        console.log(`  KB "${spec.name}" created (${kb.id})`);
    }

    // Required late: the ingestion helper pulls in the embedding path, which
    // talks to the search service. Loading it at module scope would make even
    // a dry run depend on that service being up.
    const { ingestDocument } = require('../../core/kb/kbIngestionHelpers');

    for (const [file, title] of spec.docs) {
        const content = readFixture(file);
        try {
            const { chunks } = await ingestDocument(USER_ID, kb.id, content, title, 'text', file);
            console.log(`    + ${title} (${chunks} chunks)`);
        } catch (e) {
            if (e.code === 'DUPLICATE') {
                console.log(`    = ${title} (already ingested)`);
            } else {
                // A failed ingest is not a reason to abandon the rest — but it
                // IS a reason to say so loudly, because a KB that is missing a
                // document silently invalidates the retrieval task.
                console.error(`    ! ${title} FAILED: ${e.message}`);
            }
        }
    }
    return kb;
}

async function seedRuns() {
    const existing = await getOne(
        `SELECT id FROM automations WHERE user_id = $1 AND title = $2 LIMIT 1`,
        [USER_ID, FIXTURE_AUTOMATION.title],
    );

    let automationId = existing?.id;
    if (!automationId) {
        automationId = `auto-fixture-${Date.now()}`;
        await run(
            `INSERT INTO automations (id, user_id, organization_id, title, description, definition_json,
                                     version, is_active, is_draft, needs_first_run_confirm, trigger_type,
                                     schedule_cron, last_status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, 1, TRUE, FALSE, FALSE, 'schedule', '0 8 * * 1', 'failed',
                     NOW() - INTERVAL '30 days', NOW() - INTERVAL '1 day')`,
            [
                automationId, USER_ID, ORG_ID || null,
                FIXTURE_AUTOMATION.title, FIXTURE_AUTOMATION.description,
                JSON.stringify({ steps: [] }),
            ],
        );
        console.log(`  Automation "${FIXTURE_AUTOMATION.title}" created (${automationId})`);
    } else {
        console.log(`  Automation "${FIXTURE_AUTOMATION.title}" already exists (${automationId})`);
    }

    const runCount = await getOne(
        `SELECT COUNT(*)::int AS n FROM automation_runs WHERE automation_id = $1`,
        [automationId],
    );
    if ((runCount?.n || 0) > 0) {
        console.log(`  ${runCount.n} run(s) already present — leaving them alone`);
        return;
    }

    for (const r of AGED_RUNS) {
        await run(
            `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status,
                                         started_at, finished_at, duration_ms, error, summary, created_at)
             VALUES ($1, $2, 1, $3, 'schedule', 'live', $4,
                     NOW() - ($5 || ' days')::interval,
                     NOW() - ($5 || ' days')::interval + INTERVAL '9 seconds',
                     9000, $6, $7,
                     NOW() - ($5 || ' days')::interval)`,
            [
                `run-fixture-${r.daysAgo}-${Date.now()}`, automationId, USER_ID,
                r.status, String(r.daysAgo), r.error, r.summary,
            ],
        );
    }
    console.log(`  ${AGED_RUNS.length} aged failed run(s) inserted`);
}

// ── The two halves ──────────────────────────────────────────────────────────

async function seed() {
    const user = await userStore.getUser(USER_ID).catch(() => null);
    if (!user) {
        console.error(`No such user: ${USER_ID}. Create the fixture account first.`);
        process.exit(1);
    }

    console.log(`Seeding fixture content for ${USER_ID}…`);
    await seedKb(CLEAN_KB);
    await seedKb(MESSY_KB);
    await seedRuns();

    // The mark goes in LAST. If anything above threw, there is no baseline, and
    // a later --reset refuses rather than deleting against a half-built fixture.
    const at = new Date().toISOString();
    await configStore.setConfig(BASELINE_KEY, at);
    console.log(`\nBaseline marked at ${at}.`);
    console.log('Everything this account creates from now on is session residue.');
}

/**
 * The tables a session actually dirties.
 *
 * Deliberately NOT every table with a user_id. Deleting the user's agents, KBs
 * or memories would change what the next participant is looking at, which is
 * the opposite of a reset. `message_feedback` is left alone for the same
 * reason in reverse: a thumbs-down a participant left is a research datum, and
 * the row is invisible to the next session anyway once its conversation is
 * gone.
 *
 * `children` is not decoration. `conversation_messages` and
 * `notebook_conversations` carry no foreign key to their parent, so deleting a
 * conversation row on its own leaves every message in it behind — which is
 * precisely the residue this script exists to remove, still sitting in the
 * database and still readable through search. Each child is deleted first, by
 * subselect on the parents that are about to go.
 */
const RESIDUE = [
    {
        table: 'direct_conversations',
        owner: 'user_id',
        when: 'created_at',
        children: [
            { table: 'conversation_messages', key: 'conversation_id', filter: "conversation_type = 'direct'" },
        ],
    },
    {
        table: 'agent_conversations',
        owner: 'user_id',
        when: 'created_at',
        children: [
            { table: 'conversation_messages', key: 'conversation_id', filter: "conversation_type = 'agent'" },
        ],
    },
    {
        table: 'notebooks',
        owner: 'user_id',
        when: 'created_at',
        // notebook_sources and notebook_versions cascade; notebook_conversations
        // does not.
        children: [{ table: 'notebook_conversations', key: 'notebook_id' }],
    },
    // Deleting these rows does NOT reclaim the audio or the uploaded files
    // behind them — the blob lives in object storage and only the store's own
    // delete path knows its key. On a disposable fixture install that is a
    // disk-space nit, not a leak of anything: every file here is a synthetic
    // one this script or an observer put there. Do not reuse this loop on an
    // account that holds real recordings.
    { table: 'transcriptions', owner: 'user_id', when: 'created_at' },
    { table: 'notifications', owner: 'user_id', when: 'created_at' },
    { table: 'ai_tasks', owner: 'user_id', when: 'created_at' },
    // Runs the participant triggered. The aged fixture runs pre-date the mark
    // and stay, which is what keeps the Needs-you screen populated for the next
    // session without re-seeding it.
    { table: 'automation_runs', owner: 'user_id', when: 'created_at' },
    // Automations the participant built. The fixture automation pre-dates the
    // mark; deleting one cascades to its runs and steps.
    { table: 'automations', owner: 'user_id', when: 'created_at' },
];

/** `SELECT id FROM parent WHERE mine AND newer` — the subselect children use. */
function parentIds(entry) {
    return `SELECT id FROM ${entry.table} WHERE ${entry.owner} = $1 AND ${entry.when} > $2::timestamptz`;
}

async function countRows(sql, params) {
    const row = await getOne(sql, params);
    return row?.n || 0;
}

async function reset() {
    const baseline = await configStore.getConfigFresh(BASELINE_KEY);
    if (!baseline) {
        console.error(
            `No baseline for ${USER_ID}. Run --seed first.\n` +
            'Refusing to delete on an account this script has never marked — without a ' +
            'baseline there is no line between the fixture and somebody\'s real work.',
        );
        process.exit(1);
    }
    console.log(`Baseline: ${baseline}`);
    console.log(APPLY ? 'Deleting session residue…\n' : 'DRY RUN — nothing will be deleted.\n');

    const args = [USER_ID, baseline];
    let total = 0;

    for (const entry of RESIDUE) {
        const { table, owner, when } = entry;
        let n = 0;
        try {
            n = await countRows(
                `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${owner} = $1 AND ${when} > $2::timestamptz`,
                args,
            );
        } catch (e) {
            // A table that does not exist on this install is not an error: the
            // schema differs by which features were ever switched on.
            console.log(`  ${table.padEnd(24)} skipped (${e.message.split('\n')[0]})`);
            continue;
        }

        if (n === 0) {
            console.log(`  ${table.padEnd(24)} clean`);
            continue;
        }

        // Children first, while the parents are still there to select on.
        for (const child of entry.children || []) {
            const where = `${child.key} IN (${parentIds(entry)})` +
                (child.filter ? ` AND ${child.filter}` : '');
            let childCount = 0;
            try {
                childCount = await countRows(
                    `SELECT COUNT(*)::int AS n FROM ${child.table} WHERE ${where}`,
                    args,
                );
            } catch (e) {
                console.log(`    ${child.table.padEnd(22)} skipped (${e.message.split('\n')[0]})`);
                continue;
            }
            if (childCount === 0) continue;
            total += childCount;
            if (!APPLY) {
                console.log(`    ${child.table.padEnd(22)} ${childCount} row(s) would go`);
                continue;
            }
            await run(`DELETE FROM ${child.table} WHERE ${where}`, args);
            console.log(`    ${child.table.padEnd(22)} ${childCount} row(s) deleted`);
        }

        total += n;
        if (!APPLY) {
            console.log(`  ${table.padEnd(24)} ${n} row(s) would go`);
            continue;
        }
        await run(
            `DELETE FROM ${table} WHERE ${owner} = $1 AND ${when} > $2::timestamptz`,
            args,
        );
        console.log(`  ${table.padEnd(24)} ${n} row(s) deleted`);
    }

    console.log(
        APPLY
            ? `\n${total} row(s) removed. The account is back at its baseline.`
            : `\n${total} row(s) would be removed. Re-run with --apply.`,
    );
}

// ── Entry ───────────────────────────────────────────────────────────────────

(async () => {
    try {
        if (SEED && RESET) {
            console.error('Pick one: --seed or --reset.');
            process.exit(1);
        }
        if (SEED) await seed();
        else await reset();
    } catch (e) {
        console.error('Failed:', e.message);
        process.exitCode = 1;
    } finally {
        await pool.end().catch(() => {});
    }
})();
