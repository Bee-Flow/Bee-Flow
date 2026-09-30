// @typecheck
'use strict';

/**
 * GDPR Art. 30 (and 5(1)(c)) — a project that holds personal data needs a
 * processing record.
 *
 * Subjects are the collaborative projects that SIGNALS say hold personal data
 * (compliance/projects/personalDataSignals.js: scanned project files, notebooks
 * and shared chats the Privacy Shield tokenised, shield events on the
 * project's chats, the background scan of its documents). Nothing is opened
 * to find out: a sweep never reads project content.
 *
 *   pass  the project has a current processing record (Compliance → Processing
 *         register): a lawful basis, confirmed within the review interval
 *   warn  personal data and no record — or a record without a lawful basis,
 *         or one nobody re-confirmed within the interval
 *   fail  special-category or national-identifier data (health, id numbers)
 *         and no record
 *
 * The record lives in compliance_subject_registrations (subject_kind
 * 'project'), kept by admins through routes/compliance/ropa.js; the RoPA
 * document lists the registered projects as processing activities.
 *
 * COVERAGE (listCoverage): the whole population is the organisation's
 * collaborative projects; a project counts as UNEXAMINED when it holds content
 * no signal covers — a document or notebook the background scan has not
 * checked (completely), or a team chat whose AI is switched off (no scan ever
 * reads it). Those are named, so the score never reads as an answer about
 * them.
 *
 * Evidence: project id, categories with counts, kinds, which sources, and
 * whether a record exists — never a name, never content.
 */

const pd = require('../../projects/projectData');
const signals = require('../../projects/personalDataSignals');

const DEFAULT_REVIEW_DAYS = 180;
const DAY_MS = 24 * 3600 * 1000;

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');
const UNEXAMINED_SQL = Object.freeze({
    documents: `
        SELECT DISTINCT sd.project_id FROM studio_documents sd
        JOIN projects p ON p.id = sd.project_id
        LEFT JOIN content_pii_signals s ON s.subject_kind = 'studio_document' AND s.subject_id = sd.id AND s.degraded = false
        WHERE ${ORG} AND ${WS} AND s.subject_id IS NULL
        LIMIT ${pd.ROW_LIMIT}`,
    notebooks: `
        SELECT DISTINCT n.project_id FROM notebooks n
        JOIN projects p ON p.id = n.project_id
        LEFT JOIN content_pii_signals s ON s.subject_kind = 'notebook_document' AND s.subject_id = n.id AND s.degraded = false
        WHERE ${ORG} AND ${WS} AND s.subject_id IS NULL AND n.pii_token_map IS NULL
        LIMIT ${pd.ROW_LIMIT}`,
    chats: `
        SELECT DISTINCT pc.project_id FROM project_chats pc
        JOIN projects p ON p.id = pc.project_id
        WHERE ${ORG} AND ${WS} AND pc.ai_mode = 'off' AND pc.message_count > 0
        LIMIT ${pd.ROW_LIMIT}`,
});

const defaultDeps = signals.recordCheckDeps;

async function _signals(orgId, deps) {
    const s = await deps.signals.signalsFor(orgId);
    // A source that failed could hide a project that is in fact a subject:
    // listing a partial population would retire its verdict. Say "could not
    // look" instead — the runner keeps the previous verdicts standing.
    if (s.unreadable.length) throw new Error(`personal-data signals unreadable: ${s.unreadable.join(', ')}`);
    return s;
}

/**
 * Pure verdict.
 * @param {{ projectId: string, signal: {categories: object, kinds: string[], sources: string[]}|null,
 *           registration: object|null, reviewDays: number, now: number }} input
 */
