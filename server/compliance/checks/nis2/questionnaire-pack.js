/**
 * NIS2 Art. 21(2)(d) — supply-chain security, seen from the supplier side:
 * customers in NIS2 scope send supplier questionnaires, and the ISO evidence
 * bundle answers them when its ingredients exist.
 *
 * Ingredients (all read from the ISO 27001 registers):
 *   - published policies: supplier-security, incident-response,
 *     business-continuity, information-security-policy
 *   - a seeded Statement of Applicability (iso_soa_entries > 0)
 *   - a fresh check sweep (compliance_score_history ≤ 7 days old)
 *
 *   every ingredient present → pass
 *   an ingredient missing    → warn (names it)
 * This check NEVER fails: the absence of an export is not a control failure.
 * Evidence adds `last_bundle_export_at` from the evidence chain (the
 * evidence-bundle route stamps `action: 'evidence_bundle_exported'`; the older
 * `evidence_bundle_generated` SoA stamp is accepted too).
 *
 * ISO 27001: A.5.20 (supplier agreements). DORA Art. 30 (ICT third-party
 * contractual arrangements) for orgs that serve financial entities.
 */

const { getAll, getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const REQUIRED_SLUGS = ['supplier-security', 'incident-response', 'business-continuity', 'information-security-policy'];
const SWEEP_FRESH_DAYS = 7;
const BUNDLE_ACTIONS = ['evidence_bundle_exported', 'evidence_bundle_generated'];
const DAY = 86400 * 1000;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

function _iso(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

module.exports = {
    id: 'NIS2-Art21(2)(d)-questionnaire-pack',
    regulation: 'NIS2',
    article: 'Art. 21(2)(d)',
    frameworks: [
        { regulation: 'ISO27001', ref: 'A.5.20' },
        { regulation: 'DORA', ref: 'Art. 30' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_questionnaire_pack_title',
    descriptionKey: 'compliance.check_nis2_questionnaire_pack_desc',
    remediationKey: 'compliance.check_nis2_questionnaire_pack_fix',
    remediationLink: 'admin/compliance/soa',
    REQUIRED_SLUGS,
    BUNDLE_ACTIONS,
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        let docs;
        let facts;
        try {
            docs = await getAll(`
                SELECT slug FROM isms_documents
                WHERE organization_id = $1 AND status = 'published' AND current_version > 0 AND slug = ANY($2)
            `, [orgId, REQUIRED_SLUGS]);
            facts = await getOne(`
                SELECT
                    (SELECT COUNT(*)::int FROM iso_soa_entries WHERE organization_id = $1) AS soa_entries,
                    (SELECT MAX(captured_at) FROM compliance_score_history WHERE organization_id = $1) AS last_sweep_at,
                    (SELECT MAX(captured_at) FROM compliance_evidence
                      WHERE organization_id = $1 AND payload->>'action' = ANY($2)) AS last_bundle_export_at
            `, [orgId, BUNDLE_ACTIONS]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'The ISO 27001 registers (policies, SoA, sweeps) are not provisioned yet — open Compliance → Policies and → SoA once to seed them.',
                };
            }
            throw e;
        }

        const published = docs.map(d => d.slug);
        const policiesMissing = REQUIRED_SLUGS.filter(s => !published.includes(s));
        const soaEntries = Number(facts?.soa_entries) || 0;
        const lastSweepAt = _iso(facts?.last_sweep_at);
        const sweepAgeDays = lastSweepAt ? Math.floor((Date.now() - new Date(lastSweepAt).getTime()) / DAY) : null;
        const sweepFresh = sweepAgeDays !== null && sweepAgeDays <= SWEEP_FRESH_DAYS;
        const lastBundleExportAt = _iso(facts?.last_bundle_export_at);

        const missing = [];
        if (policiesMissing.length) missing.push(`published policies (${policiesMissing.join(', ')})`);
        if (soaEntries === 0) missing.push('a seeded Statement of Applicability');
        if (!sweepFresh) missing.push(lastSweepAt ? `a fresh check sweep (last one ${sweepAgeDays} days ago)` : 'a first check sweep');

        const evidence = {
            required_policies: REQUIRED_SLUGS,
            policies_published: published,
            policies_missing: policiesMissing,
            soa_entries: soaEntries,
            soa_seeded: soaEntries > 0,
            last_sweep_at: lastSweepAt,
            sweep_age_days: sweepAgeDays,
            sweep_fresh: sweepFresh,
            sweep_fresh_days: SWEEP_FRESH_DAYS,
            last_bundle_export_at: lastBundleExportAt,
            ingredients_missing: missing.length,
        };

        if (missing.length) {
            return {
                status: 'warn',
                evidence,
                details: `The supplier questionnaire pack is incomplete — missing ${missing.join('; ')}.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: lastBundleExportAt
                ? `Questionnaire pack ready: ${REQUIRED_SLUGS.length} policies published, SoA seeded (${soaEntries} controls), sweep ${sweepAgeDays} day(s) old; evidence bundle last exported ${lastBundleExportAt.slice(0, 10)}.`
                : `Questionnaire pack ready: ${REQUIRED_SLUGS.length} policies published, SoA seeded (${soaEntries} controls), sweep ${sweepAgeDays} day(s) old. The evidence bundle has not been exported yet.`,
        };
    },
};
