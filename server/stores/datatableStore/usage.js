// @typecheck
'use strict';

/**
 * The dependents index: which CONSUMER touches which table.
 *
 * `automation_datatable_usage` was built for routines and is now the index for
 * every kind of consumer — `consumer_kind` says which, and `automation_id` is
 * the generic consumer id. The column keeps its old name on purpose; the
 * header of stores/datatableStore.js explains at length why neither the table
 * nor its primary key is renamed under a rolling deploy.
 *
 * Three surfaces read what is written here (the used-by panel, the "also used
 * by N others" hint, and the guard that refuses a column drop), which is why
 * reconciliation is delete-then-insert on every save of a consumer's
 * definition rather than a scan at read time, and why every DELETE is keyed on
 * the kind as well as the id.
 */

const { run, getOne, getAll, withTransaction } = require('../../db');
const { assertScope } = require('./scope');
const { initDB } = require('./schema');
const { parseJSONObject } = require('../lib/json');

/**
 * What can consume a table, as recorded in the dependents index. The value is
 * the `consumer_kind` column; the id column beside it is `automation_id` for
 * every kind (see the header). Adding a kind means adding its reconciler on
 * every save path of that consumer — automation/usageSync.savePaths.test.js
 * keeps that list.
 */
const CONSUMER_KINDS = Object.freeze(['automation', 'app', 'webpage', 'kb']);

/** The three ways a consumer may touch a table. */
const USAGE_MODES = Object.freeze(['read', 'write', 'readwrite']);

function assertConsumerKind(kind, who) {
    if (!CONSUMER_KINDS.includes(kind)) {
        throw new Error(`${who} requires a consumerKind of ${CONSUMER_KINDS.join(' | ')}, got ${JSON.stringify(kind)}`);
    }
    return kind;
}

/** 'read' | 'write' | 'readwrite'; anything else is the safe default, a read. */
function normalizeMode(mode) {
    return USAGE_MODES.includes(mode) ? mode : 'read';
}

/**
 * Reconcile which parts of ONE consumer touch which tables.
 *
 * Delete-then-insert for that `(consumer_kind, consumer id)`, called on every
 * save of the consumer's definition. It is not derived by scanning definitions
 * at read time, because getAutomationsForUser is `WHERE user_id = $1` — nobody
 * can read a colleague's routines to build the index, so it has to be written
 * as they save. Same for apps and webpages.
 *
 * The DELETE is keyed on BOTH columns. Ids of the three kinds never collide in
 * practice (all UUIDs), but "in practice" is not a reason to let an app's save
 * be able to erase a routine's rows.
 *
 * @param {'automation'|'app'|'webpage'} consumerKind
 * @param {string} consumerId  the automation, studio_apps or webpages id
 * @param {{kind:'org'|'user', id:string}|Array<{kind:'org'|'user', id:string}>} scope
 *   the scope — or the scopes — whose tables the consumer may name. A LIST is
 *   for a consumer that can legitimately reach both at once: a webpage owned by
 *   an org member binds its organisation's tables AND that member's personal
 *   ones, and one scope would silently index only half of them. The row's own
 *   scope is then read off the `datatables` row rather than assumed from the
 *   caller, so a single DELETE + one INSERT per entry still covers every scope
 *   in one transaction. A single scope behaves exactly as before.
 * @param {Array<{datatableId:string, stepId:string, mode?:'read'|'write'|'readwrite', columns?:string[]}>} entries
 *   `stepId` is the part of the consumer that touches the table: a routine
 *   step id, an app table id, a webpage block id. Unique within the consumer.
 * @returns {Promise<number>} rows actually written — NOT how many were offered.
 *   The INSERT is guarded on the table existing in `scope`, so a caller with the
 *   wrong scope writes nothing and the whole save still succeeds. The caller is
 *   expected to notice a non-empty list that wrote zero rows.
 */
