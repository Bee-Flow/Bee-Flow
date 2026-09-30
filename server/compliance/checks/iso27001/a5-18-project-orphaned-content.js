// @typecheck
'use strict';

/**
 * ISO 27001 A.5.18 / A.6.5 — project content whose owner has left.
 *
 * Only a project's OWNER manages its members, so a project whose owner left
 * (account suspended, deactivated by the directory sync, deleted, or moved
 * to another organisation — projectData.hasLeft) is one
 * nobody can govern any more: people keep their access and nobody can take it
 * away. A chat shared into a project, or a project notebook, whose owner left
 * is a smaller version of the same problem.
 *
 *   fail  a project's owner has left
 *   warn  shared chats or project notebooks whose owner has left
 *   pass  every owner is a current member of the organisation
 *   not_applicable  no collaborative projects
 *
 * One thing an admin must know before acting, and the details say it: a chat
 * shared by someone who left cannot be taken back into anyone else's hands —
 * it is encrypted with its owner's key — so it can only be archived or
 * deleted. Metadata only; ids and counts in evidence.
 */

const pd = require('../../projects/projectData');

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');
const LEFT = (u) => `(${u}.id IS NULL OR ${pd.hasLeft(`${u}.status`)} OR COALESCE(NULLIF(${u}."organizationId", ''), '${pd.NO_ORG_ORG_ID}') <> $1)`;

const QUERIES = Object.freeze({
    owners: `
        SELECT p.id AS project_id, 1 AS n
        FROM projects p LEFT JOIN users u ON u.id = p.owner_id
        WHERE ${ORG} AND ${WS} AND ${LEFT('u')}
        LIMIT ${pd.ROW_LIMIT}`,
    threads: `
        SELECT c.project_id, COUNT(*)::int AS n FROM (
            SELECT project_id, user_id FROM direct_conversations WHERE project_id IS NOT NULL AND shared_scope = 'project'
            UNION ALL
            SELECT project_id, user_id FROM agent_conversations WHERE project_id IS NOT NULL AND shared_scope = 'project'
        ) c
        JOIN projects p ON p.id = c.project_id
        LEFT JOIN users u ON u.id = c.user_id
        WHERE ${ORG} AND ${WS} AND ${LEFT('u')}
        GROUP BY c.project_id
        LIMIT ${pd.ROW_LIMIT}`,
    notebooks: `
        SELECT n.project_id, COUNT(*)::int AS n
        FROM notebooks n
        JOIN projects p ON p.id = n.project_id
        LEFT JOIN users u ON u.id = n.user_id
        WHERE ${ORG} AND ${WS} AND ${LEFT('u')}
        GROUP BY n.project_id
        LIMIT ${pd.ROW_LIMIT}`,
});

function defaultDeps() {
    return { query: pd.defaultQuery() };
}

/**
 * Pure verdict.
 * @param {{ projects: number, owners: string[], threads: Record<string, number>, notebooks: Record<string, number>, unreadable?: string[] }} input
 */
