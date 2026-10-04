/**
 * Write the datatable dependents index for ONE automation, from every path that
 * saves a definition.
 *
 * Separate module because automation/datatableUsage.js is deliberately pure —
 * a definition in, a list out — and this half talks to the store.
 *
 * ── WHY EVERY SAVE PATH, NOT JUST THE OBVIOUS ONE ───────────────────
 * reconcileUsage is delete-then-insert keyed on automation_id, so a save path
 * that skips it does not merely fail to add rows: it leaves the PREVIOUS
 * definition's rows standing. Only `PUT /api/automation/:id` ever called it, so
 * an automation created, imported, restored from a version, saved as a reusable
 * Step or built by the MCP builder had an index that described some other
 * version of itself — and the "used by" panel, the node editor's "also used by
 * N other automations" and the destructive-change guard all read that index.
 *
 * Never throws. An index is not worth failing a save over; a wrong index is,
 * which is why the no-rows-written case is logged rather than swallowed.
 *
 * ── OTHER CONSUMERS ─────────────────────────────────────────────────
 * The same index now records App Studio table bindings and webpage blocks
 * (datatableStore.CONSUMER_KINDS). `syncUsageFor` / `purgeUsageFor` below are
 * the never-throws entry points for those: the caller collects its own
 * entries (it knows its definition; this module knows automations) and hands over
 * `{datatableId, stepId, mode, columns}` rows. The rule above applies to them
 * unchanged — EVERY path that saves an app or a webpage must call it, and
 * usageSync.savePaths.test.js is where those paths are listed.
 */

'use strict';

const { collectDatatableUsage } = require('./datatableUsage');
const log = require('../telemetry/log');

/**
 * The scope whose tables this automation may name.
 *
 * The automation's ORGANISATION when it has one. When it has none the automation
 * belongs to an org-less account, and the only tables it can reach are that
 * account's PERSONAL ones — so the owner is looked up rather than the index
 * being left empty. That costs one query, on the rare path, and only there:
 * every caller that already knows the org skips it entirely.
 */
async function scopeForAutomation(automationId, organizationId) {
    const datatableStore = require('../stores/datatableStore');
    if (organizationId) return datatableStore.orgScope(organizationId);
    const automationStore = require('../stores/automationStore');
    const a = await automationStore.getAutomation(automationId);
    return a?.userId ? datatableStore.userScope(a.userId) : null;
}

/**
 * @param {string} automationId
 * @param {string|null} organizationId  the automation's org — NOT the session's
 * @param {object} definition
 * @param {{label?: string}} [opts] log prefix, so the ops line names the path
 * @returns {Promise<number>} rows written, or -1 when the reconcile itself failed
 */
async function syncDatatableUsage(automationId, organizationId, definition, { label = 'automation', extraEntries = [] } = {}) {
    if (!automationId) return -1;
    try {
        const datatableStore = require('../stores/datatableStore');
        // `extraEntries` are usage rows the definition does not spell out as
        // steps — today the form-answers table a form trigger writes into.
        // They ride in HERE because the reconcile is delete-then-insert per
        // consumer: a second writer would erase the step rows.
        const entries = [...collectDatatableUsage(definition), ...(Array.isArray(extraEntries) ? extraEntries : [])];
        const scope = await scopeForAutomation(automationId, organizationId);
        if (!scope) {
            if (entries.length) {
                log.warn(`[${label}] ${automationId}: ${entries.length} datatable step(s) but no scope to index them under`);
            }
            return 0;
        }
        const written = await datatableStore.reconcileUsage(automationId, scope, entries);
        // The INSERT is guarded by `WHERE EXISTS (… scope_kind/scope_id)`, so a
        // caller with the wrong scope writes NOTHING and the save still
        // succeeds. That is how the "used by" list on every table ended up
        // empty on a green save; say so instead of counting it as done.
        if (entries.length && !written) {
            log.warn(`[${label}] ${automationId}: ${entries.length} datatable step(s) but no usage rows written — scope or table mismatch`);
        }
        return written;
    } catch (e) {
        log.warn(`[${label}] datatable usage reconcile failed:`, e.message);
        return -1;
    }
}

/**
 * Drop the index rows for an automation that is being deleted.
 *
 * automation_datatable_usage has an FK to `datatables` but none to
 * `automations`, so nothing reaps these on its own. Same never-throws rule: a
 * delete must not fail over its index.
 */
async function purgeDatatableUsage(automationId, { label = 'automation' } = {}) {
    if (!automationId) return 0;
    try {
        return await require('../stores/datatableStore').purgeUsageForAutomation(automationId);
    } catch (e) {
        log.warn(`[${label}] datatable usage purge failed:`, e.message);
        return 0;
    }
}

/**
 * Write the index for ONE consumer of any kind, from entries the caller has
 * already collected. Same contract as syncDatatableUsage: never throws, warns
 * when a non-empty list wrote nothing.
 *
 * @param {'automation'|'app'|'webpage'} consumerKind
 * @param {string} consumerId
 * @param {{kind:'org'|'user', id:string}|null} scope  the scope whose tables the consumer may name
 * @param {Array<{datatableId:string, stepId:string, mode?:'read'|'write'|'readwrite', columns?:string[]}>} entries
 * @param {{label?: string}} [opts] log prefix, so the ops line names the path
 * @returns {Promise<number>} rows written, or -1 when the reconcile itself failed
 */
async function syncUsageFor(consumerKind, consumerId, scope, entries, { label = consumerKind } = {}) {
    if (!consumerId) return -1;
    const list = Array.isArray(entries) ? entries : [];
    try {
        if (!scope) {
            if (list.length) {
                log.warn(`[${label}] ${consumerId}: ${list.length} datatable binding(s) but no scope to index them under`);
            }
            return 0;
        }
        const datatableStore = require('../stores/datatableStore');
        const written = await datatableStore.reconcileUsageFor(consumerKind, consumerId, scope, list);
        if (list.length && !written) {
            log.warn(`[${label}] ${consumerId}: ${list.length} datatable binding(s) but no usage rows written — scope or table mismatch`);
        }
        return written;
    } catch (e) {
        log.warn(`[${label}] datatable usage reconcile failed:`, e.message);
        return -1;
    }
}

/** Drop the index rows of a deleted consumer of any kind. Never throws. */
async function purgeUsageFor(consumerKind, consumerId, { label = consumerKind } = {}) {
    if (!consumerId) return 0;
    try {
        return await require('../stores/datatableStore').purgeUsageFor(consumerKind, consumerId);
    } catch (e) {
        log.warn(`[${label}] datatable usage purge failed:`, e.message);
        return 0;
    }
}

module.exports = { syncDatatableUsage, purgeDatatableUsage, syncUsageFor, purgeUsageFor };
