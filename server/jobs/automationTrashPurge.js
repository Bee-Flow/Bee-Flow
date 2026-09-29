/**
 * Automation trash purge (Studio → Automations handoff 5).
 *
 * DELETE /api/automation/:id moves a routine into the trash
 * (routes/automation/trash.js). This pass removes routines that have been in
 * the trash for TRASH_RETENTION_DAYS (30), and does the cleanup the old
 * hard delete did inline:
 *
 *   - a form routine's answers tables are RELEASED, never deleted — what
 *     people answered outlives the form (automation/formAnswers);
 *   - the datatable "used by" index and the app-button usage index are
 *     purged — neither has an FK to automations, so nothing else reaps them.
 *
 * Runs go with the routine: automation_runs (and its step rows, full outputs,
 * token vault) cascade from automations. They are kept for as long as the
 * routine sits in the trash, which is what "runs are kept" promises; keeping
 * them past the purge would need the runs' FK to stop cascading.
 *
 * Remote event subscriptions were revoked when the routine was trashed.
 *
 * Rides the hourly run-retention tick (core/automationRunner/scheduler/
 * ticks.js), under its advisory lock. Every step is best-effort per routine:
 * one routine that cannot be cleaned must not stop the others.
 */

'use strict';

const log = require('../telemetry/log');

const BATCH = 100;

function defaultDeps() {
    return {
        store: require('../stores/automationStore'),
        releaseAnswersTables: (a) => require('../automation/formAnswers').releaseAnswersTables(a),
        purgeDatatableUsage: (id) => require('../automation/datatableUsageSync').purgeDatatableUsage(id, { label: 'automation trash purge' }),
        purgeAppUsage: (id) => require('../stores/automationUsageStore').purgeUsageOfAutomation(id),
    };
}

async function purgeTrashPass(deps = defaultDeps()) {
    const { store } = deps;
    const due = await store.listPurgeableTrash({ limit: BATCH });
    let purged = 0;
    for (const row of due) {
        try {
            const a = await store.getAutomation(row.id, { includeDeleted: true });
            if (!a || !a.deletedAt) continue;   // restored meanwhile
            try { await deps.releaseAnswersTables(a); }
            catch (e) { log.warn(`[trashPurge] answers tables of ${row.id} not released: ${e.message}`); continue; }
            const ok = await store.purgeTrashedAutomation(row.id);
            if (!ok) continue;
            purged += 1;
            try { await deps.purgeDatatableUsage(row.id); }
            catch (e) { log.warn(`[trashPurge] datatable usage purge failed for ${row.id}: ${e.message}`); }
            try { await deps.purgeAppUsage(row.id); }
            catch (e) { log.warn(`[trashPurge] app usage purge failed for ${row.id}: ${e.message}`); }
        } catch (e) {
            log.warn(`[trashPurge] ${row.id}: ${e.message}`);
        }
    }
    if (purged) log.info(`[trashPurge] permanently deleted ${purged} routine(s) from the trash`);
    return { purged, considered: due.length };
}

module.exports = { purgeTrashPass };
