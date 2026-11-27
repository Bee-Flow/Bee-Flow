// @typecheck strict
/**
 * The organisation cascade's last rung (stores/user/organizations.js
 * deleteOrganization): the tenant's records keyed by organisation, after the
 * members are gone — rows of members removed by another path, organisation
 * records that were handed on. Meeting notes go through the content erasure
 * port (the recordings live outside Postgres); every other table is a plain
 * delete on its organisation column.
 *
 * Automations cascade their runs, schedules, versions and the rest on their
 * own FK. A module's table (erasureCoverage.js MODULE_TABLES) is erased while
 * that module is here or its schema is in this database, and skipped when
 * neither is; a missing one then throws. A core table an install does not have
 * is skipped; anything else throws, like every other rung of the cascade.
 */

'use strict';

const { run, getAll } = require('../../db');
const { isMissingTable } = require('../../utils/isMissingTable');
const { erasurePort } = require('./erasurePorts');
const { moduleOfTable, erasesTable } = require('./erasureCoverage');

/**
 * Table → the column that names the organisation. Literals from this list,
 * never a caller's.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const ORG_KEYED_TABLES = Object.freeze([
    ['automations', 'organization_id'], ['automation_approvals', 'organization_id'],
    ['automation_approval_deliveries', 'organization_id'], ['automation_usage', 'organization_id'],
    ['automation_templates', 'organization_id'], ['automation_suggestion_feedback', 'organization_id'],
    ['suggestion_scan_cache', 'organization_id'],
    ['studio_apps', 'organization_id'], ['studio_app_templates', 'organization_id'],
    ['studio_documents', 'organization_id'], ['document_suggestions', 'organization_id'],
    ['webpage_public_shares', 'organization_id'], ['playbooks', 'organization_id'],
    ['skills', 'org_id'], ['apps', 'organization_id'], ['project_blueprints', 'organization_id'],
    ['summary_templates', 'organization_id'], ['org_house_styles', 'org_id'],
    ['org_custom_integrations', 'org_id'], ['meeting_prefs', 'org_id'],
    ['gmeet_import_jobs', 'org_id'], ['teams_import_jobs', 'org_id'],
    ['azure_sync_memberships', 'organization_id'], ['azure_service_usage_log', 'organization_id'],
    ['integration_activity_log', 'organization_id'], ['ai_usage_log', 'organization_id'],
    ['ai_task_termination_log', 'organization_id'], ['message_feedback', 'organization_id'],
    ['guardrail_events', 'organization_id'], ['consent_acceptances', 'organization_id'],
    ['support_inboxes', 'organization_id'], ['support_canned_responses', 'organization_id'],
    ['dsr_requests', 'organization_id'], ['compliance_custom_frameworks', 'organization_id'],
    ['compliance_incidents', 'organization_id'], ['isms_documents', 'organization_id'],
    ['isms_acknowledgements', 'organization_id'], ['iso_audits', 'organization_id'],
    ['iso_management_reviews', 'organization_id'], ['iso_nonconformities', 'organization_id'],
    ['iso_objectives', 'organization_id'], ['iso_obligations', 'organization_id'],
    ['iso_risk_treatments', 'organization_id'], ['iso_risks', 'organization_id'],
    ['iso_soa_entries', 'organization_id'],
]);

/**
 * @param {string} orgId
 * @param {(step: string) => void} at  names the rung for the caller's failure log
 */
async function eraseOrgKeyedRows(orgId, at) {
    at('meeting notes');
    await erasurePort('content').eraseOrgTranscriptions(orgId);
    for (const [table, column] of ORG_KEYED_TABLES) {
        if (!await erasesTable(table)) continue;
        at(table);
        try {
            await run(`DELETE FROM "${table}" WHERE "${column}" = $1`, [orgId]);
        } catch (e) {
            if (moduleOfTable(table) !== null || !isMissingTable(e)) throw e;
        }
    }
}

/**
 * One step of the cascade on a LEGACY table: group_chats, tasks, custom_tables, dashboards and
 * dashboard_panels belong to features that are gone, and no file of this tree creates them. An
 * installation from before has them and its rows must go with the organisation; a database
 * migrated from empty does not, and the step is skipped there. Without this skip the missing
 * table fails the whole cascade, and an organisation of a fresh installation cannot be deleted.
 * @template T
 * @param {() => Promise<T>} step
 * @returns {Promise<T | undefined>}
 */
async function onLegacyTable(step) {
    try {
        return await step();
    } catch (e) {
        if (!isMissingTable(e)) throw e;
        return undefined;
    }
}

/** The organisation's custom tables (legacy): each physical table, then the rows that named them. @param {string} orgId */
async function dropCustomTables(orgId) {
    const customTables = await getAll('SELECT table_name FROM custom_tables WHERE organization_id = $1', [orgId]);
    for (const ct of customTables) {
        const safeName = ct.table_name.replace(/[^a-zA-Z0-9_]/g, '');
        await run(`DROP TABLE IF EXISTS "${safeName}"`);
    }
    await run('DELETE FROM custom_tables WHERE organization_id = $1', [orgId]);
}

/** The organisation's dashboards (legacy): their panels first. @param {string} orgId */
async function eraseDashboards(orgId) { // stepwise: part of deleteOrganization's erasure; panels before dashboards, each statement idempotent, deleting again finishes it
    const dashboards = await getAll('SELECT id FROM dashboards WHERE organization_id = $1', [orgId]);
    if (dashboards.length > 0) {
        // Its own step: a database with dashboards but no panel table still loses the dashboards.
        await onLegacyTable(() => run('DELETE FROM dashboard_panels WHERE dashboard_id = ANY($1)', [dashboards.map((d) => d.id)]));
    }
    await run('DELETE FROM dashboards WHERE organization_id = $1', [orgId]);
}

module.exports = { ORG_KEYED_TABLES, eraseOrgKeyedRows, onLegacyTable, dropCustomTables, eraseDashboards };
