// @typecheck
/**
 * `automation_usage` — WHO RUNS THIS AUTOMATION? (P4 part C)
 *
 * The mirror of `automation_datatable_usage`: that answers "who touches this
 * TABLE", this answers "who presses this AUTOMATION". Today there is one kind of
 * user — a button in a Studio app (`consumer_kind = 'app'`) — and the
 * table is shaped so that a web page or an agent can join later
 * without reshaping it.
 *
 * ── WHY ITS OWN TABLE, AND NOT A FIELD IN THE EXISTING INDEX ───────
 *
 * `automation_datatable_usage` is keyed per TABLE TARGET, and that is an FK, not a
 * convention: `datatable_id TEXT NOT NULL REFERENCES datatables(id) ON DELETE
 * CASCADE`. Three consequences, each of them on its own fatal for reuse:
 *
 *   1. The INSERT is gated on the datatable row (`INSERT … SELECT … FROM
 *      datatables d WHERE d.id = $6`). Without a row in `datatables` it writes
 *      ZERO rows and calls itself successful — the silent gate that this whole
 *      family exists to keep closed.
 *   2. The scope comes from the TABLE, not from the user. Without a table there is
 *      no scope source.
 *   3. The CASCADE hangs on `datatables`. An app→automation row must disappear
 *      when the APP or the AUTOMATION is gone — a different lifetime.
 *
 * Add to that the deploy reason stated in the header of datatableStore.js: that
 * DDL runs at every module load on every replica during a rolling deploy with
 * automatic `rollout undo`, so that table is not reshaped. Hence this one.
 *
 * ── THE KEY: (kind, user, reference, automation) ────────────────────
 *
 * `ref_id` is the ACTION (`act:<actionId>`), not the step. A sequence step
 * has no id — `containsStepKind` in appStudio/validate/actions.js walks it
 * by POSITION — and a position as half of the primary key is exactly what W5
 * forbids: it shifts with every edit, the reconcile writes a new
 * row and the index grows until it means nothing. An action id is stable
 * (validate.js enforces `act_xxxx`), so one row per (app, action, automation).
 *
 * `automation_id` is IN the key because one action can run two automations
 * (two `run_automation` steps in the same sequence). Without that the
 * second would overwrite the first and one of the two automations would see
 * itself as unused.
 *
 * ── THE INSERT IS GATED ON THE OWNER ────────────────────────────────
 *
 * This is the most important rule in this file. `INSERT … SELECT … FROM
 * automations a WHERE a.id = $x AND a.user_id = $ownerUserId` — the row only comes
 * in if the automation REALLY exists and belongs to the same person as the app.
 *
 * Why ownership and nothing broader: an app runs an automation ACTS-AS-OWNER
 * (`appStudio/actionExecutor/automationBridge.js`: "a post-wiring transfer must
 * never let the app run someone else's automation acts-as-owner"), and that bridge
 * refuses when `automation.userId !== app.userId`. A reference across the owner
 * boundary therefore cannot run; indexing it anyway would show the automation's
 * owner the NAME of someone else's app ("used by 1 button" from a person they do not
 * know), on the basis of a link that refuses at the first click. Unknown narrows,
 * so: no row.
 *
 * And because the guard sits in the INSERT and not at the caller, "who is the
 * owner" is one fact from one row: `owner_user_id` and `organization_id` are
 * read from the automation, never copied from the caller — the same rule
 * that `reconcileUsageFor` applies to the datatable scope.
 *
 * The consequence for the caller: a NON-empty list that writes ZERO rows is
 * not a successful reconcile but an ownership or existence problem, and the
 * reconciler should say so (see automationUsageSync.js).
 *
 * ── THERE IS NO FK, SO THERE MUST BE PURGING ────────────────────────
 *
 * `automations` and `studio_apps` belong to other stores; an FK between store
 * schemas that each run their own boot DDL is exactly the ordering dependency that
 * neither can guarantee. So two purge paths: `purgeUsageForConsumer` if the APP
 * is gone, `purgeUsageOfAutomation` if the AUTOMATION is gone. Both are called from the delete
 * path; which files those are is stated in appStudio/automationUsage.savePaths.test.js.
 *
 * ── DDL VIA runDdl ───────────────────────────────────────────────────
 *
 * The ladder rule (boot/bootMigrations.test.js): a new column or table belongs
 * in the idempotent boot DDL of its own store, and then via `runDdl`
 * (stores/lib/_ddl.js) — not in a loose migration file and not in a
 * `DO $$ … EXCEPTION WHEN OTHERS THEN NULL` block, because that swallows a
 * statement timeout just as hard as "already existed". The claim is stated as a
 * COLUMN_LADDERS entry in that test.
 */

