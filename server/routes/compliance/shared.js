/**
 * Compliance routes — shared helpers.
 *
 * Org resolution, the regulation/verification vocabulary the overview and the
 * evidence bundle both speak, the ISO control↔check index, the SoA evidence
 * writer, the clause 4–10 conformity builder and the lazy ISMS process store
 * accessors: everything more than one sub-router under routes/compliance/
 * needs.
 */

const crypto = require('crypto');
const complianceStore = require('../../stores/complianceStore');
const soaStore = require('../../stores/soaStore');
const ismsDocStore = require('../../stores/ismsDocStore');
const registry = require('../../compliance/registry');
const { orgScope } = require('../../auth/orgScope');

// The HOME org, read through auth/orgScope.js. 'default' is the single-tenant
// install's org key, not an error signal — see resolveOrgIdStrict for the
// routes that must not accept it.
async function resolveOrgId(req) {
    return (await orgScope(req)).homeOrgId || 'default';
}

// Regulation id → response/report key ('GDPR' → overview.gdpr etc.).
const REGULATION_KEY = { GDPR: 'gdpr', AIA: 'aia', ISO27001: 'iso' };

// Split the latest results by how each check is verified (see registry.js) so
// the UI can say "N verified automatically · M self-attested" instead of
// presenting attested declarations as verified facts.
function computeVerificationSummary(results) {
    const summary = {
        automated: { total: 0, pass: 0 },
        attestation: { total: 0, pass: 0 },
        hybrid: { total: 0, pass: 0 },
    };
    for (const r of results) {
        if (r.status === 'not_applicable') continue;
        const check = registry.get(r.check_id);
        const v = summary[check?.verification] ? check.verification : 'automated';
        summary[v].total++;
        if (r.status === 'pass') summary[v].pass++;
    }
    return summary;
}

// Strict org resolution for routes whose data is org-scoped by contract: a
// session without an organisation gets 403 `no_organisation` instead of the
// silent 'default' fallback resolveOrgId keeps for legacy callers.
async function resolveOrgIdStrict(req) {
    return (await orgScope(req)).homeOrgId;
}

// Express helper around resolveOrgIdStrict: sends the 403 and returns null
// when the org is missing, so handlers read `const orgId = await requireOrgId(req, res); if (!orgId) return;`.
async function requireOrgId(req, res) {
    const orgId = await resolveOrgIdStrict(req);
    if (!orgId) {
        res.status(403).json({ error: 'no_organisation' });
        return null;
    }
    return orgId;
}

// framework ref → [check ids] for one regulation code, over the generalised
// `check.frameworks[]` (home article + ISO controls + explicit extra tags). For
// ISO27001 this is the SoA join (control 'A.5.20' → checks that count for it);
// for every other regulation it answers "which checks cover Art. 21(2)(d)".
function checksByFrameworkRef(code = 'ISO27001') {
    const map = {};
    for (const c of registry.getAll()) {
        const tags = Array.isArray(c.frameworks) ? c.frameworks : [];
        const seen = new Set();
        for (const f of tags) {
            if (!f || f.regulation !== code || !f.ref || seen.has(f.ref)) continue;
            seen.add(f.ref);
            (map[f.ref] = map[f.ref] || []).push(c.id);
        }
        // Legacy ISO checks registered before frameworks[] existed keep working.
        if (code === 'ISO27001' && c.regulation === 'ISO27001' && Array.isArray(c.controls)) {
            for (const ref of c.controls) {
                if (seen.has(ref)) continue;
                seen.add(ref);
                (map[ref] = map[ref] || []).push(c.id);
            }
        }
    }
    return map;
}

// Old name kept as an alias — the SoA and audit-pack routers still import it.
function _isoChecksByControl() { return checksByFrameworkRef('ISO27001'); }

// Result rows whose check's HOME regulation is active for the org. A disabled
// framework's rows never surface (they are not run or persisted either — rows
// from before a disable are hidden the same way). Regulations the policy does
// not know (legacy rows of a deleted check) fall back to the row's own column.
async function activeResultsFilter(orgId, opts = {}) {
    const frameworkPolicy = require('../../compliance/frameworkPolicy');
    const active = await frameworkPolicy.activeRegulations(orgId, opts);
    return (row) => {
        if (!row) return false;
        const check = registry.get(row.check_id);
        const reg = check?.regulation || row.regulation || null;
        if (!reg) return true;
        return active.has(reg);
    };
}

