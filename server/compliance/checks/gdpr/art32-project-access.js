// @typecheck
'use strict';

/**
 * GDPR Art. 32 — who can reach a collaborative project.
 *
 * A project's members see its chats, documents, notebooks and files. The
 * share route only lets an owner add people and groups of the project's OWN
 * organisation, so a member from somewhere else is drift: a person who moved
 * to another organisation, a legacy row from before the check existed, a
 * write that did not go through the route. And a membership whose account or
 * group no longer exists is a door nobody watches.
 *
 *   fail  a member or group from another organisation
 *   warn  a membership of an account that left (any status but active or a
 *         sign-up state: suspended, inactive, ...) or no
 *         longer exists, or of a group that no longer exists
 *   pass  every membership of every project is a current principal of the org
 *   not_applicable  the organisation has no collaborative projects
 *
 * Global: ONE verdict for the organisation, the affected projects named in the
 * evidence by id with counts (capped at 50), never a name. Metadata only — no
 * content is read.
 *
 * Auto-fix `project_prune_dangling_shares` removes the memberships whose
 * account or group NO LONGER EXISTS (only those: a suspended account may come
 * back, and a foreign member is a question for a human).
 */

const pd = require('../../projects/projectData');

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');

// The problem memberships only; clean rows never leave the database.
const OFFENDING_SQL = `
    SELECT p.id AS project_id, s.shared_with_type AS type,
           CASE WHEN s.shared_with_type = 'user' THEN u.id IS NOT NULL ELSE g.id IS NOT NULL END AS target_exists,
           CASE WHEN s.shared_with_type = 'user'
                THEN COALESCE(NULLIF(u."organizationId", ''), '${pd.NO_ORG_ORG_ID}')
                ELSE COALESCE(NULLIF(g."organizationId", ''), '${pd.NO_ORG_ORG_ID}') END AS target_org,
           CASE WHEN s.shared_with_type = 'user' THEN ${pd.hasLeft('u.status')} ELSE false END AS target_left
    FROM projects p
    JOIN project_shares s ON s.project_id = p.id
    LEFT JOIN users u ON s.shared_with_type = 'user' AND u.id = s.shared_with_id
    LEFT JOIN groups g ON s.shared_with_type = 'group' AND g.id = s.shared_with_id
    WHERE ${ORG} AND ${WS}
      AND (
        (s.shared_with_type = 'user' AND (u.id IS NULL OR ${pd.hasLeft('u.status')}
            OR COALESCE(NULLIF(u."organizationId", ''), '${pd.NO_ORG_ORG_ID}') <> $1))
        OR (s.shared_with_type = 'group' AND (g.id IS NULL
            OR COALESCE(NULLIF(g."organizationId", ''), '${pd.NO_ORG_ORG_ID}') <> $1))
      )
    LIMIT ${pd.ROW_LIMIT}`;

const PRUNE_SQL = `
    DELETE FROM project_shares s
    USING projects p
    WHERE s.project_id = p.id AND ${ORG} AND ${WS}
      AND ($2::text IS NULL OR p.id = $2)
      AND (
        (s.shared_with_type = 'user' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.shared_with_id))
        OR (s.shared_with_type = 'group' AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.id = s.shared_with_id))
      )
    RETURNING s.project_id`;

function defaultDeps() {
    return { query: pd.defaultQuery() };
}

/**
 * Pure: turn the offending rows into the verdict.
 * @param {{ projects: number, rows: Array<{project_id: string, target_exists: boolean, target_org: string, target_left: boolean}>, orgId: string }} input
 */