'use strict';

const { run, getOne, getAll, withTransaction } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { runDdl } = require('./lib/_ddl');

/**
 * What an automation can switch on. Today only an app button. Adding a kind
 * means putting its reconciler on EVERY save path of that kind —
 * appStudio/automationUsage.savePaths.test.js keeps that list.
 */
const CONSUMER_KINDS = Object.freeze(['app']);

/**
 * @param {string} kind
 * @param {string} who
 */
function assertConsumerKind(kind, who) {
    if (!CONSUMER_KINDS.includes(kind)) {
        throw new Error(`${who} requires a consumerKind of ${CONSUMER_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`);
    }
    return kind;
}

const initDB = makeStoreInit('AutomationUsageStore', async () => {
    const res = await runDdl('automationUsageStore', [
        `CREATE TABLE IF NOT EXISTS automation_usage (
            automation_id   TEXT NOT NULL,
            consumer_kind   TEXT NOT NULL,
            consumer_id     TEXT NOT NULL,
            ref_id          TEXT NOT NULL,
            owner_user_id   TEXT NOT NULL,
            organization_id TEXT,
            screen_id       TEXT,
            node_id         TEXT,
            label           TEXT,
            wired           BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (consumer_kind, consumer_id, ref_id, automation_id)
        )`,
        // "Who uses THIS automation" is the hot question (the capsule, and later
        // the gate for a deletion), so it gets its own index.
        `CREATE INDEX IF NOT EXISTS idx_automation_usage_automation ON automation_usage(automation_id)`,
        // En de andere kant: alles van één app opruimen of vervangen.
        `CREATE INDEX IF NOT EXISTS idx_automation_usage_consumer ON automation_usage(consumer_kind, consumer_id)`,
        // ── THE THIRD ANSWER: "NEVER CHECKED" ─────────────────────────
        //
        // `automation_usage` can only show rows. Zero rows there means two
        // completely different things: "no button at all runs this
        // automation" and "this index has never been built for that app yet". On the
        // day of rollout that second one is true for EVERY existing app — the table is
        // created empty and only fills when someone saves an app —
        // and then every automation owner reads "No app button runs this automation
        // yet" about buttons that do run. That is a statement about the
        // world, made on a table that has never been filled.
        //
        // Hence this bookkeeping table: one row per user (today: per app)
        // that has ever been indexed. It makes "empty" and "unknown" distinguishable,
        // and it is the work list of the backfill.
        `CREATE TABLE IF NOT EXISTS automation_usage_indexed (
            consumer_kind   TEXT NOT NULL,
            consumer_id     TEXT NOT NULL,
            indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (consumer_kind, consumer_id)
        )`,
    ]);
    // runDdl reports SQLSTATE errors back instead of throwing. Here that is
    // not enough: on a half-built schema every read silently returns an empty
    // list, and empty means here "no button at all runs this
    // automation" — precisely the claim that nobody may make without a table.
    if (res.failures.length) {
        throw new Error(`automation_usage DDL faalde (${res.failures.map(f => f.code).join(', ')}) — zie de [DDL:automationUsageStore]-regels`);
    }
});

/**
 * The tables that `listUsageOfAutomation` may LEFT JOIN, polled once.
 *
 * `studio_apps` belongs to a store that creates its DDL at FIRST USE, so
 * on a fresh installation it can be missing until someone opens App Studio — and
 * a JOIN to a non-existent relation is a 500 on the capsule. Same
 * `to_regclass` trick as `datatableStore.consumerJoins`: remembered once it is
 * there, until then one cheap query per call. If it is missing, the rows come
 * back with an empty title — never with fewer rows.
 */
/** @type {{ apps: boolean; } | null} */
let _joinable = null;
async function consumerJoins() {
    if (_joinable) return _joinable;
    const r = await getOne(`SELECT (to_regclass('studio_apps') IS NOT NULL) AS apps`);
    const have = { apps: !!r?.apps };
    if (have.apps) _joinable = have;
    return have;
}