// Clause 4–10 conformity pack — the Stage-1 deliverable. Collects what the
// tooling can PROVE per clause and says "not recorded" where it cannot; the
// ISMS process stores (risks, audits, reviews) plug in as they ship.
async function _buildClauseConformity(orgId) {
    const [docs, soaStats, latest, history, settings] = await Promise.all([
        ismsDocStore.listDocs(orgId).catch(() => []),
        soaStore.getStats(orgId).catch(() => null),
        complianceStore.getLatestPerCheck(orgId).catch(() => []),
        complianceStore.getScoreHistory(orgId, 365).catch(() => []),
        complianceStore.getSettings(orgId).catch(() => ({})),
    ]);
    const published = docs.filter(d => d.status === 'published');
    const doc = (slug) => published.find(d => d.slug === slug) || null;
    const lastRun = latest.length ? latest.reduce((m, r) => (r.run_at > m ? r.run_at : m), latest[0].run_at) : null;
    const operatingSince = history.length ? history[0].captured_at : null;
    const isoResults = latest.filter(r => r.regulation === 'ISO27001');

    // ISMS process stores land later in the ISO build; read them lazily so
    // this statement upgrades itself the moment they exist.
    let risks = [], audits = [], reviews = [], ncs = [];
    try { risks = await require('../../stores/riskStore').listRisks(orgId); } catch { /* not shipped yet */ }
    try {
        const auditStore = require('../../stores/isoAuditStore');
        audits = await auditStore.listAudits(orgId);
        reviews = await auditStore.listReviews(orgId);
        ncs = await auditStore.listNonconformities(orgId);
    } catch { /* not shipped yet */ }

    const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const clauses = [];
    const infosec = doc('information-security-policy');
    clauses.push({
        clause: '4', title: 'Context of the organisation',
        status: infosec ? 'partial' : 'not_recorded',
        evidence: infosec ? [`Scope and context described in the published Information Security Policy (v${infosec.current_version}).`] : [],
        gap: infosec ? 'Interested-parties analysis is maintained outside the tool.' : 'No published Information Security Policy yet.',
    });
    clauses.push({
        clause: '5', title: 'Leadership',
        status: infosec && infosec.owner_user_id ? 'in_place' : infosec ? 'partial' : 'not_recorded',
        evidence: [
            infosec ? `Information Security Policy published (v${infosec.current_version}, sha256-versioned).` : null,
            settings?.dpo_name ? `Privacy/security officer appointed: ${settings.dpo_name}.` : null,
        ].filter(Boolean),
        gap: infosec?.owner_user_id ? null : 'Assign a named owner to the Information Security Policy.',
    });
    const riskDoc = doc('risk-management');
    clauses.push({
        clause: '6', title: 'Planning (risk & opportunity, SoA, objectives)',
        status: (riskDoc && soaStats?.approved > 0 && risks.length) ? 'in_place'
            : (riskDoc || soaStats?.total > 0) ? 'partial' : 'not_recorded',
        evidence: [
            riskDoc ? `Risk methodology published (v${riskDoc.current_version}).` : null,
            soaStats?.total ? `Statement of Applicability: ${soaStats.approved}/${soaStats.total} rows approved, ${soaStats.excluded} excluded with justification.` : null,
            risks.length ? `Risk register: ${risks.length} risk(s) recorded with treatments.` : null,
        ].filter(Boolean),
        gap: risks.length ? null : 'Risk register not yet recorded in the tool.',
    });
    const totalAcks = published.reduce((s, d) => s + (d.ack_count || 0), 0);
    clauses.push({
        clause: '7', title: 'Support (awareness, competence, documented information)',
        status: published.length ? (totalAcks > 0 ? 'in_place' : 'partial') : 'not_recorded',
        evidence: [
            published.length ? `${published.length} controlled documents published with sha256-versioned history.` : null,
            totalAcks > 0 ? `${totalAcks} member acknowledgement(s) recorded against exact document versions.` : null,
        ].filter(Boolean),
        gap: totalAcks > 0 ? 'Competence records beyond acknowledgements are maintained per person.' : 'No member acknowledgements recorded yet.',
    });
    clauses.push({
        clause: '8', title: 'Operation',
        status: lastRun ? 'in_place' : 'not_recorded',
        evidence: [
            lastRun ? `Automated control checks operating — last full run ${fmtDate(lastRun)}.` : null,
            isoResults.length ? `${isoResults.length} ISO control check result(s) on record with hash-chained evidence.` : null,
        ].filter(Boolean),
        gap: lastRun ? null : 'No check runs recorded yet.',
    });
    clauses.push({
        clause: '9', title: 'Performance evaluation (monitoring, internal audit, management review)',
        status: (audits.length && reviews.length) ? 'in_place' : history.length ? 'partial' : 'not_recorded',
        evidence: [
            operatingSince ? `Continuous monitoring with score snapshots since ${fmtDate(operatingSince)} (${history.length} data points).` : null,
            audits.length ? `${audits.length} internal audit(s) recorded.` : null,
            reviews.length ? `${reviews.length} management review(s) recorded.` : null,
        ].filter(Boolean),
        gap: audits.length && reviews.length ? null : 'Internal audit and/or management review not yet recorded in the tool.',
    });
    clauses.push({
        clause: '10', title: 'Improvement (nonconformity & corrective action)',
        status: ncs.length ? 'in_place' : 'not_recorded',
        evidence: ncs.length ? [`${ncs.length} nonconformity record(s) with corrective-action tracking.`] : [],
        gap: ncs.length ? null : 'Nonconformity register not yet recorded in the tool.',
    });
    return clauses;
}

function _recordSoaEvidence(orgId, subjectId, payload) {
    return complianceStore.addEvidence({
        organization_id: orgId,
        check_id: null,
        subject_type: 'soa',
        subject_id: String(subjectId),
        hash: crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex'),
        payload,
    });
}

function _riskStore() { return require('../../stores/riskStore'); }
function _auditStore() { return require('../../stores/isoAuditStore'); }
function _obligationStore() { return require('../../stores/isoObligationStore'); }

module.exports = {
    resolveOrgId,
    resolveOrgIdStrict,
    requireOrgId,
    REGULATION_KEY,
    computeVerificationSummary,
    checksByFrameworkRef,
    activeResultsFilter,
    _isoChecksByControl,
    _buildClauseConformity,
    _recordSoaEvidence,
    _riskStore,
    _auditStore,
    _obligationStore,
};
