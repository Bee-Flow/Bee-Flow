// @typecheck
'use strict';

/**
 * GDPR Art. 32 — project files the Privacy Shield could not check.
 *
 * A file uploaded into a project is scanned for personal data on the way in
 * (core/kb/ingestPrivacy.js). When the detector was not installed or could not
 * finish, the file is kept and marked `unscanned` — honestly, because "we did
 * not look" is not "it is clean". A knowledge-base source has a next refresh
 * that tries again; an upload does not, so without this check such a file
 * stays unscanned for good while every member's AI chats can quote it.
 *
 *   not_applicable  the shield is off (GDPR-Art32-dlp-enabled already says
 *                   so — counting it twice would double the penalty) or the
 *                   organisation has no project files
 *   warn            project files that were never checked
 *   pass            every project file was checked
 *
 * Auto-fix `project_files_rescan` runs the ingest scan again for a bounded
 * batch of those files, on the guard's bulk lane, and re-stores what the
 * policy allows — the same path an upload takes. Metadata only in the check;
 * ids and counts in evidence.
 */

const pd = require('../../projects/projectData');
const { errorShape, errorLabel } = require('../../lib/errorShape');

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');
const RESCAN_BATCH = 25;

const FILES_FROM = `
    FROM projects p
    JOIN knowledge_bases kb ON kb.id::text = p.files_kb_id
    JOIN documents d ON d.knowledge_base_id = kb.id
    WHERE ${ORG} AND ${WS} AND kb.source_kind = 'project_files'
      AND d.status IN ('processed', 'redacted')`;

const TOTAL_SQL = `SELECT COUNT(*)::int AS n ${FILES_FROM}`;
const UNSCANNED_SQL = `
    SELECT p.id AS project_id, COUNT(*)::int AS n
    ${FILES_FROM} AND d.pii_status = 'unscanned'
    GROUP BY p.id
    ORDER BY n DESC, p.id
    LIMIT ${pd.ROW_LIMIT}`;
const RESCAN_SQL = `
    SELECT d.id AS document_id, d.title, kb.id AS kb_id, kb.tenant_id, kb.organization_id, p.id AS project_id
    ${FILES_FROM} AND d.pii_status = 'unscanned'
      AND ($2::text IS NULL OR p.id = $2)
    ORDER BY d.id
    LIMIT ${RESCAN_BATCH}`;

function defaultDeps() {
    return {
        query: pd.defaultQuery(),
        shieldScansFiles: async (orgId) => {
            const { resolveShieldFor } = require('../../../core/privacy/orgShield');
            const { scanEnabledFor } = require('../../../core/kb/ingestPrivacy');
            return scanEnabledFor(await resolveShieldFor({ orgId: orgId === pd.NO_ORG_ORG_ID ? null : orgId, userId: null }));
        },
        rescan: (row) => rescanDocument(row),
    };
}

/** Re-run the ingest scan for one stored file and store what the policy allows. */
async function rescanDocument(row) {
    const kbStore = require('../../../stores/knowledgeBases');
    const ingestPrivacy = require('../../../core/kb/ingestPrivacy');
    const helpers = require('../../../core/kb/kbIngestionHelpers');
    const text = await kbStore.getDocumentOriginalContent(row.document_id);
    if (!text || !String(text).trim()) return 'skipped';
    const verdict = await ingestPrivacy.applyShield({
        orgId: row.organization_id || null, userId: null, text, filename: row.title || 'document',
    });
    if (verdict.piiStatus === 'unscanned') return 'still_unscanned';
    if (verdict.outcome === ingestPrivacy.OUTCOME.SKIPPED) {
        await helpers.purgeDocumentChunks(row.kb_id, row.document_id, row.tenant_id).catch(() => {});
        await kbStore.replaceDocumentContent(row.document_id, {
            status: 'skipped', statusReason: verdict.reason, chunkCount: 0,
            piiStatus: verdict.piiStatus, piiCategories: verdict.piiCategories,
        });
        return 'withheld';
    }
    if (verdict.outcome === ingestPrivacy.OUTCOME.REDACTED || verdict.text !== text) {
        await helpers.reingestDocument(row.tenant_id, row.kb_id, row.document_id, verdict.text, {
            onFailure: 'record',
            status: verdict.outcome === ingestPrivacy.OUTCOME.REDACTED ? 'redacted' : 'processed',
            piiStatus: verdict.piiStatus,
            piiCategories: verdict.piiCategories,
        });
        return 'redacted';
    }
    await kbStore.replaceDocumentContent(row.document_id, { piiStatus: verdict.piiStatus, piiCategories: verdict.piiCategories });
    return 'checked';
}