function mapRow(r) {
    return {
        automationId: r.automation_id,
        consumerKind: r.consumer_kind,
        consumerId: r.consumer_id,
        consumerTitle: r.app_title || null,
        // The OWNER OF THE AUTOMATION, not of the app. The column is called
        // `owner_user_id` and is read at the INSERT from `automations.user_id`;
        // calling it `consumerOwner` would read it as an
        // app-ownership check while it is a staleness filter on the
        // automation owner. Who may OPEN the APP is a different question, and
        // that is answered in the route (`canOpen`), not derived.
        automationOwner: r.owner_user_id || null,
        refId: r.ref_id,
        // `ref_id` is `act:<actionId>`; het scherm leest liever het kale id.
        actionId: typeof r.ref_id === 'string' && r.ref_id.startsWith('act:') ? r.ref_id.slice(4) : null,
        screenId: r.screen_id || null,
        nodeId: r.node_id || null,
        label: r.label || null,
        wired: r.wired !== false,
        organizationId: r.organization_id || null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

/**
 * Sets the index equal to what ONE user (today: one app) now names in automations.
 * Delete-then-insert on `(consumer_kind, consumer_id)`.
 *
 * THE CALLER MUST KNOW: an empty `entries` WIPES everything of this user.
 * That is the intent — an app that removes its last button should disappear
 * from the index — but it also means that a FAILED scan must never come in here as
 * an empty list. That rule belongs to the reconciler
 * (appStudio/automationUsageSync.js, line 1), not here: this layer cannot see
 * the difference between "nothing found" and "could not look".
 *
 * @param {'app'} consumerKind
 * @param {string} consumerId          the studio_apps id
 * @param {string} ownerUserId         the OWNER of that app — the INSERT requires
 *   that the automation belongs to the same person; see the header.
 * @param {Array<{automationId:string, refId:string, screenId?:string|null,
 *                nodeId?:string|null, label?:string|null, wired?:boolean}>} entries
 * @returns {Promise<number>} rows that were ACTUALLY written — not how many
 *   were offered. A non-empty list that writes 0 means: the automation
 *   does not exist (any more), or it belongs to someone else.
 */
async function reconcileAutomationUsage(consumerKind, consumerId, ownerUserId, entries) {
    await initDB();
    assertConsumerKind(consumerKind, 'reconcileAutomationUsage');
    if (!consumerId) throw new Error('reconcileAutomationUsage requires a consumerId');
    if (!ownerUserId) throw new Error('reconcileAutomationUsage requires an ownerUserId');
    const rows = (Array.isArray(entries) ? entries : [])
        .filter(e => e && typeof e.automationId === 'string' && e.automationId
            && typeof e.refId === 'string' && e.refId);

    return withTransaction(async (client) => {
        await client.query(
            `DELETE FROM automation_usage WHERE consumer_kind = $1 AND consumer_id = $2`,
            [consumerKind, consumerId],
        );
        let written = 0;
        for (const e of rows) {
            const r = await client.query(
                `INSERT INTO automation_usage
                    (automation_id, consumer_kind, consumer_id, ref_id,
                     owner_user_id, organization_id, screen_id, node_id, label, wired)
                 SELECT a.id, $1, $2, $3, a.user_id, a.organization_id, $4, $5, $6, $7
                   FROM automations a
                  WHERE a.id = $8 AND a.user_id = $9
                 ON CONFLICT (consumer_kind, consumer_id, ref_id, automation_id)
                 DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id,
                               organization_id = EXCLUDED.organization_id,
                               screen_id = EXCLUDED.screen_id,
                               node_id = EXCLUDED.node_id,
                               label = EXCLUDED.label,
                               wired = EXCLUDED.wired,
                               updated_at = NOW()`,
                [consumerKind, consumerId, e.refId,
                    e.screenId || null, e.nodeId || null, e.label || null, e.wired !== false,
                    e.automationId, ownerUserId],
            );
            written += r?.rowCount || 0;
        }
        // In the SAME transaction as the delete-then-insert: "this app has been
        // looked at" and "this is what it switches on" are the same fact, and a
        // marker without rows (or the reverse) would break exactly the distinction it
        // has to carry. Zero rows written is also a valid outcome — an app that
        // switches on nothing is simply indexed.
        await client.query(
            `INSERT INTO automation_usage_indexed (consumer_kind, consumer_id)
             VALUES ($1, $2)
             ON CONFLICT (consumer_kind, consumer_id) DO UPDATE SET indexed_at = NOW()`,
            [consumerKind, consumerId],
        );
        return written;
    });
}

/**
 * Is the index complete enough for "no rows" to mean something?
 *
 * True: every app that exists today has been indexed at least once. False:
 * there is at least one that has never been looked at, and then no screen may
 * claim "used nowhere" — that button may be in that app.
 *
 * `studio_apps` belongs to a store that creates its DDL at FIRST USE, so
 * on a fresh installation the table may be missing. Then there is also no app
 * that can be unindexed: `complete: true`, `pending: 0`. Unknown therefore narrows
 * here TO complete, and that is not an exception to the rule but the rule
 * itself — without apps there can be no button that we are missing.
 *
 * @returns {Promise<{complete: boolean, pending: number}>}
 */
async function usageIndexCoverage() {
    await initDB();
    const have = await consumerJoins();
    if (!have.apps) return { complete: true, pending: 0 };
    const r = await getOne(
        `SELECT COUNT(*)::int AS pending
           FROM studio_apps a
          WHERE NOT EXISTS (
                SELECT 1 FROM automation_usage_indexed i
                 WHERE i.consumer_kind = 'app' AND i.consumer_id = a.id)`,
    );
    const pending = Number(r?.pending) || 0;
    return { complete: pending === 0, pending };
}

/**
 * The apps that have never been indexed — the work list of the backfill.
 * Bounded, because this runs alongside a request.
 * @param {number} [limit]
 */
async function listUnindexedApps(limit = 50) {
    await initDB();
    const have = await consumerJoins();
    if (!have.apps) return [];
    const rows = await getAll(
        `SELECT a.id
           FROM studio_apps a
          WHERE NOT EXISTS (
                SELECT 1 FROM automation_usage_indexed i
                 WHERE i.consumer_kind = 'app' AND i.consumer_id = a.id)
          ORDER BY a.updated_at DESC NULLS LAST
          LIMIT $1`,
        [Math.max(1, Math.min(Number(limit) || 50, 500))],
    );
    return (rows || []).map(r => r.id);
}

/**
 * Who runs this automation — the capsule.
 *
 * Only rows of this automation; the app's title comes along via a LEFT JOIN
 * so that a vanished app yields a nameless row instead of a
 * missing one. Sorting on `updated_at DESC` so that the most recently touched button
 * is at the top, the same as `datatableStore.listUsage`.
 * @param {string} automationId
 */
async function listUsageOfAutomation(automationId) {
    await initDB();
    if (!automationId) return [];
    const have = await consumerJoins();
    const rows = await getAll(
        `SELECT u.*${have.apps ? `, s.name AS app_title` : ''}
           FROM automation_usage u
           ${have.apps ? `LEFT JOIN studio_apps s ON u.consumer_kind = 'app' AND s.id = u.consumer_id` : ''}
          WHERE u.automation_id = $1
          ORDER BY u.updated_at DESC`,
        [automationId],
    );
    return (rows || []).map(mapRow);
}

/**
 * How many buttons run each of these automations — the pill on a list, in one
 * GROUP BY instead of one read per row.
 * @returns {Promise<Map<string, number>>} automation id → count (0 for an
 *   automation that is nowhere in use)
 */
async function countUsageOfAutomations(automationIds) {
    await initDB();
    const ids = (Array.isArray(automationIds) ? automationIds : []).filter(Boolean);
    const out = new Map(ids.map(id => [id, 0]));
    if (!ids.length) return out;
    const rows = await getAll(
        `SELECT automation_id, COUNT(*)::int AS refs
           FROM automation_usage
          WHERE automation_id = ANY($1::text[])
          GROUP BY automation_id`,
        [ids],
    );
    for (const r of (rows || [])) out.set(r.automation_id, Number(r.refs) || 0);
    return out;
}

/**
 * The app is gone — remove its rows. There is no FK that does this.
 * @param {string} consumerKind
 */
async function purgeUsageForConsumer(consumerKind, consumerId) {
    await initDB();
    assertConsumerKind(consumerKind, 'purgeUsageForConsumer');
    if (!consumerId) return 0;
    const res = await run(
        `DELETE FROM automation_usage WHERE consumer_kind = $1 AND consumer_id = $2`,
        [consumerKind, consumerId],
    );
    // The marker goes too: an app that no longer exists is not
    // "indexed", it is not there. If the row stayed, a returned id (on an import with the
    // same id) would count as looked-at while it was never looked at.
    await run(
        `DELETE FROM automation_usage_indexed WHERE consumer_kind = $1 AND consumer_id = $2`,
        [consumerKind, consumerId],
    );
    return res?.rowCount || 0;
}

/**
 * The AUTOMATION is gone — remove its rows.
 *
 * The other side of the same missing FK. Without this a row stays that claims an app
 * operates something that no longer switches anything on, and that row would
 * block a next gate (a 409 on a deletion) on behalf of an automation that
 * no longer exists.
 */
async function purgeUsageOfAutomation(automationId) {
    await initDB();
    if (!automationId) return 0;
    const res = await run(`DELETE FROM automation_usage WHERE automation_id = $1`, [automationId]);
    return res?.rowCount || 0;
}

module.exports = {
    CONSUMER_KINDS,
    initDB,
    reconcileAutomationUsage,
    listUsageOfAutomation,
    countUsageOfAutomations,
    usageIndexCoverage,
    listUnindexedApps,
    purgeUsageForConsumer,
    purgeUsageOfAutomation,
};
