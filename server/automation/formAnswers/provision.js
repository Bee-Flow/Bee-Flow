/**
 * FORM ANSWERS — provisioning: the datatable that follows a form.
 *
 * Called on EVERY save of a routine (routes/automation/crud.js, right after
 * ensureFormPages) and never allowed to fail that save: a table that could
 * not be made is reported back (`answers.error`) and tried again on the next
 * save or on the explicit "make the table" route.
 *
 * ── ONE TABLE PER ROUTINE, FOUND BY LOOKUP ──────────────────────────
 * The definition says only WHETHER to collect (`trigger.form.collect`); the
 * table says WHOSE answers it holds (`source.automationId`). So the table is
 * found by lookup on every save, never remembered in the definition — a
 * duplicated routine gets a fresh table, and turning collection off and on
 * again re-adopts the table the routine already had (`linked` flips, the
 * rows stay). Nothing here ever deletes a row or drops a column: a question
 * that is gone is RETIRED, and the owner drops its column by hand
 * (deleteRetiredColumn), on purpose, from the table.
 *
 * ── SCOPE AND OWNER ────────────────────────────────────────────────
 * The routine's organisation, else the owner's personal scope; the owner is
 * the routine's owner. That is who the form runs as, so it is who the
 * answers belong to — Bee Flow's grant ladder on the table then decides who
 * else may read them.
 */

'use strict';

const db = require('../../db');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
const { reconcileMirrorSchema } = require('../../core/dataEngine/sources/mirror/schema');
const { keyFromTitle } = require('../../core/dataEngine/sources/mirror/keys');
const { managedKindSpec } = require('../../core/dataEngine/dataModel/managedTables');
const derive = require('./derive');
const log = require('../../telemetry/log');

const KIND = derive.KIND;
const TAG = '[form answers]';

/** The datatable scope a routine's tables live in. */
function scopeForAutomation(automation) {
    if (!automation) return null;
    if (automation.organizationId) return datatableStore.orgScope(automation.organizationId);
    return automation.userId ? datatableStore.userScope(automation.userId) : null;
}

function sameScope(table, scope) {
    const id = table && table.scope ? table.scope.id : (table && table.scope_id);
    return !!table && !!scope && (table.scopeKind || (table.scope && table.scope.kind)) === scope.kind && String(id) === String(scope.id);
}

/**
 * The routine's answers table in this scope: the linked one, else the newest
 * one that once was. Null when the routine never collected.
 */
async function tableFor(automationId, scope) {
    if (!automationId || !scope) return null;
    const all = (await datatableStore.listAnswersTablesForAutomation(automationId))
        .filter(t => t.source && t.source.automationId === String(automationId) && sameScope(t, scope));
    if (!all.length) return null;
    return all.find(t => t.source.linked !== false) || all[all.length - 1];
}

function titleOf(automation, definition) {
    const form = definition?.trigger?.form;
    const t = (typeof form?.title === 'string' && form.title.trim()) || (typeof automation?.title === 'string' && automation.title.trim()) || 'form';
    return t.slice(0, 100);
}

/** The key of the first e-mail question — the natural data-subject column. */
function subjectColumnOf(columnMap) {
    const entry = Object.values(columnMap).find(c => c && !c.retired && c.formType === 'email');
    return entry ? entry.key : null;
}

