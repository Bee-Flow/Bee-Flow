/**
 * ISO 27001 A.5.31 — legal, statutory, regulatory and contractual
 * requirements: is the legal register this hub scores against still current?
 *
 * Every framework the Compliance Center scores rests on an entry in
 * compliance/frameworks.js: its in-force dates, phases and milestones, the
 * official text it was checked against (`sources`) and the day of that check
 * (`legal_status_verified`). Law moves; an entry nobody re-read tells an
 * organisation it complies with rules that have since changed, and a green
 * score on top of it is worse than no score. So this check reports the age of
 * that verification for every framework the organisation has switched on:
 *
 *   every active entry checked within LEGAL_REVIEW_STALE_DAYS (90)  → pass
 *   any active entry older than that, or never recorded              → warn
 *   any active entry older than a year                               → fail
 *
 * It reads only the product's own catalogue and the organisation's framework
 * switches: no personal data, nothing about the organisation's content.
 */

const frameworks = require('../../frameworks');
const frameworkPolicy = require('../../frameworkPolicy');

const FAIL_AFTER_DAYS = 365;

async function _activeFrameworks(orgId) {
    try {
        const regs = await frameworkPolicy.activeRegulations(orgId || 'default');
        const list = [...regs].map(code => frameworks.byRegulation(code)).filter(Boolean);
        if (list.length) return { list, scope: 'active' };
    } catch { /* the policy could not be read: judge the whole catalogue */ }
    return { list: frameworks.listBuiltin(), scope: 'catalogue' };
}

module.exports = {
    id: 'ISO27001-A.5.31-legal-register',
    regulation: 'ISO27001',
    article: 'A.5.31',
    controls: ['A.5.31'],
    severity: 'medium',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.checks.iso_legal_register.title',
    descriptionKey: 'compliance.checks.iso_legal_register.desc',
    remediationKey: 'compliance.checks.iso_legal_register.fix',
    remediationLink: 'admin/compliance/frameworks',
    async evaluate(orgId, _subject, { now = Date.now() } = {}) {
        const { list, scope } = await _activeFrameworks(orgId);
        const rows = list.map(fw => ({ id: fw.id, ...frameworks.legalReview(fw, now) }));
        const stale = rows.filter(r => r.stale);
        const expired = rows.filter(r => r.age_days === null || r.age_days > FAIL_AFTER_DAYS);
        const review = frameworks.catalogueReview(now, list);
        const names = (rs) => rs.map(r => frameworks.byId(r.id)?.regulation || r.id).join(', ');
        const evidence = {
            scope,
            stale_after_days: frameworks.LEGAL_REVIEW_STALE_DAYS,
            fail_after_days: FAIL_AFTER_DAYS,
            oldest_verified_on: review.verified_on,
            frameworks: rows.map(({ id, verified_on, age_days, stale: isStale, sources }) => ({ id, verified_on, age_days, stale: isStale, sources })),
            stale_ids: stale.map(r => r.id),
        };
        if (expired.length) {
            return {
                status: 'fail',
                evidence,
                details: `The legal status of ${names(expired)} has not been checked for more than a year. Update Bee Flow, and do not rely on these dates until it has been re-checked against the official sources.`,
            };
        }
        if (stale.length) {
            return {
                status: 'warn',
                evidence,
                details: `The legal status of ${names(stale)} was last checked more than ${frameworks.LEGAL_REVIEW_STALE_DAYS} days ago (oldest: ${review.verified_on || 'never'}). Update Bee Flow, or check the listed sources before relying on the dates.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `The legal status of all ${rows.length} active framework(s) was checked within the last ${frameworks.LEGAL_REVIEW_STALE_DAYS} days (oldest: ${review.verified_on}).`,
        };
    },
};
