// @typecheck
'use strict';

/**
 * Live project names for the Compliance Center's check table.
 *
 * Check results and evidence carry project IDS only (a project's name can be
 * a client's name, and the evidence chain is immutable). The admin reading the
 * table still needs to know which project a row is about, so the /checks route
 * resolves the CURRENT names at read time, for this organisation's projects
 * only, and never stores them anywhere.
 */

const pd = require('./projectData');

const MAX_IDS = 500;

/** Every project id a result row refers to: its subject, and its offenders. */
function projectIdsOfRow(row) {
    const out = new Set();
    const scope = row && row.scope_id ? String(row.scope_id) : '';
    if (scope.startsWith('project:')) out.add(scope.slice('project:'.length));
    const ev = row && row.evidence && typeof row.evidence === 'object' ? row.evidence : null;
    if (ev) {
        if (typeof ev.project_id === 'string' && ev.project_id) out.add(ev.project_id);
        for (const o of Array.isArray(ev.offenders) ? ev.offenders : []) {
            if (o && typeof o.project_id === 'string' && o.project_id) out.add(o.project_id);
        }
    }
    return out;
}

/**
 * `{ [projectId]: name }` for the ids that are this organisation's projects.
 * @param {string} orgId
 * @param {Iterable<string>} ids
 * @param {(sql: string, params: any[]) => Promise<any[]>} [query]
 */
async function projectNames(orgId, ids, query = pd.defaultQuery()) {
    const list = [...new Set([...ids].map(String).filter(Boolean))].slice(0, MAX_IDS);
    if (!list.length) return {};
    const rows = await query(`
        SELECT p.id, p.name FROM projects p
        WHERE ${pd.orgMatch('p.organization_id')} AND p.id = ANY($2::text[])
    `, [orgId, list]);
    const out = {};
    for (const r of rows || []) if (r && r.id) out[String(r.id)] = r.name;
    return out;
}

module.exports = { projectIdsOfRow, projectNames, MAX_IDS };
