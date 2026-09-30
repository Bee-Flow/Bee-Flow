// @typecheck
'use strict';

/**
 * GDPR Art. 5(1)(e) — storage limitation for collaborative projects.
 *
 * A project that holds personal data (the same subjects as
 * GDPR-Art30-project-personal-data) and that nobody has touched for longer
 * than the organisation keeps project data should be archived, exported or
 * deleted — or its keeping documented (acknowledge the finding with a reason
 * such as a legal hold, and a date).
 *
 * "Touched" is the newest of: the project row itself, its activity log, its
 * team chats' last message, its notebooks, its documents and the chats filed
 * in it. Each is read on its own, so an install without one of those tables
 * still gets an answer from the rest.
 *
 * The window is the project's own processing record's retention when it has
 * one, else the org setting `project_retention_days`, else 365 days — and the
 * details say which.
 *
 *   warn  idle longer than the window
 *   fail  idle longer than twice the window
 *   pass  otherwise
 */

const pd = require('../../projects/projectData');
const signals = require('../../projects/personalDataSignals');

const DEFAULT_RETENTION_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;

// Newest moment per source, for ONE project. Every one hits a project_id index.
const LAST_ACTIVITY_SQL = Object.freeze({
    project: `SELECT MAX(p.updated_at) AS at FROM projects p WHERE p.id = $2 AND ${pd.orgMatch('p.organization_id')}`,
    activity: `SELECT MAX(created_at) AS at FROM project_activity WHERE project_id = $2 AND $1::text IS NOT NULL`,
    chats: `SELECT MAX(COALESCE(last_message_at, updated_at)) AS at FROM project_chats WHERE project_id = $2 AND $1::text IS NOT NULL`,
    notebooks: `SELECT MAX(updated_at) AS at FROM notebooks WHERE project_id = $2 AND $1::text IS NOT NULL`,
    documents: `SELECT MAX(updated_at) AS at FROM studio_documents WHERE project_id = $2 AND $1::text IS NOT NULL`,
    direct: `SELECT MAX(updated_at) AS at FROM direct_conversations WHERE project_id = $2 AND $1::text IS NOT NULL`,
    agent: `SELECT MAX(updated_at) AS at FROM agent_conversations WHERE project_id = $2 AND $1::text IS NOT NULL`,
});

const defaultDeps = signals.recordCheckDeps;

async function lastActivity(orgId, projectId, deps) {
    let newest = null;
    let found = false;
    const unreadable = [];
    for (const [name, sql] of Object.entries(LAST_ACTIVITY_SQL)) {
        let rows;
        try {
            rows = await deps.query(sql, [orgId, projectId]);
        } catch (e) {
            if (pd.isNotProvisioned(e)) continue;
            unreadable.push(name);
            continue;
        }
        const t = rows?.[0]?.at ? Date.parse(new Date(rows[0].at).toISOString()) : NaN;
        if (name === 'project' && Number.isFinite(t)) found = true;
        if (Number.isFinite(t) && (newest == null || t > newest)) newest = t;
    }
    return { at: newest, found, unreadable };
}

/**
 * Pure verdict.
 * @param {{ projectId: string, lastAt: number|null, retentionDays: number, source: 'project'|'org'|'default', now: number, unreadable?: string[] }} input
 */
function verdict({ projectId, lastAt, retentionDays, source, now, unreadable = [] }) {
    const ref = pd.shortRef(projectId);
    const windowWords = source === 'project'
        ? `its processing record keeps data ${retentionDays} days`
        : source === 'org'
            ? `your organisation keeps project data ${retentionDays} days`
            : `no project retention is set, so the default of ${retentionDays} days applies`;
    if (lastAt == null) {
        return { status: 'warn', evidence: { project_id: projectId, unreadable }, details: `When ${ref} was last used could not be read, so its retention was not judged.` };
    }
    const idleDays = Math.max(0, Math.floor((now - lastAt) / DAY_MS));
    const evidence = {
        project_id: projectId,
        idle_days: idleDays,
        retention_days: retentionDays,
        retention_source: source,
        unreadable,
        link: pd.projectLink(projectId, 'settings'),
    };
    if (idleDays > 2 * retentionDays) {
        return { status: 'fail', evidence, details: `${ref} holds personal data and has not been used for ${idleDays} days — more than twice the window (${windowWords}). Archive, export or delete it, or record why it is kept.` };
    }
    if (idleDays > retentionDays) {
        return { status: 'warn', evidence, details: `${ref} holds personal data and has not been used for ${idleDays} days (${windowWords}). Archive, export or delete it, or record why it is kept.` };
    }
    if (unreadable.length) {
        return { status: 'warn', evidence, details: `${ref} was used ${idleDays} days ago as far as could be read, but ${unreadable.join(', ')} could not be read.` };
    }
    return { status: 'pass', evidence, details: `${ref} was last used ${idleDays} days ago, inside the window (${windowWords}).` };
}

module.exports = {
    id: 'GDPR-Art5-1-e-project-retention',
    regulation: 'GDPR',
    article: '5(1)(e)',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.8.10' }],
    severity: 'medium',
    scope: 'per-source',
    verification: 'automated',
    projectCheck: true,
    subjectNoun: 'projects',
    titleKey: 'compliance.checks.gdpr_project_retention.title',
    descriptionKey: 'compliance.checks.gdpr_project_retention.desc',
    remediationKey: 'compliance.checks.gdpr_project_retention.fix',
    remediationLink: 'admin/compliance/settings',

    // Growing idle time is the same finding; crossing into "twice the window"
    // is a new status and so a new fingerprint anyway.
    fingerprintOf(evidence) {
        return [evidence?.retention_days ?? null, evidence?.retention_source ?? null];
    },

    // The same population as GDPR-Art30-project-personal-data, read the same way.
    ...signals.personalDataPopulation(defaultDeps),

    async evaluate(orgId, subject, deps = defaultDeps()) {
        const projectId = pd.projectIdOf(subject?.id);
        if (!projectId) return { status: 'not_applicable', evidence: {}, details: 'No project to judge.' };
        const [settings, registrations] = await Promise.all([
            deps.complianceStore.getSettings(orgId).catch(() => ({})),
            deps.complianceStore.listSubjectRegistrations(orgId, 'project').catch(() => []),
        ]);
        const own = (registrations || []).find(r => String(r.subject_id) === projectId);
        let retentionDays = DEFAULT_RETENTION_DAYS;
        /** @type {'project'|'org'|'default'} */
        let source = 'default';
        if (Number(own?.retention_days) > 0) { retentionDays = Number(own.retention_days); source = 'project'; }
        else if (Number(settings?.project_retention_days) > 0) { retentionDays = Number(settings.project_retention_days); source = 'org'; }
        const last = await lastActivity(orgId, projectId, deps);
        if (!last.found && !last.unreadable.includes('project')) {
            return { status: 'not_applicable', evidence: { project_id: projectId }, details: 'That project no longer exists in this organisation.' };
        }
        return verdict({ projectId, lastAt: last.at, retentionDays, source, now: deps.now(), unreadable: last.unreadable });
    },

    _verdict: verdict,
    _lastActivity: lastActivity,
    DEFAULT_RETENTION_DAYS,
};
