// @typecheck
/**
 * The column write of automationStore.updateAutomation (split out of
 * automations.js): which fields map to which columns, and the definition
 * serialised once.
 */

'use strict';

const { buildUpdate } = require('../lib/sqlBuilder');

const UPDATE_FIELD_MAP = Object.freeze({
    title: 'title',
    description: 'description',
    icon: 'icon',
    category: 'category',
    definition: 'definition_json',
    isActive: 'is_active',
    isDraft: 'is_draft',
    needsFirstRunConfirm: 'needs_first_run_confirm',
    triggerType: 'trigger_type',
    scheduleCron: 'schedule_cron',
    scheduleTz: 'schedule_tz',
    nextRunAt: 'next_run_at',
    lastRunAt: 'last_run_at',
    lastStatus: 'last_status',
    runTimeoutMs: 'run_timeout_ms',
    // null = standalone (all pre-existing rows); set = filed into a project,
    // where project members can see and run it.
    projectId: 'project_id',
    folderId: 'folder_id',
});

/** The column write for `updates`, and its definition serialised once. */
function buildAutomationUpdate(updates) {
    const write = { ...updates };
    let definitionJson = null;
    if (updates.definition !== undefined) {
        // Never coerce a falsy definition into `{}`. An empty object is
        // truthy, so it reads back as a "present" definition and silently
        // defeats the builder's `def || seed` fallbacks — that is how a
        // automation ended up persisting a trigger-only graph and failing
        // validation forever (BFSF-318). Callers must validate first.
        const v = updates.definition;
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
            throw new Error('definition must be a non-null object');
        }
        definitionJson = JSON.stringify(v);
        write.definition = definitionJson;
    }
    const buildFor = (w) => buildUpdate({
        table: 'automations',
        updates: w,
        columnMap: UPDATE_FIELD_MAP,
        extraSet: ['updated_at = NOW()'],
        quoteCols: true,
    });
    return { write, definitionJson, buildFor, built: buildFor(write) };
}

module.exports = { buildAutomationUpdate, UPDATE_FIELD_MAP };