function verdict({ projects, owners, threads, notebooks, unreadable = [] }) {
    if (!projects) {
        return { status: 'not_applicable', evidence: { projects: 0 }, details: 'This organisation has no collaborative projects.' };
    }
    const per = new Map();
    const at = (id) => {
        const e = per.get(id) || { project_id: String(id), owner_left: false, threads: 0, notebooks: 0 };
        per.set(id, e);
        return e;
    };
    for (const id of owners) at(id).owner_left = true;
    for (const [id, n] of Object.entries(threads)) at(id).threads += Number(n) || 0;
    for (const [id, n] of Object.entries(notebooks)) at(id).notebooks += Number(n) || 0;
    const offenders = [...per.values()].sort((a, b) => (Number(b.owner_left) - Number(a.owner_left)) || a.project_id.localeCompare(b.project_id));
    const threadCount = offenders.reduce((n, o) => n + o.threads, 0);
    const notebookCount = offenders.reduce((n, o) => n + o.notebooks, 0);
    const evidence = {
        projects,
        projects_without_owner: owners.length,
        orphaned_threads: threadCount,
        orphaned_notebooks: notebookCount,
        offenders: offenders.slice(0, pd.MAX_OFFENDERS).map(o => ({ ...o, link: pd.projectLink(o.project_id) })),
        offenders_truncated: offenders.length > pd.MAX_OFFENDERS,
        link: offenders.length === 1 ? pd.projectLink(offenders[0].project_id) : null,
        unreadable,
    };
    const threadNote = threadCount
        ? ' A chat shared by someone who left is encrypted with their key: it cannot be handed to someone else, only archived or deleted.'
        : '';
    if (owners.length) {
        return {
            status: 'fail',
            evidence,
            details: `The owner of ${owners.length} project(s) has left, so nobody can manage who has access: ${pd.nameOffenders(owners)}. Reactivate the owner long enough to hand the project over, or archive it.${threadNote}`,
        };
    }
    if (threadCount || notebookCount) {
        const ids = offenders.map(o => o.project_id);
        return {
            status: 'warn',
            evidence,
            details: `${threadCount} shared chat(s) and ${notebookCount} notebook(s) in ${ids.length} project(s) belong to people who left: ${pd.nameOffenders(ids)}.${threadNote}`,
        };
    }
    if (unreadable.length) {
        return {
            status: 'warn',
            evidence,
            details: `Project owners are all current, but ${unreadable.join(' and ')} could not be read, so orphaned content there was not judged.`,
        };
    }
    return { status: 'pass', evidence, details: `Every owner of this organisation's ${projects} collaborative project(s), and of their shared chats and notebooks, is a current member.` };
}

async function _collect(orgId, deps) {
    const out = { owners: [], threads: {}, notebooks: {}, unreadable: [] };
    for (const [name, sql] of Object.entries(QUERIES)) {
        let rows;
        try {
            rows = await deps.query(sql, [orgId]);
        } catch (e) {
            if (name === 'owners') throw e;
            if (!pd.isNotProvisioned(e)) out.unreadable.push(name);
            continue;
        }
        for (const r of rows || []) {
            if (!r?.project_id) continue;
            if (name === 'owners') out.owners.push(String(r.project_id));
            else out[name][String(r.project_id)] = Number(r.n) || 0;
        }
    }
    return out;
}

module.exports = {
    id: 'ISO27001-A.5.18-project-orphaned-content',
    regulation: 'ISO27001',
    article: 'A.5.18',
    controls: ['A.5.18', 'A.6.5'],
    frameworks: [{ regulation: 'GDPR', ref: '5(1)(f)' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    projectCheck: true,
    titleKey: 'compliance.checks.iso_project_orphaned_content.title',
    descriptionKey: 'compliance.checks.iso_project_orphaned_content.desc',
    remediationKey: 'compliance.checks.iso_project_orphaned_content.fix',
    remediationLink: 'admin/security/users',

    fingerprintOf(evidence) {
        const offenders = Array.isArray(evidence?.offenders) ? evidence.offenders : [];
        return offenders.map(o => `${o.project_id}:${o.owner_left ? 'o' : ''}${o.threads > 0 ? 't' : ''}${o.notebooks > 0 ? 'n' : ''}`).sort();
    },

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        let projects;
        let found;
        try {
            projects = await pd.countWorkspaceProjects(orgId, deps.query);
            found = projects ? await _collect(orgId, deps) : { owners: [], threads: {}, notebooks: {}, unreadable: [] };
        } catch (e) {
            if (pd.isNotProvisioned(e)) {
                return { status: 'not_applicable', evidence: { reason: 'not_provisioned' }, details: 'Collaborative projects are not set up on this installation yet.' };
            }
            return { status: 'warn', evidence: { error: 'unreadable', sql_state: e?.code || null }, details: `Project owners could not be read (${e?.code || 'error'}), so they were not judged.` };
        }
        return verdict({ projects, ...found });
    },

    _verdict: verdict,
    QUERIES,
};
