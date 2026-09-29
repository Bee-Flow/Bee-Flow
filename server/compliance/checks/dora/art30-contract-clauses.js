/**
 * DORA Art. 30(2)(3) — contractual provisions with financial entities.
 *
 * Contracts between a financial entity and its ICT provider must contain the
 * Art. 30 provisions: a full description of the services, the locations where
 * data is processed, service levels, incident assistance, cooperation with
 * the supervisors, audit and access rights, termination and exit support.
 * The platform cannot read the contracts, so this is an ANNUAL ATTESTATION
 * (same stance as AIA Art. 4): an admin confirms the contract template
 * covers Art. 30 and may link the template.
 *
 *   no attestation on record        → fail
 *   attestation older than 365 days → warn (contracts and the RTS move)
 *   attested within the year        → pass
 *
 * Relevance: `framework_relevance.dora` 'not_relevant' → not_applicable;
 * 'unknown' → the check runs and the details say the Frameworks card asks.
 *
 * Evidence: the attestation date, its age, whether a template is linked
 * (the URL itself, which is a document location, not a person) and whether
 * an attester was recorded — never who.
 */

const complianceStore = require('../../../stores/complianceStore');

const WINDOW_DAYS = 365;
const DAY_MS = 86400e3;

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    const v = rel && typeof rel === 'object' ? rel.dora : undefined;
    return v === 'not_relevant' || v === 'relevant' ? v : 'unknown';
}

function _ts(value) {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

/** Only an http(s) URL is echoed into the evidence; anything else is recorded as "linked". */
function _templateUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const s = value.trim();
    return /^https?:\/\//i.test(s) && !/@/.test(s) ? s.slice(0, 300) : 'linked';
}

module.exports = {
    id: 'DORA-Art30-contract-clauses',
    regulation: 'DORA',
    article: 'Art. 30(2)',
    frameworks: [],
    severity: 'medium',
    scope: 'global',
    verification: 'attestation',
    titleKey: 'compliance.check_dora_contract_clauses_title',
    descriptionKey: 'compliance.check_dora_contract_clauses_desc',
    remediationKey: 'compliance.check_dora_contract_clauses_fix',
    remediationLink: 'admin/compliance/settings',

    async evaluate(orgId) {
        const settings = (await complianceStore.getSettings(orgId)) || {};
        const relevance = _relevance(settings);
        if (relevance === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'DORA is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }
        const relevanceNote = relevance === 'unknown'
            ? ' DORA relevance is still unanswered — the Frameworks card asks whether you provide ICT services to financial entities.'
            : '';

        const confirmedAt = _ts(settings.dora_contract_clauses_confirmed_at);
        const ageDays = confirmedAt === null ? null : Math.floor((Date.now() - confirmedAt) / DAY_MS);
        const evidence = {
            relevance,
            confirmed_at: confirmedAt === null ? null : new Date(confirmedAt).toISOString(),
            age_days: ageDays,
            window_days: WINDOW_DAYS,
            confirmed_by_recorded: typeof settings.dora_contract_clauses_confirmed_by === 'string' && settings.dora_contract_clauses_confirmed_by.trim().length > 0,
            template_url: _templateUrl(settings.dora_contract_template_url),
        };

        if (confirmedAt === null) {
            return {
                status: 'fail',
                evidence,
                details: 'No attestation that your contracts with financial entities contain the DORA Art. 30 provisions (service description, processing locations, service levels, incident assistance, audit and access rights, termination and exit). Confirm your contract template under Compliance → Settings → DORA.' + relevanceNote,
            };
        }
        if (ageDays > WINDOW_DAYS) {
            return {
                status: 'warn',
                evidence,
                details: `The Art. 30 contract-clauses attestation is ${ageDays} days old — re-confirm annually: contract templates and the supervisory technical standards change.` + relevanceNote,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Art. 30 contract provisions attested ${ageDays} day(s) ago${evidence.template_url ? ' (contract template linked)' : ''}.` + relevanceNote,
        };
    },
};

module.exports._test = { WINDOW_DAYS, _templateUrl };
