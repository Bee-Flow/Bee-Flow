/**
 * DORA Art. 28(3) — the register of information on ICT third-party
 * arrangements.
 *
 * A financial entity must keep (and its ICT providers must be able to hand
 * over) a register of every ICT third-party arrangement: who, where, how
 * critical, under which contract. Nothing is typed twice here — the register
 * is DERIVED:
 *
 *   ROWS    — lib/observedOperators.collect(): every third party this
 *             workspace actually talks to (outbound ledger 30 d ∪ configured
 *             connections ∪ third-party AI providers). The same numbers the
 *             GDPR Art. 28 and ISO A.5.20 checks reconcile against.
 *   COLUMNS — the per-operator attestation entries in
 *             settings.scc_confirmed_operators, read-only, extended shape:
 *             { operator, attested_at, contract_ref?, critical?, country? }.
 *
 *   nothing observed                                   → not_applicable
 *   operators observed, none attested                  → fail  (no register)
 *   some unattested, or attested without contract_ref
 *     / criticality                                    → warn  (names them)
 *   every observed operator attested with contract_ref
 *     and a criticality flag                           → pass
 *
 * The evidence IS the register — [{operator, country, is_eu, critical,
 * contract_ref, calls_30d, connections, sources, attested_at}] — so the ROPA
 * processors view and the JSON export can render it straight from the
 * evidence row. Operators are companies, counts are counts, contract_ref is
 * a document reference: no attester id, no personal data (BFSF-441).
 *
 * Relevance: `framework_relevance.dora` 'not_relevant' → not_applicable;
 * 'unknown' → the check runs and the details say the Frameworks card asks.
 */

const complianceStore = require('../../../stores/complianceStore');
const observedOperators = require('../../lib/observedOperators');

function _relevance(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    const v = rel && typeof rel === 'object' ? rel.dora : undefined;
    return v === 'not_relevant' || v === 'relevant' ? v : 'unknown';
}

function _asArray(value) {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
    return Array.isArray(v) ? v : [];
}

function _str(v, max = 120) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Attestation entries keyed on the canonical operator name; later entries win. */
function _attestations(settings) {
    const map = new Map();
    for (const e of _asArray(settings.scc_confirmed_operators)) {
        if (!e || typeof e !== 'object') continue;
        const key = observedOperators.canonical(e.operator);
        if (!key) continue;
        map.set(key, {
            attested_at: _str(e.attested_at, 40),
            contract_ref: _str(e.contract_ref),
            critical: typeof e.critical === 'boolean' ? e.critical : null,
            country: _str(e.country, 8) ? _str(e.country, 8).toUpperCase() : null,
        });
    }
    return map;
}

const EU_EEA = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
    'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

module.exports = {
    id: 'DORA-Art28(3)-register-of-information',
    regulation: 'DORA',
    article: 'Art. 28(3)',
    frameworks: [
        { regulation: 'GDPR', ref: 'Art. 28' },
        { regulation: 'ISO27001', ref: 'A.5.20' },
        { regulation: 'NIS2', ref: 'Art. 21(2)(d)' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_dora_register_title',
    descriptionKey: 'compliance.check_dora_register_desc',
    remediationKey: 'compliance.check_dora_register_fix',
    remediationLink: 'admin/compliance/ropa',

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

        const observed = await observedOperators.collect(orgId);
        const attestations = _attestations(settings);

        const register = observed.operators.map(o => {
            const a = attestations.get(o.key) || null;
            const country = (a && a.country) || o.country_code || null;
            const isEu = o.is_eu !== null ? o.is_eu : (country ? EU_EEA.has(country) : null);
            return {
                operator: o.operator,
                country,
                is_eu: isEu,
                critical: a ? a.critical : null,
                contract_ref: a ? a.contract_ref : null,
                calls_30d: o.calls_30d,
                connections: o.connections,
                sources: o.sources,
                attested: !!a,
                attested_at: a ? a.attested_at : null,
            };
        });

        const evidence = {
            relevance,
            window_days: observed.window_days,
            ledger_available: observed.ledger_available,
            operators_total: register.length,
            attested_count: register.filter(r => r.attested).length,
            complete_count: register.filter(r => r.attested && r.contract_ref && r.critical !== null).length,
            unattested: register.filter(r => !r.attested).map(r => r.operator),
            missing_contract_ref: register.filter(r => r.attested && !r.contract_ref).map(r => r.operator),
            missing_criticality: register.filter(r => r.attested && r.critical === null).map(r => r.operator),
            critical_count: register.filter(r => r.critical === true).length,
            non_eu_count: register.filter(r => r.is_eu === false).length,
            register,
        };

        if (register.length === 0) {
            return {
                status: 'not_applicable',
                evidence,
                details: (observed.ledger_available
                    ? 'No ICT third-party arrangement observed: no outbound traffic in the last 30 days, no configured connection and no third-party AI provider.'
                    : 'No outbound activity ledger yet and no configured connection or third-party AI provider — nothing to register.')
                    + relevanceNote,
            };
        }
        if (evidence.attested_count === 0) {
            return {
                status: 'fail',
                evidence,
                details: `${register.length} ICT third-party provider(s) observed (${evidence.unattested.join(', ')}) but none is recorded in the register. Art. 28(3) requires a register of every ICT arrangement with contract reference and criticality — confirm each operator under Compliance → ROPA.` + relevanceNote,
            };
        }
        const gaps = [];
        if (evidence.unattested.length) gaps.push(`${evidence.unattested.length} observed operator(s) are not in the register (${evidence.unattested.join(', ')})`);
        if (evidence.missing_contract_ref.length) gaps.push(`${evidence.missing_contract_ref.length} lack a contract reference (${evidence.missing_contract_ref.join(', ')})`);
        if (evidence.missing_criticality.length) gaps.push(`${evidence.missing_criticality.length} lack a criticality flag (${evidence.missing_criticality.join(', ')})`);
        if (gaps.length) {
            return {
                status: 'warn',
                evidence,
                details: `Register of information incomplete: ${gaps.join('; ')}. Complete contract reference, country and criticality per operator under Compliance → ROPA.` + relevanceNote,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Register of information complete: ${register.length} ICT third-party provider(s), ${evidence.critical_count} marked critical, ${evidence.non_eu_count} outside the EU/EEA, each with a contract reference.` + relevanceNote,
        };
    },
};

module.exports._test = { _attestations, EU_EEA };