function verdict({ projects, rows, orgId }) {
    if (!projects) {
        return { status: 'not_applicable', evidence: { projects: 0 }, details: 'This organisation has no collaborative projects.' };
    }
    const per = new Map();
    for (const r of rows || []) {
        const e = per.get(r.project_id) || { project_id: String(r.project_id), foreign: 0, dangling: 0 };
        if (r.target_exists && !r.target_left && r.target_org !== orgId) e.foreign++;
        else e.dangling++;
        per.set(r.project_id, e);
    }
    const offenders = [...per.values()].sort((a, b) => (b.foreign - a.foreign) || (b.dangling - a.dangling) || a.project_id.localeCompare(b.project_id));
    const foreign = offenders.reduce((n, o) => n + o.foreign, 0);
    const dangling = offenders.reduce((n, o) => n + o.dangling, 0);
    const evidence = {
        projects,
        foreign_count: foreign,
        dangling_count: dangling,
        projects_affected: offenders.length,
        offenders: offenders.slice(0, pd.MAX_OFFENDERS).map(o => ({ ...o, link: pd.projectLink(o.project_id, 'members') })),
        offenders_truncated: offenders.length > pd.MAX_OFFENDERS,
        link: offenders.length === 1 ? pd.projectLink(offenders[0].project_id, 'members') : null,
    };
    if (foreign > 0) {
        const ids = offenders.filter(o => o.foreign > 0).map(o => o.project_id);
        return {
            status: 'fail',
            evidence,
            details: `${foreign} membership(s) in ${ids.length} project(s) belong to another organisation: ${pd.nameOffenders(ids)}. Remove them in each project's Members page.`,
        };
    }
    if (dangling > 0) {
        const ids = offenders.map(o => o.project_id);
        return {
            status: 'warn',
            evidence,
            details: `${dangling} membership(s) in ${ids.length} project(s) belong to accounts that left or no longer exist, or to deleted groups: ${pd.nameOffenders(ids)}.`,
        };
    }
    return { status: 'pass', evidence, details: `Every member of this organisation's ${projects} collaborative project(s) is a current member of the organisation.` };
}

module.exports = {
    id: 'GDPR-Art32-project-access',
    regulation: 'GDPR',
    article: '32',
    frameworks: [
        { regulation: 'ISO27001', ref: 'A.5.15' },
        { regulation: 'ISO27001', ref: 'A.5.18' },
        { regulation: 'ISO27001', ref: 'A.8.3' },
        { regulation: 'NIS2', ref: 'Art. 21(2)(i)' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    projectCheck: true,
    titleKey: 'compliance.checks.gdpr_project_access.title',
    descriptionKey: 'compliance.checks.gdpr_project_access.desc',
    remediationKey: 'compliance.checks.gdpr_project_access.fix',
    remediationLink: 'admin/compliance/gdpr',
    autoFixId: 'project_prune_dangling_shares',

    /** The same finding while the same projects are affected the same way. */
    fingerprintOf(evidence) {
        const offenders = Array.isArray(evidence?.offenders) ? evidence.offenders : [];
        return offenders.map(o => `${o.project_id}:${o.foreign > 0 ? 'f' : ''}${o.dangling > 0 ? 'd' : ''}`).sort();
    },

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        let projects;
        let rows;
        try {
            projects = await pd.countWorkspaceProjects(orgId, deps.query);
            rows = projects ? await deps.query(OFFENDING_SQL, [orgId]) : [];
        } catch (e) {
            if (pd.isNotProvisioned(e)) {
                return { status: 'not_applicable', evidence: { reason: 'not_provisioned' }, details: 'Collaborative projects are not set up on this installation yet.' };
            }
            return { status: 'warn', evidence: { error: 'unreadable', sql_state: e?.code || null }, details: `Project memberships could not be read (${e?.code || 'error'}), so they were not judged.` };
        }
        return verdict({ projects, rows, orgId });
    },

    async autoFix(orgId, { subjectId = null } = {}, deps = defaultDeps()) {
        const projectId = subjectId ? pd.projectIdOf(subjectId) : null;
        const removed = await deps.query(PRUNE_SQL, [orgId, projectId]);
        const projects = new Set((removed || []).map(r => r.project_id)).size;
        return {
            changed: (removed || []).length,
            projects,
            summary: `Removed ${(removed || []).length} membership(s) of deleted accounts or groups from ${projects} project(s).`,
        };
    },

    _verdict: verdict,
    OFFENDING_SQL,
    PRUNE_SQL,
};
