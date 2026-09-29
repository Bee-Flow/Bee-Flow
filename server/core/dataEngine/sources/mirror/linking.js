/**
 * MAKING mirrors — the part of linking that is the same for every source.
 *
 * ── ALL TABLES FIRST, THEN ALL COLUMNS ──────────────────────────────
 * A relation column points at another table. When two tables are linked in
 * one call and one points at the other, the columns of the first can only
 * resolve that pointer once the second EXISTS as a mirror — so every table
 * is created (empty, `fields: []`) before any table's columns are derived.
 * A table that fails to create is reported and skipped; the ones that
 * succeeded are each individually consistent.
 *
 * The first refresh is KICKED, not awaited: a 10 000-row source takes twenty
 * pages, and the dialog is better served by an answer that says "being
 * filled in" than by a spinner that outlives the request. Targets go before
 * the mirrors that point at them, so a match relation finds its rows.
 *
 * What is the adapter's: validating the request, building each plan's
 * `source` block, reading the source's columns, deriving the fields. This
 * file only knows datatables.
 */

'use strict';

const db = require('../../../../db');
const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const { ddlForTable } = require('../../dataModel/ddl');
const { assertDatatableQuota } = require('../../datatableLimits');
const { reconcileMirrorSchema } = require('./schema');
const log = require('../../../../telemetry/log');

/**
 * Create every planned mirror, EMPTY, in its own transaction.
 *
 * @param {object} args
 * @param {{kind,id}} args.scope
 * @param {object} args.principal            { userId }
 * @param {string} args.KIND                 the managed kind
 * @param {Array}  args.plans                [{ key, name, description, … }]
 * @param {(plan:object) => object} args.sourceFor   the `source` block for a plan
 * @returns {Promise<{ created: Array<{plan, table}>, partial: boolean, warnings: string[] }>}
 *   throws when the FIRST table fails (nothing made yet: the route answers the error itself)
 */
async function createEmptyMirrors({ scope, principal, KIND, plans, sourceFor }) {
    const created = [];
    const warnings = [];
    let partial = false;
    const scopeKey = datatableDbStore.scopeKey(scope);
    for (const p of plans) {
        const source = sourceFor(p);
        try {
            const table = await db.withTransaction(async (client) => (
                datatableStore.createDatatable({
                    scope, ownerUserId: principal.userId,
                    key: p.key, name: p.name, description: p.description,
                    fields: [], managedKind: KIND, source,
                    retentionDays: null,
                }, {
                    client,
                    assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
                    applyPhysical: async (c, { next, modelVersion }) => {
                        const t = next.tables[next.tables.length - 1];
                        const ensure = ddlForTable(t, { dialect: 'pg', rowScope: 'all' });
                        await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure], { client: c, targetVersion: modelVersion });
                    },
                })
            ));
            datatableDbStore.invalidate(scopeKey);
            created.push({ plan: p, table });
        } catch (e) {
            datatableDbStore.invalidate(scopeKey);
            if (!created.length) throw e;
            partial = true;
            warnings.push(`"${p.name}" could not be linked: ${e && e.message}`);
        }
    }
    return { created, partial, warnings };
}

/**
 * Derive and store every created mirror's columns. `deriveFor(plan, table)`
 * answers `{ fields, columnMap, relations, warnings }` or null when the
 * columns could not be read (the table stays empty; the sync will try again).
 *
 * @returns {Promise<{ tables: Array, partial: boolean, warnings: string[] }>}
 */
async function storeDerived(scope, created, deriveFor) {
    const tables = [];
    const warnings = [];
    let partial = false;
    for (const { plan, table } of created) {
        let derived = null;
        try {
            derived = await deriveFor(plan, table);
        } catch (e) {
            partial = true;
            warnings.push(`"${plan.name}" was linked but its columns could not be read: ${e && e.message}`);
        }
        if (!derived) { tables.push(table); continue; }
        try {
            warnings.push(...(derived.warnings || []).map(w => `${plan.name}: ${w}`));
            await reconcileMirrorSchema(scope, table, derived.fields, { retyped: [] });
            const withSource = await datatableStore.setSource(table.id, scope, {
                ...table.source, columnMap: derived.columnMap, relations: derived.relations,
            });
            tables.push(withSource || table);
        } catch (e) {
            partial = true;
            warnings.push(`"${plan.name}" was linked but its columns could not be stored: ${e && e.message}`);
            tables.push(table);
        }
    }
    return { tables, partial, warnings };
}

