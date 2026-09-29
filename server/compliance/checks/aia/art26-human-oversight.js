/**
 * EU AI Act Art. 26 — deployer obligations: human oversight for high-risk use
 * (obligations phasing in from Aug 2026).
 *
 * Per-source over the same high-risk agent population as GDPR Art. 35 (shared
 * heuristic — see art35-dpia-high-risk.js). A subject passes when its current
 * DPIA questionnaire names WHO oversees the agent's output
 * (answers.human_oversight); attestation-mode DPIAs without that answer warn.
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
        const oversight = String(answers.human_oversight || '').trim();
        if (!oversight) {
            return {
                status: 'warn',
                evidence,
                details: `"${subject.label}" has a DPIA but no named human oversight. Art. 26(2) requires assigning oversight to people with the competence and authority to intervene.`,
            };
        }
        return {
            status: 'pass',
            evidence: { ...evidence, human_oversight: oversight },
            details: `Human oversight recorded for "${subject.label}": ${oversight}`,
        };
    },
};
