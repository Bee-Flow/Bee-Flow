/**
 * Create ONE Studio datatable for an owner, programmatically — the same
 * transaction the POST /api/datatables route and projects/packaging/install.js
 * perform (normalizeFields → createDatatable + quota + physical DDL →
 * invalidate), shared by the Playbook table phase and the automation builder's
 * `builder_create_datatable` tool so the two cannot drift.
 *
 * Scope: the owner's default create scope (the organisation when they have
 * one, else their account). An org table needs `manage_datatables`, which
 * the caller has checked and passes as `hasManageDatatables`.
 *
 * @param {{ ownerUserId:string, principal:object, name:string, key?:string, description?:string,
 *           fields:Array, hasManageDatatables?:boolean }} p
 * @returns {Promise<{ ok:true, table:{ id, key, name, scope, fields } } | { ok:false, code, error }>}
 */

'use strict';

const { keyFromTitle } = require('./sources/mirror/keys');

function defaultDeps() {
    return {
        db: require('../../db'),
        datatableStore: require('../../stores/datatableStore'),
        datatableDbStore: require('../../stores/datatableDbStore'),
        normalizeFields: require('./dataModel/datatableFields').normalizeFields,
        migrationPlan: require('./dataModel/migrationPlan').migrationPlan,
        ddlForTable: require('./dataModel/ddl').ddlForTable,
        assertDatatableQuota: require('./datatableLimits').assertDatatableQuota,
        datatableAccess: require('../../auth/datatableAccess'),
    };
}

async function createStudioDatatable({ ownerUserId, principal, name, key = null, description = '', fields, hasManageDatatables = false }, deps = defaultDeps()) {
    const { db, datatableStore, datatableDbStore, normalizeFields, migrationPlan, ddlForTable, assertDatatableQuota, datatableAccess } = deps;
    const title = String(name || '').trim();
    if (!title) return { ok: false, code: 'name_required', error: 'The table needs a name.' };
    const scope = datatableAccess.defaultCreateScope(principal);
    if (!scope) return { ok: false, code: 'no_scope', error: 'No organisation or account to create the table in.' };
    if (scope.kind === 'org' && !hasManageDatatables) {
        return { ok: false, code: 'manage_datatables_required', error: 'Creating an organisation table needs the manage_datatables permission.' };
    }
    const existing = await datatableStore.listDatatablesForScope(scope);
    const usedKeys = new Set((existing || []).map((t) => t && t.key).filter(Boolean));
    const wantedKey = typeof key === 'string' && /^[a-z][a-z0-9_]*$/.test(key) ? key : null;
    const finalKey = wantedKey && !usedKeys.has(wantedKey) ? wantedKey : keyFromTitle(wantedKey || title, 0, usedKeys);
    const norm = normalizeFields((Array.isArray(fields) ? fields : []).map((f) => ({ ...f })), []);
    if (!norm.ok) return { ok: false, code: 'schema_invalid', error: norm.error };
    if (!norm.fields.length) return { ok: false, code: 'schema_invalid', error: 'A table needs at least one column.' };
    const scopeKey = datatableDbStore.scopeKey(scope);
    let created;
    try {
        created = await db.withTransaction(async (client) => datatableStore.createDatatable({
            scope, ownerUserId,
            key: finalKey, name: title,
            description: String(description || '').trim() || `Tabel "${title}"`,
            projectId: null, rowScope: 'all',
            retentionDays: null, retentionField: 'created_at', subjectColumn: null,
            fields: norm.fields,
        }, {
            client,
            assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
            applyPhysical: async (c, { before, next, modelVersion }) => {
                const table = next.tables[next.tables.length - 1];
                const ensure = ddlForTable(table, { tableKeyById: new Map((next.tables || []).map((x) => [x.id, x.key])), dialect: 'pg', rowScope: 'all' });
                const plan = migrationPlan(before, next, { dialect: 'pg', onlyTableIds: [table.id] });
                await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan], { client: c, targetVersion: modelVersion });
            },
        }));
    } catch (err) {
        try { datatableDbStore.invalidate(scopeKey); } catch { /* best effort */ }
        const taken = /uq_datatables_scope_key|already exists|duplicate key/i.test(String(err && err.message));
        return { ok: false, code: taken ? 'key_taken' : 'create_failed', error: err && err.message ? err.message : String(err) };
    }
    datatableDbStore.invalidate(scopeKey);
    return {
        ok: true,
        table: {
            id: created.id,
            key: created.key || finalKey,
            name: created.name || title,
            scope: { kind: scope.kind, id: scope.id },
            fields: norm.fields.map((f) => ({ key: f.key, name: f.name, type: f.type, ...(f.options ? { options: f.options } : {}) })),
        },
    };
}

module.exports = { createStudioDatatable };