/** Mirrors whose relations point at other mirrors in the list go AFTER them. */
function orderParentsFirst(tables) {
    const ids = new Set(tables.map(t => t.id));
    const placed = new Set();
    const out = [];
    let progress = true;
    while (out.length < tables.length && progress) {
        progress = false;
        for (const t of tables) {
            if (placed.has(t.id)) continue;
            const deps = ((t.source && t.source.relations) || [])
                .map(r => r.targetDatatableId).filter(id => ids.has(id) && id !== t.id);
            if (deps.every(id => placed.has(id))) { placed.add(t.id); out.push(t); progress = true; }
        }
    }
    for (const t of tables) if (!placed.has(t.id)) out.push(t);   // a cycle: any order
    return out;
}

/**
 * Kick the first refresh of every table, targets before the mirrors that
 * point at them, and answer the tables as they now stand.
 */
async function kickFirstSyncs(scope, tables, syncRows, TAG) {
    for (const table of orderParentsFirst(tables)) {
        const fresh = await datatableStore.getDatatable(table.id, scope);
        if (fresh) {
            setImmediate(() => {
                syncRows(fresh, { reason: 'link' })
                    .catch(e => log.warn(`${TAG} first refresh of ${fresh.id} failed: ${e && e.message}`));
            });
        }
    }
    const finals = [];
    for (const t of tables) finals.push(await datatableStore.getDatatable(t.id, scope) || t);
    return finals;
}

/**
 * Replace a mirror's DECLARED (match) relations. The source's own relations
 * are derived and ride along untouched; the next refresh recomputes
 * everything. A target may be a mirror of another kind — `siblingsOf` lists
 * every mirror in the scope — but never one in another scope.
 *
 * @param {object} datatable
 * @param {Array} relations  [{ targetDatatableId, localFieldId, targetFieldId }]
 * @param {object} deps
 * @param {(scope) => Promise<{byId:Map}>} deps.siblingsOf
 * @param {(targetId, localFieldId, targetFieldId) => string} deps.matchFieldIdFor
 * @param {Function} deps.Err            the kind's SourceError class
 * @param {string} deps.rejectedCode     the kind's "did not accept this" code
 */
async function setRelations(datatable, relations, { siblingsOf, matchFieldIdFor, Err, rejectedCode }) {
    const scope = datatable.scope;
    const siblings = await siblingsOf(scope);
    const meta = await datatableStore.getTableMeta(scope, datatable.id);
    const localIds = new Set(((meta && meta.fields) || []).filter(f => f && !f.derived).map(f => f.id));
    const clean = [];
    for (const r of Array.isArray(relations) ? relations : []) {
        if (!r || typeof r.targetDatatableId !== 'string' || typeof r.localFieldId !== 'string' || typeof r.targetFieldId !== 'string') {
            throw new Err(400, rejectedCode, 'Each relation names a target table, a local column and a target column.');
        }
        const target = siblings.byId.get(r.targetDatatableId);
        if (!target) throw new Err(400, 'relation_cross_scope', 'A relation can only point at a linked table in the same workspace.');
        if (!localIds.has(r.localFieldId)) throw new Err(400, rejectedCode, 'That local column is not one of this table\'s own columns.');
        const targetMeta = await datatableStore.getTableMeta(scope, target.id);
        const tf = ((targetMeta && targetMeta.fields) || []).find(f => f && f.id === r.targetFieldId && !f.derived);
        if (!tf) throw new Err(400, rejectedCode, 'That column is not one of the target table\'s own columns.');
        if (!['text', 'number', 'select', 'richtext'].includes(tf.type)) {
            throw new Err(400, rejectedCode, `Rows can be matched on a text, number or list column — "${tf.name}" is ${tf.type}.`);
        }
        clean.push({ kind: 'match', fieldId: matchFieldIdFor(target.id, r.localFieldId, r.targetFieldId),
            targetDatatableId: target.id, localFieldId: r.localFieldId, targetFieldId: r.targetFieldId });
    }
    const kept = ((datatable.source && datatable.source.relations) || []).filter(r => r && r.kind !== 'match');
    const updated = await datatableStore.setSource(datatable.id, scope, {
        ...datatable.source, relations: [...kept, ...clean],
    });
    await datatableStore.markSourceStale(datatable.id, 'relations');
    return updated;
}

module.exports = { createEmptyMirrors, storeDerived, orderParentsFirst, kickFirstSyncs, setRelations };