async function reconcileUsageFor(consumerKind, consumerId, scope, entries) {
    await initDB();
    assertConsumerKind(consumerKind, 'reconcileUsageFor');
    if (!consumerId) throw new Error('reconcileUsageFor requires a consumerId');
    const scopes = Array.isArray(scope) ? scope : [scope];
    if (!scopes.length) throw new Error('reconcileUsageFor requires at least one scope');
    for (const s of scopes) assertScope(s, 'reconcileUsageFor');
    // Twee parallelle arrays in plaats van een samengestelde sleutel: `=` op
    // twee kolommen matcht een NULL scope_id net zo min als de oude
    // `scope_kind = $1 AND scope_id = $2` deed, en een string-concat zou een
    // half-gemigreerde rij (scope_id NULL) stilletjes anders behandelen.
    const scopeKinds = scopes.map(s => s.kind);
    const scopeIds = scopes.map(s => s.id);
    const rows = (Array.isArray(entries) ? entries : []).filter(e => e && e.datatableId && e.stepId);
    return withTransaction(async (client) => {
        await client.query(
            `DELETE FROM automation_datatable_usage WHERE automation_id = $1 AND consumer_kind = $2`,
            [consumerId, consumerKind],
        );
        let written = 0;
        for (const e of rows) {
            // A step may name a table that was since deleted; the FK would
            // reject it. Skip rather than fail the whole save — the validator
            // already warns the author about an unknown table.
            //
            // `scope_kind` / `scope_id` / `organization_id` are read OFF the
            // table's own row instead of copied from the caller. For a single
            // scope that is the same value by construction (the row only
            // matches when it is in that scope); for several it is the only way
            // a row can say which one it really lives in.
            const r = await client.query(
                `INSERT INTO automation_datatable_usage
                    (scope_kind, scope_id, organization_id, datatable_id, automation_id, step_id, mode, columns, consumer_kind)
                 SELECT d.scope_kind, d.scope_id,
                        CASE WHEN d.scope_kind = 'org' THEN d.scope_id ELSE NULL END,
                        d.id, $1, $2, $3, $4::jsonb, $5
                   FROM datatables d
                  WHERE d.id = $6
                    AND EXISTS (
                        SELECT 1 FROM unnest($7::text[], $8::text[]) AS s(kind, sid)
                         WHERE s.kind = d.scope_kind AND s.sid = d.scope_id)
                 ON CONFLICT (automation_id, step_id)
                 DO UPDATE SET datatable_id = EXCLUDED.datatable_id, mode = EXCLUDED.mode,
                               columns = EXCLUDED.columns, consumer_kind = EXCLUDED.consumer_kind,
                               scope_kind = EXCLUDED.scope_kind, scope_id = EXCLUDED.scope_id,
                               organization_id = EXCLUDED.organization_id,
                               updated_at = NOW()`,
                [consumerId, e.stepId, normalizeMode(e.mode), JSON.stringify(e.columns || []),
                    consumerKind, e.datatableId, scopeKinds, scopeIds],
            );
            written += r?.rowCount || 0;
        }
        return written;
    });
}

/**
 * Reconcile which steps of ONE routine touch which tables — the original
 * entry point, kept so every routine save path is unchanged. It IS
 * reconcileUsageFor('automation', …); nothing else.
 */
async function reconcileUsage(automationId, scope, entries) {
    if (!automationId) throw new Error('reconcileUsage requires an automationId');
    return reconcileUsageFor('automation', automationId, scope, entries);
}

/**
 * The consumer tables listUsage may LEFT JOIN, probed once.
 *
 * `automations` always exists (its store is registered ahead of this one in
 * migrateDb). `studio_apps` and `webpages` belong to stores that create their
 * DDL on FIRST USE, so on a fresh install one of them can be absent until
 * somebody opens that feature — and a JOIN to a missing relation is a 500 on
 * the "used by" tab and, worse, on the `DELETE /:id` in-use guard. Probed with
 * to_regclass and remembered once both are there; re-probed (one cheap query)
 * until then. An absent kind's consumers come back with a null title.
 */
