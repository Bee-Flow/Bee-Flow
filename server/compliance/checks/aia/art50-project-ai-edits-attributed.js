// @typecheck
'use strict';

/**
 * AI Act Art. 50 — AI-written changes in project documents and notebooks are
 * attributed to the AI.
 *
 * The version history of a project document or notebook records who made
 * each checkpoint (`contributors`: users and, for an AI edit, `{kind:'ai'}`)
 * and why (`source`: 'ai' for a change the AI applied). A version the AI
 * wrote that does not name the AI among its contributors would present
 * machine-written text as a person's — the transparency failure Art. 50 is
 * about.
 *
 *   not_applicable  the version tables do not record authorship yet on this
 *                   installation, or no AI-written version exists
 *   warn            AI-written versions without AI attribution
 *   pass            every AI-written version names the AI
 *
 * Counts only; no content, no author ids, in evidence.
 */

const pd = require('../../projects/projectData');

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');
const AI_CONTRIBUTOR = `'[{"kind": "ai"}]'::jsonb`;

const QUERIES = Object.freeze({
    notebooks: `
        SELECT COUNT(*)::int AS ai_versions,
               COUNT(*) FILTER (WHERE NOT (v.contributors @> ${AI_CONTRIBUTOR}))::int AS unattributed,
               COUNT(DISTINCT p.id) FILTER (WHERE NOT (v.contributors @> ${AI_CONTRIBUTOR}))::int AS projects
        FROM notebook_versions v
        JOIN notebooks n ON n.id = v.notebook_id
        JOIN projects p ON p.id = n.project_id
        WHERE ${ORG} AND ${WS} AND v.source = 'ai'`,
    documents: `
        SELECT COUNT(*)::int AS ai_versions,
               COUNT(*) FILTER (WHERE NOT (v.contributors @> ${AI_CONTRIBUTOR}))::int AS unattributed,
               COUNT(DISTINCT p.id) FILTER (WHERE NOT (v.contributors @> ${AI_CONTRIBUTOR}))::int AS projects
        FROM studio_document_versions v
        JOIN studio_documents d ON d.id = v.document_id
        JOIN projects p ON p.id = d.project_id
        WHERE ${ORG} AND ${WS} AND v.source = 'ai'`,
});

function defaultDeps() {
    return { query: pd.defaultQuery() };
}

/** Pure verdict over the per-table counts (null = the table does not record authorship). */
function verdict(counts) {
    const recorded = Object.entries(counts).filter(([, c]) => c != null);
    if (!recorded.length) {
        return {
            status: 'not_applicable',
            evidence: { authorship_recorded: false },
            details: 'The version history does not record who wrote each version on this installation yet.',
        };
    }
    const evidence = { authorship_recorded: true };
    let ai = 0; let bad = 0; let projects = 0;
    for (const [name, c] of recorded) {
        evidence[`${name}_ai_versions`] = c.ai_versions;
        evidence[`${name}_unattributed`] = c.unattributed;
        ai += c.ai_versions; bad += c.unattributed; projects += c.projects;
    }
    evidence.ai_versions = ai;
    evidence.unattributed = bad;
    if (!ai) return { status: 'not_applicable', evidence, details: 'No version of a project document or notebook was written by the AI yet.' };
    if (bad) {
        return {
            status: 'warn',
            evidence,
            details: `${bad} of ${ai} AI-written version(s) of project documents and notebooks do not name the AI as a contributor (in ${projects} project(s) at most).`,
        };
    }
    return { status: 'pass', evidence, details: `All ${ai} AI-written version(s) of project documents and notebooks name the AI as a contributor.` };
}

module.exports = {
    id: 'AIA-Art50-project-ai-edits-attributed',
    regulation: 'AIA',
    article: '50',
    severity: 'low',
    scope: 'global',
    verification: 'automated',
    projectCheck: true,
    titleKey: 'compliance.checks.aia_project_ai_edits.title',
    descriptionKey: 'compliance.checks.aia_project_ai_edits.desc',
    remediationKey: 'compliance.checks.aia_project_ai_edits.fix',
    remediationLink: 'admin/compliance/aia',

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        const counts = {};
        for (const [name, sql] of Object.entries(QUERIES)) {
            try {
                const row = (await deps.query(sql, [orgId]))?.[0] || {};
                counts[name] = {
                    ai_versions: Number(row.ai_versions) || 0,
                    unattributed: Number(row.unattributed) || 0,
                    projects: Number(row.projects) || 0,
                };
            } catch (e) {
                if (pd.isNotProvisioned(e)) { counts[name] = null; continue; }
                return { status: 'warn', evidence: { error: 'unreadable', sql_state: e?.code || null }, details: `The version history could not be read (${e?.code || 'error'}), so AI attribution was not judged.` };
            }
        }
        return verdict(counts);
    },

    _verdict: verdict,
};
