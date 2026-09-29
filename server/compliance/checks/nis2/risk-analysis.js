/**
 * NIS2 Art. 21(2)(a) — a maintained risk analysis.
 *
 * Reads the ISO 27001 risk register (iso_risks + iso_risk_treatments). Signals:
 *   - no risks at all                                        → fail
 *   - an open/treating risk scored ≥ HIGH_SCORE without any treatment → warn
 *   - a non-closed risk whose review_due_at has passed        → warn
 *   - otherwise                                               → pass
 *
 * Score = likelihood × impact on the 1–5 scales (computed by riskStore).
 * ISO 27001: clause 6.1.2 (risk assessment), A.5.7 (threat intelligence).
 */

const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const HIGH_SCORE = 12;
const OPEN_STATUSES = new Set(['open', 'treating']);
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

module.exports = {
    id: 'NIS2-Art21(2)(a)-risk-analysis',
    regulation: 'NIS2',
    article: 'Art. 21(2)(a)',
    frameworks: [
        { regulation: 'ISO27001', ref: 'cl. 6.1.2' },
        { regulation: 'ISO27001', ref: 'A.5.7' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_risk_analysis_title',
    descriptionKey: 'compliance.check_nis2_risk_analysis_desc',
    remediationKey: 'compliance.check_nis2_risk_analysis_fix',
    remediationLink: 'admin/compliance/risks',
    HIGH_SCORE,
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        let risks;
        try {
            risks = await getAll(`
                SELECT r.id, r.status, r.score, r.review_due_at,
                       (r.owner_user_id IS NOT NULL) AS has_owner,
                       (SELECT COUNT(*)::int FROM iso_risk_treatments t
                         WHERE t.organization_id = r.organization_id AND t.risk_id = r.id) AS treatments
                FROM iso_risks r
                WHERE r.organization_id = $1
            `, [orgId]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'The risk register is not provisioned yet — open Compliance → Risks once to create it.',
                };
            }
            throw e;
        }

        const now = Date.now();
        const byStatus = {};
        const overdue = [];
        const untreatedHigh = [];
        let withoutOwner = 0;
        for (const r of risks) {
            byStatus[r.status] = (byStatus[r.status] || 0) + 1;
            if (r.status !== 'closed') {
                const due = r.review_due_at ? new Date(r.review_due_at).getTime() : NaN;
                if (Number.isFinite(due) && due < now) overdue.push(r.id);
                if (!r.has_owner) withoutOwner++;
            }
            if (OPEN_STATUSES.has(r.status) && Number(r.score) >= HIGH_SCORE && Number(r.treatments) === 0) {
                untreatedHigh.push(r.id);
            }
        }

        const evidence = {
            risks_total: risks.length,
            by_status: byStatus,
            high_threshold: HIGH_SCORE,
            untreated_high_count: untreatedHigh.length,
            untreated_high: untreatedHigh.slice(0, 10),
            overdue_review_count: overdue.length,
            overdue_review: overdue.slice(0, 10),
            without_owner: withoutOwner,
        };

        if (risks.length === 0) {
            return {
                status: 'fail',
                evidence,
                details: 'The risk register is empty — no risk analysis exists to base the Art. 21 measures on.',
            };
        }
        const warnings = [];
        if (untreatedHigh.length) {
            warnings.push(`${untreatedHigh.length} open risk(s) scored ${HIGH_SCORE} or higher have no treatment recorded.`);
        }
        if (overdue.length) {
            warnings.push(`${overdue.length} risk(s) are past their review date.`);
        }
        if (warnings.length) {
            return { status: 'warn', evidence, details: warnings.join(' ') };
        }
        return {
            status: 'pass',
            evidence,
            details: `Risk register maintained: ${risks.length} risk(s), every high risk has a treatment and no review is overdue.`,
        };
    },
};