let joinableConsumerTables = null;
async function consumerJoins() {
    if (joinableConsumerTables) return joinableConsumerTables;
    const r = await getOne(
        `SELECT (to_regclass('studio_apps') IS NOT NULL) AS apps,
                (to_regclass('webpages') IS NOT NULL) AS pages,
                (to_regclass('knowledge_bases') IS NOT NULL) AS kbs`,
    );
    const have = { apps: !!r?.apps, pages: !!r?.pages, kbs: !!r?.kbs };
    if (have.apps && have.pages && have.kbs) joinableConsumerTables = have;
    return have;
}

/**
 * Who uses this table — every consumer kind, one query.
 *
 * Per row: the consumer's kind, id, title and owner (joined per kind), the
 * part of it that touches the table, and for a routine step its position and
 * type read from the routine's stored definition plus the routine's last run.
 * No per-row lookups: the definition rides the JOIN and is walked once per
 * routine, and `automations.last_run_at` is what the runner stamps at the end
 * of every live run.
 *
 * The `automationId` / `automationTitle` / `automationOwner` names are kept as
 * aliases of `consumerId` / `consumerTitle` / `consumerOwner` for EVERY kind:
 * the Studio's used-by panel, the column-drop and delete refusals all read
 * them, and a client that has not learned `consumerKind` yet still shows the
 * right name. New code reads the `consumer*` fields and switches on the kind.
 *
 * @returns {Promise<Array<{
 *   consumerKind:'automation'|'app'|'webpage'|'kb', consumerId:string,
 *   consumerTitle:string|null, consumerOwner:string|null,
 *   automationId:string, automationTitle:string|null, automationOwner:string|null,
 *   stepId:string, stepOrdinal:number|null, stepType:string|null, stepOp:string|null,
 *   mode:'read'|'write'|'readwrite', columns:string[],
 *   lastRunAt:string|null, updatedAt:*
 * }>>}
 */
async function listUsage(datatableId) {
    await initDB();
    const have = await consumerJoins();
    const res = await getAll(
        `SELECT u.*,
                a.title AS automation_title, a.user_id AS automation_owner,
                a.definition_json AS automation_definition, a.last_run_at AS automation_last_run_at
                ${have.apps ? `, s.name AS app_title, s.user_id AS app_owner` : ''}
                ${have.pages ? `, w.name AS webpage_title, w.user_id AS webpage_owner` : ''}
                ${have.kbs ? `, k.name AS kb_title, k.tenant_id AS kb_owner` : ''}
           FROM automation_datatable_usage u
           LEFT JOIN automations a ON u.consumer_kind = 'automation' AND a.id = u.automation_id
           ${have.apps ? `LEFT JOIN studio_apps s ON u.consumer_kind = 'app' AND s.id = u.automation_id` : ''}
           ${have.pages ? `LEFT JOIN webpages w ON u.consumer_kind = 'webpage' AND w.id = u.automation_id` : ''}
           ${have.kbs ? `LEFT JOIN knowledge_bases k ON u.consumer_kind = 'kb' AND k.id::text = u.automation_id` : ''}
          WHERE u.datatable_id = $1
          ORDER BY u.updated_at DESC`,
        [datatableId],
    );
    // Walked once per routine, not once per row: a routine with four datatable
    // steps rides the JOIN four times but is only parsed once.
    const positionsByAutomation = new Map();
    const positionsFor = (automationId, definition) => {
        if (!positionsByAutomation.has(automationId)) {
            const { stepPositions } = require('../../automation/datatableUsage');
            positionsByAutomation.set(automationId, stepPositions(parseJSONObject(definition, null)));
        }
        return positionsByAutomation.get(automationId);
    };
    return (res || []).map(r => {
        const kind = CONSUMER_KINDS.includes(r.consumer_kind) ? r.consumer_kind : 'automation';
        const isAutomation = kind === 'automation';
        const title = isAutomation ? r.automation_title
            : kind === 'app' ? r.app_title
                : kind === 'kb' ? r.kb_title
                    : r.webpage_title;
        const owner = isAutomation ? r.automation_owner
            : kind === 'app' ? r.app_owner
                : kind === 'kb' ? r.kb_owner
                    : r.webpage_owner;
        const pos = isAutomation && r.automation_definition
            ? positionsFor(r.automation_id, r.automation_definition).get(r.step_id) || null
            : null;
        const lastRunAt = isAutomation && r.automation_last_run_at
            ? new Date(r.automation_last_run_at).toISOString()
            : null;
        return {
            consumerKind: kind,
            consumerId: r.automation_id,
            consumerTitle: title || null,
            consumerOwner: owner || null,
            automationId: r.automation_id,
            automationTitle: title || null,
            automationOwner: owner || null,
            stepId: r.step_id,
            stepOrdinal: pos ? pos.ordinal : null,
            stepType: pos ? pos.type : null,
            stepOp: pos ? pos.op : null,
            mode: r.mode,
            columns: parseJSONObject(r.columns, []),
            lastRunAt,
            updatedAt: r.updated_at,
        };
    });
}

