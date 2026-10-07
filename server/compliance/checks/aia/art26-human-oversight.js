/**
 * EU AI Act Art. 26 — deployer obligations: human oversight for high-risk use
 * (applies with Annex III from 2 Dec 2027, Regulation (EU) 2026/1744).
 *
 * Per-source over the same high-risk agent population as GDPR Art. 35 (shared
 * heuristic — see art35-dpia-high-risk.js). A subject passes when its current
 * DPIA names WHO oversees the agent output (answers.human_oversight); a
 * current DPIA without that answer warns, a missing or expired one fails.
 *
 * The list is the WHOLE high-risk population (art35._highRiskAgents throws on
 * a failed read instead of answering []), so the check retires the slot of an
 * agent that left it (retiresVanished) instead of keeping its last fail or
 * warn in the table, the rail and the score for good.
 */

const dpiaStore = require('../../../stores/dpiaStore');
const art35 = require('../gdpr/art35-dpia-high-risk');

module.exports = {
    id: 'AIA-Art26-human-oversight',
    regulation: 'AIA',
    article: '26',
    severity: 'high',
    scope: 'per-source',
    verification: 'attestation',
    titleKey: 'compliance.checks.aia_art26.title',
    descriptionKey: 'compliance.checks.aia_art26.desc',
    remediationKey: 'compliance.checks.aia_art26.fix',
    remediationLink: 'admin/compliance/dpia',

    retiresVanished: true,
    retiredDetails: 'No longer flagged as a high-risk agent, unpublished or deleted.',

    async listSubjects(orgId) {
        return art35._highRiskAgents(orgId);
    },

    async evaluate(orgId, subject) {
        if (!subject?.id) {
            return { status: 'not_applicable', evidence: {}, details: 'No high-risk agent to assess.' };
        }
        const dpia = await dpiaStore.getLatestForAgent(orgId, subject.id);
        const evidence = {
            agent_id: subject.id, agent_name: subject.label, risk_reason: subject.risk_reason,
            dpia_mode: dpia?.mode || null,
        };
        if (!dpia || !dpiaStore.isCurrent(dpia)) {
            return {
                status: 'fail',
                evidence,
                details: `No current assessment for "${subject.label}" — record who oversees its output (Compliance → DPIA questionnaire, "Human oversight").`,
            };
        }
        const answers = dpia.answers && typeof dpia.answers === 'object' ? dpia.answers : {};
        // A string only: the DPIA route accepts any JSON value, and `true` or
        // `{}` stringify to "true" / "[object Object]", which is not a person.
        const oversight = typeof answers.human_oversight === 'string' ? answers.human_oversight.trim() : '';
        if (!oversight) {
            return {
                status: 'warn',
                evidence,
                details: `"${subject.label}" has a DPIA but no named human oversight. Art. 26(2) requires assigning oversight to people with the competence and authority to intervene.`,
            };
        }
        return {
            status: 'pass',
            // The answer itself usually names a person ("Recruiter Jan checks
            // every result"); the evidence chain keeps only that one exists.
            evidence: { ...evidence, human_oversight_recorded: true },
            details: `Human oversight recorded for "${subject.label}" (see its DPIA).`,
        };
    },
};