async function createTable(automation, definition, scope, derived, now) {
    const spec = managedKindSpec(KIND);
    const title = titleOf(automation, definition);
    const used = new Set((await datatableStore.listDatatablesForScope(scope)).map(t => t.key));
    const key = keyFromTitle(`${title} answers`, 1, used);
    const norm = normalizeFields(derived.fields, []);
    if (!norm.ok) throw new Error(norm.error);
    const source = {
        kind: KIND,
        automationId: String(automation.id),
        triggerStepId: null,
        linked: true,
        linkedAt: now,
        linkedByUserId: automation.userId || null,
        fingerprint: derived.fingerprint,
        columnMap: derived.columnMap,
        lastWriteError: null,
        reconciledAt: now,
    };
    const scopeKey = datatableDbStore.scopeKey(scope);
    try {
        const table = await db.withTransaction(async (client) => (
            datatableStore.createDatatable({
                scope,
                ownerUserId: automation.userId,
                key,
                name: `Answers — ${title}`,
                description: `${spec.defaultDescription} Collected by the form "${title}".`,
                subjectColumn: subjectColumnOf(derived.columnMap),
                fields: norm.fields,
                managedKind: KIND,
                source,
                retentionDays: null,
                retentionField: spec.retentionField,
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
        return table;
    } finally {
        datatableDbStore.invalidate(scopeKey);
    }
}

/**
 * Make the routine's answers table match its form. Returns
 *   `{ table, created, changed, warnings }` — or `null` when the routine does
 *   not collect (any table it had is unlinked, kept), or `{ table: null,
 *   error: { code, message } }` when the table could not be made.
 */
async function ensureAnswersTable(automation, definition, { scope = null } = {}) {
    const sc = scope || scopeForAutomation(automation);
    if (!automation || !sc) return null;
    // Not a form at all: nothing to make and nothing to unlink — the common
    // case for every routine save, and it must cost no query.
    if (!definition || definition.trigger?.kind !== 'form') return null;
    const now = new Date().toISOString();
    let existing = null;
    try {
        existing = await tableFor(automation.id, sc);
    } catch (e) {
        log.warn(`${TAG} lookup failed for ${automation.id}: ${e.message}`);
        return { table: null, error: { code: 'lookup_failed', message: e.message } };
    }

    if (!derive.collectEnabled(definition)) {
        if (existing && existing.source.linked !== false) {
            try {
                await datatableStore.setDefinitionSource(existing.id, sc, { ...existing.source, linked: false, unlinkedAt: now });
            } catch (e) {
                log.warn(`${TAG} unlink failed for ${existing.id}: ${e.message}`);
            }
        }
        return null;
    }

    try {
        if (!existing) {
            const derived = derive.deriveAnswerColumns(definition, null);
            const table = await createTable(automation, definition, sc, derived, now);
            return { table, created: true, changed: true, warnings: derived.warnings };
        }
        const derived = derive.deriveAnswerColumns(definition, existing.source.columnMap || {}, { now });
        const unchanged = derived.fingerprint === existing.source.fingerprint && existing.source.linked !== false;
        if (unchanged) return { table: existing, created: false, changed: false, warnings: derived.warnings };
        // Additive only: derive never shortens the list, so the plan is ADDs
        // (a retype is a new column beside the retired one).
        await reconcileMirrorSchema(sc, existing, derived.fields, { retyped: [] });
        const table = await datatableStore.setDefinitionSource(existing.id, sc, {
            ...existing.source,
            linked: true,
            linkedAt: existing.source.linkedAt || now,
            columnMap: derived.columnMap,
            fingerprint: derived.fingerprint,
            reconciledAt: now,
            unlinkedAt: null,
        });
        return { table, created: false, changed: true, warnings: derived.warnings };
    } catch (e) {
        log.warn(`${TAG} could not provision the answers table for ${automation.id}: ${e.message}`);
        return { table: null, error: { code: e.code || (e.status === 409 ? 'quota_exceeded' : 'provision_failed'), message: e.message } };
    }
}

/**
 * Turn every answers table of a routine that is being deleted into an
 * ordinary table: rows, columns and sharing stay, the contract goes.
 */
async function releaseAnswersTables(automation) {
    const sc = scopeForAutomation(automation);
    if (!automation || !sc) return [];
    const released = [];
    let all = [];
    try {
        all = (await datatableStore.listAnswersTablesForAutomation(automation.id)).filter(t => sameScope(t, sc));
    } catch (e) {
        log.warn(`${TAG} release lookup failed for ${automation.id}: ${e.message}`);
        return released;
    }
    for (const t of all) {
        try {
            await datatableStore.releaseDefinitionSource(t.id, sc);
            released.push(t.id);
        } catch (e) {
            log.warn(`${TAG} release failed for ${t.id}: ${e.message}`);
        }
    }
    return released;
}

/** The owner's own "keep the answers, forget the form" on one table. */
async function releaseAnswersTable(table, scope) {
    return datatableStore.releaseDefinitionSource(table.id, scope);
}

/**
 * Drop the column of a question that is NO LONGER on the form. The only
 * DROP this feature ever runs, and only by the owner's hand. Throws
 * `{ status: 409, code: 'column_live' }` for a column the form still asks.
 */
async function deleteRetiredColumn(table, scope, fieldId) {
    const source = table.source || {};
    const entry = source.columnMap && source.columnMap[fieldId];
    if (!entry) {
        const e = new Error('No such column'); e.status = 404; e.code = 'unknown_field'; throw e;
    }
    if (!entry.retired) {
        const e = new Error('That column is a question the form still asks — remove the question from the form first');
        e.status = 409; e.code = 'column_live'; throw e;
    }
    const meta = await datatableStore.getTableMeta(scope, table.id);
    const nextFields = (meta.fields || []).filter(f => f.id !== fieldId);
    const { modelVersion } = await reconcileMirrorSchema(scope, table, nextFields, { retyped: [] });
    const columnMap = { ...source.columnMap };
    delete columnMap[fieldId];
    const saved = await datatableStore.setDefinitionSource(table.id, scope, {
        ...source, columnMap, fingerprint: derive.fingerprintOf(columnMap), reconciledAt: new Date().toISOString(),
    });
    return { table: saved, fields: nextFields, modelVersion };
}

module.exports = {
    KIND,
    scopeForAutomation,
    tableFor,
    ensureAnswersTable,
    releaseAnswersTables,
    releaseAnswersTable,
    deleteRetiredColumn,
};