/**
 * How many DISTINCT consumers use each of many tables — the "2 automations"
 * pill on the list, in one GROUP BY rather than one listUsage per row.
 * @returns {Promise<Map<string, number>>} datatableId → consumer count (0 for a table nobody uses)
 */
async function listUsageCounts(datatableIds) {
    await initDB();
    const ids = (Array.isArray(datatableIds) ? datatableIds : []).filter(Boolean);
    const out = new Map(ids.map(id => [id, 0]));
    if (!ids.length) return out;
    const res = await getAll(
        `SELECT datatable_id, COUNT(DISTINCT (consumer_kind, automation_id))::int AS consumers
           FROM automation_datatable_usage
          WHERE datatable_id = ANY($1::text[])
          GROUP BY datatable_id`,
        [ids],
    );
    for (const r of (res || [])) out.set(r.datatable_id, Number(r.consumers) || 0);
    return out;
}

/** Steps that name a given column — the destructive-change guard. */
async function listUsageForColumn(datatableId, columnKey) {
    const all = await listUsage(datatableId);
    return all.filter(u => Array.isArray(u.columns) && u.columns.includes(columnKey));
}

/**
 * Drop the index rows for a consumer that no longer exists.
 *
 * The FK to `datatables` cascades, but there is none to `automations`,
 * `studio_apps` or `webpages` — those tables belong to other stores — so a
 * deleted consumer leaves its rows behind forever. listUsage LEFT JOINs, so
 * they come back with a null title and the "used by" panel tells an owner that
 * something they cannot see writes to their table. Called from every delete
 * path of every consumer kind.
 */
async function purgeUsageForAutomation(automationId) {
    if (!automationId) return 0;
    return purgeUsageFor('automation', automationId);
}

/** The generic form of purgeUsageForAutomation, keyed on the kind as well as the id. */
async function purgeUsageFor(consumerKind, consumerId) {
    await initDB();
    assertConsumerKind(consumerKind, 'purgeUsageFor');
    if (!consumerId) return 0;
    const res = await run(
        `DELETE FROM automation_datatable_usage WHERE automation_id = $1 AND consumer_kind = $2`,
        [consumerId, consumerKind],
    );
    return res?.rowCount || 0;
}

module.exports = {
    CONSUMER_KINDS,
    USAGE_MODES,
    reconcileUsageFor,
    reconcileUsage,
    listUsage,
    listUsageCounts,
    listUsageForColumn,
    purgeUsageFor,
    purgeUsageForAutomation,
};
