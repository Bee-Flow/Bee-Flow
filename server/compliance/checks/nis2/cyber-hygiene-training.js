/**
 * NIS2 Art. 21(2)(g) + Art. 20(2) — basic cyber-hygiene practices and
 * cybersecurity training.
 *
 * Population: the organisation's members (users with an e-mail address, the
 * platform root row excluded, suspended accounts excluded — the same directory
 * the ISO training page shows). A member counts as covered when EITHER
 *   - they acknowledged the CURRENT published version of both
 *     `acceptable-use` and `information-security-policy`, OR
 *   - a `training_attest` evidence row for them is at most 365 days old.
 *
 *   either policy unpublished     → fail (nothing to acknowledge)
 *   coverage ≥ 90 %               → pass
 *   60 % ≤ coverage < 90 %        → warn
 *   coverage < 60 %               → fail
 *   no members                    → not_applicable
 *
 * Evidence carries counts only — no user ids, no e-mail addresses.
 * ISO 27001: clauses 7.2/7.3 (competence, awareness), A.6.3 (awareness training).
 */

const { getAll, getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const REQUIRED_SLUGS = ['acceptable-use', 'information-security-policy'];
const ATTEST_MAX_DAYS = 365;
const PASS_PCT = 90;
const WARN_PCT = 60;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

module.exports = {
    id: 'NIS2-Art21(2)(g)-cyber-hygiene-training',
    regulation: 'NIS2',
    article: 'Art. 21(2)(g)',
    frameworks: [
        { regulation: 'NIS2', ref: 'Art. 20(2)' },
        { regulation: 'ISO27001', ref: 'cl. 7.2' },
        { regulation: 'ISO27001', ref: 'cl. 7.3' },
        { regulation: 'ISO27001', ref: 'A.6.3' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_training_title',
    descriptionKey: 'compliance.check_nis2_training_desc',
    remediationKey: 'compliance.check_nis2_training_fix',
    remediationLink: 'admin/compliance/training',
    REQUIRED_SLUGS,
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
        let coverage;
        try {
            docs = await getAll(`
                SELECT slug, status, current_version
                FROM isms_documents
                WHERE organization_id = $1 AND slug = ANY($2)
            `, [orgId, REQUIRED_SLUGS]);
            coverage = await getOne(`
                SELECT COUNT(*)::int AS population,
                       COUNT(*) FILTER (WHERE acks = $3)::int AS covered_by_acks,
                       COUNT(*) FILTER (WHERE attested)::int AS covered_by_attest,
                       COUNT(*) FILTER (WHERE acks = $3 OR attested)::int AS covered
                FROM (
                    SELECT u.id,
                           (SELECT COUNT(DISTINCT a.slug)::int
                              FROM isms_acknowledgements a
                              JOIN isms_documents d
                                ON d.organization_id = a.organization_id
                               AND d.slug = a.slug
                               AND d.current_version = a.version
                               AND d.status = 'published'
                             WHERE a.organization_id = $1
                               AND a.user_id = u.id
                               AND a.slug = ANY($2)) AS acks,
                           EXISTS (SELECT 1 FROM compliance_evidence e
                                    WHERE e.organization_id = $1
                                      AND e.subject_type = 'training_attest'
                                      AND e.subject_id = u.id
                                      AND e.captured_at >= NOW() - ($4 || ' days')::interval) AS attested
                    FROM users u
                    WHERE u."organizationId" = $1
                      AND u.email IS NOT NULL AND u.email <> ''
                      AND u.id <> 'admin'
                      AND COALESCE(u.status, 'active') <> 'suspended'
                ) m
            `, [orgId, REQUIRED_SLUGS, REQUIRED_SLUGS.length, String(ATTEST_MAX_DAYS)]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'The policy acknowledgement ledger is not provisioned yet — open Compliance → Policies once to seed it.',
                };
            }
            throw e;
        }

        const published = docs
            .filter(d => d.status === 'published' && Number(d.current_version) > 0)
            .map(d => d.slug);
        const unpublished = REQUIRED_SLUGS.filter(s => !published.includes(s));

        const population = Number(coverage?.population) || 0;
        const covered = Number(coverage?.covered) || 0;
        const pct = population ? Math.round((covered / population) * 100) : null;

        const evidence = {
            required_policies: REQUIRED_SLUGS,
            policies_unpublished: unpublished,
            population,
            covered,
            covered_by_policy_acks: Number(coverage?.covered_by_acks) || 0,
            covered_by_training_attest: Number(coverage?.covered_by_attest) || 0,
            coverage_pct: pct,
            attest_max_days: ATTEST_MAX_DAYS,
            thresholds: { pass_pct: PASS_PCT, warn_pct: WARN_PCT },
        };

        if (population === 0) {
            return { status: 'not_applicable', evidence, details: 'No organisation members to train.' };
        }
        if (unpublished.length) {
            return {
                status: 'fail',
                evidence,
                details: `The ${unpublished.join(' and ')} polic${unpublished.length > 1 ? 'ies are' : 'y is'} not published — staff cannot acknowledge what does not exist. ${covered} of ${population} member(s) are covered by an external training attestation alone.`,
            };
        }
        if (pct >= PASS_PCT) {
            return {
                status: 'pass',
                evidence,
                details: `${covered} of ${population} member(s) (${pct} %) acknowledged the current policies or hold a training attestation from the last ${ATTEST_MAX_DAYS} days.`,
            };
        }
        if (pct >= WARN_PCT) {
            return {
                status: 'warn',
                evidence,
                details: `${covered} of ${population} member(s) (${pct} %) are covered — below the ${PASS_PCT} % target. Chase the remaining acknowledgements or record their training.`,
            };
        }
        return {
            status: 'fail',
            evidence,
            details: `Only ${covered} of ${population} member(s) (${pct} %) acknowledged the security policies or completed training — basic cyber hygiene is not demonstrable.`,
        };
    },
};