/** Pure verdict. */
function verdict({ shieldOn, total, perProject }) {
    if (!shieldOn) {
        return {
            status: 'not_applicable',
            evidence: { shield: false },
            details: 'The Privacy Shield is off, so project files are not scanned; GDPR-Art32-dlp-enabled reports that.',
        };
    }
    if (!total) return { status: 'not_applicable', evidence: { shield: true, files: 0 }, details: 'No project holds files yet.' };
    const offenders = (perProject || []).map(r => ({ project_id: String(r.project_id), unscanned: Number(r.n) || 0 }))
        .filter(o => o.unscanned > 0);
    const unscanned = offenders.reduce((n, o) => n + o.unscanned, 0);
    const evidence = {
        shield: true,
        files: total,
        unscanned,
        projects_affected: offenders.length,
        offenders: offenders.slice(0, pd.MAX_OFFENDERS).map(o => ({ ...o, link: pd.projectLink(o.project_id, 'knowledge') })),
        offenders_truncated: offenders.length > pd.MAX_OFFENDERS,
        link: offenders.length === 1 ? pd.projectLink(offenders[0].project_id, 'knowledge') : null,
    };
    if (unscanned > 0) {
        return {
            status: 'warn',
            evidence,
            details: `${unscanned} of ${total} project file(s) in ${offenders.length} project(s) were never checked for personal data: ${pd.nameOffenders(offenders.map(o => o.project_id))}. Run the automatic fix to scan them again.`,
        };
    }
    return { status: 'pass', evidence, details: `All ${total} project file(s) were checked for personal data when they were uploaded.` };
}

module.exports = {
    id: 'GDPR-Art32-project-files-unscanned',
    regulation: 'GDPR',
    article: '32',
    frameworks: [{ regulation: 'ISO27001', ref: 'A.8.12' }],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    projectCheck: true,
    titleKey: 'compliance.checks.gdpr_project_files_unscanned.title',
    descriptionKey: 'compliance.checks.gdpr_project_files_unscanned.desc',
    remediationKey: 'compliance.checks.gdpr_project_files_unscanned.fix',
    remediationLink: 'admin/compliance/gdpr',
    autoFixId: 'project_files_rescan',

    fingerprintOf(evidence) {
        const offenders = Array.isArray(evidence?.offenders) ? evidence.offenders : [];
        return offenders.map(o => o.project_id).sort();
    },

    async evaluate(orgId, _subject, deps = defaultDeps()) {
        let shieldOn;
        try {
            shieldOn = await deps.shieldScansFiles(orgId);
        } catch (e) {
            // Class and code only: a driver message can quote values (lib/errorShape.js).
            return { status: 'warn', evidence: { error: 'shield_unreadable', sql_state: errorShape(e).code }, details: `The Privacy Shield settings could not be read (${errorLabel(e)}), so project files were not judged.` };
        }
        if (!shieldOn) return verdict({ shieldOn: false, total: 0, perProject: [] });
        try {
            const total = Number((await deps.query(TOTAL_SQL, [orgId]))?.[0]?.n) || 0;
            const perProject = total ? await deps.query(UNSCANNED_SQL, [orgId]) : [];
            return verdict({ shieldOn: true, total, perProject });
        } catch (e) {
            if (pd.isNotProvisioned(e)) {
                return { status: 'not_applicable', evidence: { reason: 'not_provisioned' }, details: 'Project files are not set up on this installation yet.' };
            }
            return { status: 'warn', evidence: { error: 'unreadable', sql_state: e?.code || null }, details: `Project files could not be read (${e?.code || 'error'}), so they were not judged.` };
        }
    },

    async autoFix(orgId, { subjectId = null } = {}, deps = defaultDeps()) {
        const projectId = subjectId ? pd.projectIdOf(subjectId) : null;
        const rows = await deps.query(RESCAN_SQL, [orgId, projectId]);
        const outcome = { checked: 0, redacted: 0, withheld: 0, still_unscanned: 0, skipped: 0, failed: 0 };
        for (const row of rows || []) {
            try {
                const r = await deps.rescan(row);
                outcome[r in outcome ? r : 'checked']++;
            } catch {
                outcome.failed++;
            }
        }
        const done = outcome.checked + outcome.redacted + outcome.withheld;
        return {
            changed: done,
            ...outcome,
            batch: RESCAN_BATCH,
            summary: `Scanned ${done} of ${(rows || []).length} project file(s) again${outcome.still_unscanned ? `; ${outcome.still_unscanned} still could not be checked` : ''}.`,
        };
    },

    _verdict: verdict,
    RESCAN_BATCH,
};
