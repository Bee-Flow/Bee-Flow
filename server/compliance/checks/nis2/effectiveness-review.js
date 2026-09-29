/**
 * NIS2 Art. 21(2)(f) — policies and procedures to assess the effectiveness of
 * the cybersecurity risk-management measures.
 *
 * Two signals, both from the ISO 27001 process registers:
 *   REVIEW — an internal audit closed (iso_audits.closed_at) OR a management
 *            review held (iso_management_reviews.held_at) within the last
 *            365 days. 365–540 days → warn; older or never → fail.
 *   SWEEP  — the continuous check sweeps keep running: the newest
 *            compliance_score_history snapshot is at most 7 days old.
 *
 * ISO 27001 clauses 9.2 (internal audit) and 9.3 (management review).
 */

const { getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const DAY = 86400 * 1000;
const REVIEW_OK_DAYS = 365;
const REVIEW_GRACE_DAYS = 540;
const SWEEP_FRESH_DAYS = 7;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

/** MAX(column) for one org-scoped table; null when empty or the table is missing. */
async function _latest(sql, orgId) {
    try {
        const row = await getOne(sql, [orgId]);
        const v = row && row.last;
        if (!v) return { at: null, provisioned: true };
        const t = new Date(v).getTime();
        return { at: Number.isFinite(t) ? new Date(t).toISOString() : null, provisioned: true };
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return { at: null, provisioned: false };
        throw e;
    }
}

function _ageDays(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

module.exports = {
    id: 'NIS2-Art21(2)(f)-effectiveness-review',
    regulation: 'NIS2',
    article: 'Art. 21(2)(f)',
    frameworks: [
        { regulation: 'ISO27001', ref: 'cl. 9.2' },
        { regulation: 'ISO27001', ref: 'cl. 9.3' },
    ],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_nis2_effectiveness_review_title',
    descriptionKey: 'compliance.check_nis2_effectiveness_review_desc',
    remediationKey: 'compliance.check_nis2_effectiveness_review_fix',
    remediationLink: 'admin/compliance/audits',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const audit = await _latest(
            `SELECT MAX(closed_at) AS last FROM iso_audits WHERE organization_id = $1 AND status = 'closed'`, orgId);
        const review = await _latest(
            `SELECT MAX(held_at) AS last FROM iso_management_reviews WHERE organization_id = $1`, orgId);
        const sweep = await _latest(
            `SELECT MAX(captured_at) AS last FROM compliance_score_history WHERE organization_id = $1`, orgId);

        if (!audit.provisioned && !review.provisioned) {
            return {
                status: 'warn',
                evidence: { provisioned: false },
                details: 'The audit and management-review registers are not provisioned yet — open Compliance → Audits once to create them.',
            };
        }

        const candidates = [audit.at, review.at].filter(Boolean).map(x => new Date(x).getTime());
        const lastReviewAt = candidates.length ? new Date(Math.max(...candidates)).toISOString() : null;
        const reviewAge = _ageDays(lastReviewAt);
        const sweepAge = _ageDays(sweep.at);
        const sweepFresh = sweepAge !== null && sweepAge <= SWEEP_FRESH_DAYS;

        const evidence = {
            last_audit_at: audit.at,
            last_review_at: review.at,
            last_effectiveness_review_at: lastReviewAt,
            review_age_days: reviewAge,
            last_sweep_at: sweep.at,
            sweep_age_days: sweepAge,
            sweep_fresh: sweepFresh,
            thresholds: { review_ok_days: REVIEW_OK_DAYS, review_grace_days: REVIEW_GRACE_DAYS, sweep_fresh_days: SWEEP_FRESH_DAYS },
        };

        if (lastReviewAt === null) {
            return {
                status: 'fail',
                evidence,
                details: 'No internal audit has been closed and no management review has been held — the effectiveness of the measures has never been assessed.',
            };
        }
        if (reviewAge > REVIEW_GRACE_DAYS) {
            return {
                status: 'fail',
                evidence,
                details: `The last effectiveness review is ${reviewAge} days old — more than ${REVIEW_GRACE_DAYS} days without an audit or management review.`,
            };
        }
        if (reviewAge > REVIEW_OK_DAYS) {
            return {
                status: 'warn',
                evidence,
                details: `The last audit or management review was ${reviewAge} days ago — the annual cycle has slipped. Plan the next one.`,
            };
        }
        if (!sweepFresh) {
            return {
                status: 'warn',
                evidence,
                details: sweep.at
                    ? `Reviewed ${reviewAge} days ago, but the continuous check sweeps are stale (last snapshot ${sweepAge} days ago). Run the checks or restore the scheduler.`
                    : `Reviewed ${reviewAge} days ago, but no check sweep has ever been recorded — run the compliance checks once.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Effectiveness assessed ${reviewAge} day(s) ago (audit/management review) and the check sweeps are current (${sweepAge} day(s) old).`,
        };
    },
};