function verdict({ projectId, signal, registration, reviewDays, now }) {
    if (!signal) {
        return { status: 'not_applicable', evidence: { project_id: projectId }, details: 'No personal-data signal for this project any more.' };
    }
    const special = signals.hasSpecialKinds(signal.kinds);
    const confirmedAt = registration?.confirmed_at ? Date.parse(registration.confirmed_at) : NaN;
    const ageDays = Number.isFinite(confirmedAt) ? Math.floor((now - confirmedAt) / DAY_MS) : null;
    const evidence = {
        project_id: projectId,
        kinds: signal.kinds,
        categories: signal.categories,
        sources: signal.sources,
        special_categories: special,
        registered: !!registration,
        lawful_basis: registration?.lawful_basis || null,
        confirmed_days_ago: ageDays,
        review_every_days: reviewDays,
        link: pd.projectLink(projectId),
    };
    const ref = pd.shortRef(projectId);
    const what = special ? 'special-category or identification data' : 'personal data';
    if (!registration) {
        return {
            status: special ? 'fail' : 'warn',
            evidence,
            details: `${ref} holds ${what} (${signal.kinds.join(', ')}) and has no processing record. Record its purpose and lawful basis in the processing register.`,
        };
    }
    if (!registration.lawful_basis) {
        return { status: 'warn', evidence, details: `${ref} has a processing record without a lawful basis.` };
    }
    if (ageDays != null && ageDays > reviewDays) {
        return { status: 'warn', evidence, details: `${ref}'s processing record was last confirmed ${ageDays} days ago; your interval is ${reviewDays}. Re-confirm it.` };
    }
    return { status: 'pass', evidence, details: `${ref} holds ${what} under a current processing record (${registration.lawful_basis}).` };
}

async function listCoverage(orgId, deps = defaultDeps()) {
    const projects = await pd.countWorkspaceProjects(orgId, deps.query);
    const unexamined = new Set();
    for (const sql of Object.values(UNEXAMINED_SQL)) {
        let rows;
        try {
            rows = await deps.query(sql, [orgId]);
        } catch (e) {
            if (pd.isNotProvisioned(e)) continue;
            throw e;
        }
        for (const r of rows || []) if (r?.project_id) unexamined.add(String(r.project_id));
    }
    const ids = [...unexamined].sort();
    return {
        kind: 'projects',
        label: 'Collaborative projects',
        total: projects,
        examined: Math.max(0, projects - ids.length),
        unexamined: ids.map(id => pd.projectSubject(id)),
        link: 'admin/compliance/ropa',
        examined_as: 'checked for personal data in full',
        next_step: 'Documents and notebooks are checked when a version is saved while the Privacy Shield is on; a team chat whose AI is switched off is never read.',
    };
}

module.exports = {
    id: 'GDPR-Art30-project-personal-data',
    regulation: 'GDPR',
    article: '30',
    frameworks: [
        { regulation: 'GDPR', ref: '5(1)(c)' },
        { regulation: 'ISO27001', ref: 'A.5.34' },
        { regulation: 'ISO27001', ref: 'A.5.12' },
    ],
    severity: 'medium',
    scope: 'per-source',
    verification: 'hybrid',
    projectCheck: true,
    subjectNoun: 'projects',
    titleKey: 'compliance.checks.gdpr_project_personal_data.title',
    descriptionKey: 'compliance.checks.gdpr_project_personal_data.desc',
    remediationKey: 'compliance.checks.gdpr_project_personal_data.fix',
    remediationLink: 'admin/compliance/ropa',

    fingerprintOf(evidence) {
        return [(evidence?.kinds || []).slice().sort().join(','), !!evidence?.registered, evidence?.lawful_basis || null];
    },

    // Every project a signal names; one that leaves the list is retired.
    ...signals.personalDataPopulation(defaultDeps),

    async evaluate(orgId, subject, deps = defaultDeps()) {
        const projectId = pd.projectIdOf(subject?.id);
        if (!projectId) return { status: 'not_applicable', evidence: {}, details: 'No project to judge.' };
        const { byProject } = await _signals(orgId, deps);
        const [registrations, settings] = await Promise.all([
            deps.complianceStore.listSubjectRegistrations(orgId, 'project').catch((e) => {
                if (pd.isNotProvisioned(e)) return [];
                throw e;
            }),
            deps.complianceStore.getSettings(orgId).catch(() => ({})),
        ]);
        const reviewDays = Number(settings?.datatable_review_days) > 0 ? Number(settings.datatable_review_days) : DEFAULT_REVIEW_DAYS;
        return verdict({
            projectId,
            signal: byProject.get(projectId) || null,
            registration: (registrations || []).find(r => String(r.subject_id) === projectId) || null,
            reviewDays,
            now: deps.now(),
        });
    },

    listCoverage,

    _verdict: verdict,
    DEFAULT_REVIEW_DAYS,
    UNEXAMINED_SQL,
};
