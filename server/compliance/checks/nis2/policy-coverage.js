/**
 * NIS2 Art. 21(2)(a)–(j) — every risk-management measure is backed by a
 * published, current security policy.
 *
 * The ten measures are mapped onto the ISMS policy set (compliance/iso/
 * policySeeds.js slugs). A measure is covered when every mapped policy is
 * published; a covered measure degrades to "overdue" when one of its policies
 * has a review_due_at in the past.
 *
 *   ≥1 measure with an unpublished policy  → fail
 *   all published, ≥1 review overdue        → warn
 *   all published and current               → pass
 *
 * ISO 27001: A.5.1 (policies) and clause 7.5 (documented information).
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const LETTER_SLUGS = Object.freeze({
    a: ['risk-management', 'information-security-policy'],
    b: ['incident-response'],
    c: ['business-continuity'],
    d: ['supplier-security'],
    e: ['secure-development'],
    f: ['logging-monitoring'],
    g: ['acceptable-use'],
    h: ['cryptography'],
    i: ['hr-security', 'access-control', 'asset-management'],
    j: ['access-control'],
});
const ALL_SLUGS = Array.from(new Set(Object.values(LETTER_SLUGS).flat()));
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

module.exports = {
    id: 'NIS2-Art21(2)-policy-coverage',
    regulation: 'NIS2',
    article: 'Art. 21(2)',
    frameworks: [
        { regulation: 'ISO27001', ref: 'A.5.1' },
        { regulation: 'ISO27001', ref: 'cl. 7.5' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_policy_coverage_title',
    descriptionKey: 'compliance.check_nis2_policy_coverage_desc',
    remediationKey: 'compliance.check_nis2_policy_coverage_fix',
    remediationLink: 'admin/compliance/policies',
    LETTER_SLUGS,
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
        try {
            docs = await getAll(`
                SELECT slug, status, current_version, review_due_at
                FROM isms_documents
                WHERE organization_id = $1 AND slug = ANY($2)
            `, [orgId, ALL_SLUGS]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'The ISMS policy register is not provisioned yet — open Compliance → Policies once to seed it.',
                };
            }
            throw e;
        }

        const now = Date.now();
        const bySlug = new Map(docs.map(d => [d.slug, d]));
        const matrix = {};
        const lettersMissing = [];
        const lettersOverdue = [];
        for (const [letter, slugs] of Object.entries(LETTER_SLUGS)) {
            const published = [];
            const missing = [];
            const overdue = [];
            for (const slug of slugs) {
                const d = bySlug.get(slug);
                const isPublished = !!d && d.status === 'published' && Number(d.current_version) > 0;
                if (!isPublished) { missing.push(slug); continue; }
                published.push(slug);
                const due = d.review_due_at ? new Date(d.review_due_at).getTime() : NaN;
                if (Number.isFinite(due) && due < now) overdue.push(slug);
            }
            const covered = missing.length === 0;
            matrix[letter] = { slugs, published, missing, overdue, covered, current: covered && overdue.length === 0 };
            if (!covered) lettersMissing.push(letter);
            else if (overdue.length) lettersOverdue.push(letter);
        }

        const evidence = {
            measures_total: Object.keys(LETTER_SLUGS).length,
            measures_covered: Object.keys(LETTER_SLUGS).length - lettersMissing.length,
            letters_missing: lettersMissing,
            letters_overdue: lettersOverdue,
            policies_missing: Array.from(new Set(lettersMissing.flatMap(l => matrix[l].missing))),
            policies_overdue: Array.from(new Set(lettersOverdue.flatMap(l => matrix[l].overdue))),
            matrix,
        };

        if (lettersMissing.length) {
            return {
                status: 'fail',
                evidence,
                details: `${lettersMissing.length} of 10 Art. 21(2) measures (${lettersMissing.map(l => `(${l})`).join(', ')}) have no published policy behind them — missing: ${evidence.policies_missing.join(', ')}.`,
            };
        }
        if (lettersOverdue.length) {
            return {
                status: 'warn',
                evidence,
                details: `Every measure has a published policy, but ${evidence.policies_overdue.length} policy review(s) are overdue (${evidence.policies_overdue.join(', ')}) — measures ${lettersOverdue.map(l => `(${l})`).join(', ')}.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: 'All ten Art. 21(2) measures are backed by a published, current policy.',
        };
    },
};
